import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { Message, MessagePayload, ServerFrame } from '@chatward/shared';
import { api } from '../../api/http';
import { onFrame } from '../../api/ws';
import { decryptMessage, encryptPayload, onKeysChanged } from '../../crypto';
import { useSession } from '../../state/session';
import { decodeState, DRIFT_SECONDS, encodeState, mediaKey, parseVideoUrl, playhead, QUEUE_MAX, SEEK_SECONDS, stateForItem, type QueueItem, type StampedState, type WatchState } from './sync';
import { registerQueueHandler } from './bridge';
import { attachJellyfin, startJellyfinPlayback } from '../jellyfin/JellyfinBrowser';
import { bindPlayer, embedSrc, parseYouTubeUrl, sendCommand, type PlayerEvent } from './youtube';
import { popoutUrl, type PanelToPopout, type PopoutToPanel } from './popout';
import './watchparty.css';

/** Wire shape of the latest snapshot (GET response and watch.sync frame). */
interface Snapshot {
  ciphertext: string;
  keyVersion: number;
  authorId: string;
  ts: number;
}

/** Our own view of the embed. `at` is performance.now() so it never depends on the wall clock. */
interface LocalPlayhead {
  position: number;
  at: number;
  playing: boolean;
  rate: number;
}

/** Ignore player events for this long after we apply a remote change, so our own commands do not echo back as user actions. */
const SUPPRESS_MS = 2000;

async function openSnapshot(channelId: string, snap: Snapshot): Promise<StampedState | null> {
  const msg: Message = {
    id: `watch-${snap.ts}`,
    channelId,
    authorId: snap.authorId,
    createdAt: snap.ts,
    editedAt: null,
    keyVersion: snap.keyVersion,
    ciphertext: snap.ciphertext,
  };
  const payload: MessagePayload | null = await decryptMessage(msg);
  const state = payload && decodeState(payload);
  return state ? { ...state, ts: snap.ts } : null;
}

/** Where the shared playhead is now, projected from the server timestamp of the last change. */
const remotePlayhead = (s: StampedState, serverNow: number) =>
  playhead({ position: s.position, at: s.ts, playing: s.playing, rate: s.rate }, serverNow);

/** Keeps what is playing and the queue when only the playhead changes. */
const carry = (s: WatchState) => ({ videoId: s.videoId, url: s.url, jellyfinId: s.jellyfinId, title: s.title, queue: s.queue, n: s.n });

const itemLabel = (it: QueueItem) => it.title ?? (it.kind === 'youtube' ? `YouTube ${it.ref}` : it.kind === 'url' ? new URL(it.ref).pathname.split('/').pop() || it.ref : 'Jellyfin item');

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

/**
 * `callChannelId` is the voice channel whose call is watching: the server keeps the snapshot per call and only lets people
 * in that call change it. Voice channels have no message key of their own, so the state is encrypted with the key of
 * `keyChannelId`, the call's server's first text channel, the same channel the call's media key comes from.
 */
export function WatchPartyPanel({ callChannelId: channelId, keyChannelId, onActiveChange }: { callChannelId: string; keyChannelId: string; onActiveChange?: (active: boolean) => void }): ReactElement {
  const me = useSession((s) => s.user?.id ?? null);
  const [remote, setRemote] = useState<StampedState | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** true while the embed lives in the pop-out window instead of the panel */
  const [popped, setPopped] = useState(false);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const popupRef = useRef<Window | null>(null);
  const readyRef = useRef(false);
  const remoteRef = useRef<StampedState | null>(null);
  const local = useRef<LocalPlayhead | null>(null);
  const suppressUntil = useRef(0);
  /** server clock minus local clock, measured on the initial GET */
  const clockOffset = useRef(0);
  /** ts of our last accepted publish, so its echo off the socket is skipped */
  const lastSentTs = useRef<number | null>(null);
  /** set by Stop until the publish settles, so the old embed cannot publish over the stop */
  const stopping = useRef(false);
  /** true when the last snapshot we were sent could not be decrypted yet, so new keys should retry it */
  const undecrypted = useRef(false);

  const serverNow = () => Date.now() + clockOffset.current;

  const accept = (s: StampedState) => {
    // Decrypts finish out of order, so an older state must not overwrite a newer one.
    if (remoteRef.current && s.ts < remoteRef.current.ts) return;
    remoteRef.current = s;
    setRemote(s);
  };

  const postToPopout = (msg: PanelToPopout) => popupRef.current?.postMessage(msg, '*');

  /** Drives the embed wherever it is: the panel's iframe, or the pop-out window's. */
  const command = (func: string, args: unknown[] = []) => {
    const video = videoRef.current;
    if (video) {
      if (func === 'seekTo') video.currentTime = args[0] as number;
      else if (func === 'playVideo') void video.play().catch(() => {});
      else if (func === 'pauseVideo') video.pause();
      else if (func === 'setPlaybackRate') video.playbackRate = args[0] as number;
    } else if (popupRef.current) postToPopout({ kind: 'command', func, args });
    else sendCommand(frameRef.current, func, args);
  };

  const seekTo = (position: number) => {
    const now = performance.now();
    command('seekTo', [position, true]);
    suppressUntil.current = now + SUPPRESS_MS;
    local.current = { position, at: now, playing: local.current?.playing ?? false, rate: local.current?.rate ?? 1 };
  };

  const applyRemote = (s: StampedState | null) => {
    if (!s || !mediaKey(s) || !readyRef.current) return;
    const now = performance.now();
    const target = remotePlayhead(s, serverNow());
    const current = local.current ? playhead(local.current, now) : target;
    suppressUntil.current = now + SUPPRESS_MS;
    if (Math.abs(current - target) > DRIFT_SECONDS) command('seekTo', [target, true]);
    command(s.playing ? 'playVideo' : 'pauseVideo');
    command('setPlaybackRate', [s.rate]);
    local.current = { position: target, at: now, playing: s.playing, rate: s.rate };
  };

  const publish = async (next: WatchState) => {
    if (!me) return;
    setError(null);
    try {
      const { ciphertext, keyVersion } = await encryptPayload(keyChannelId, me, encodeState(next));
      const res = await api.post<{ ts: number }>(`/api/channels/${channelId}/watch`, { ciphertext, keyVersion });
      lastSentTs.current = res.ts;
      accept({ ...next, ts: res.ts });
      stopping.current = false;
    } catch (e) {
      stopping.current = false;
      setError(errorText(e));
    }
  };

  // Our own clicks and seeks inside the embed come back as info events. Anything the user did is published.
  const onPlayerEvent = useRef<(e: PlayerEvent) => void>(() => {});
  onPlayerEvent.current = (e) => {
    if (stopping.current) return;
    if (e.kind === 'ready') {
      readyRef.current = true;
      applyRemote(remoteRef.current);
      return;
    }
    const now = performance.now();
    const prev = local.current;
    local.current = { position: e.currentTime, at: now, playing: e.playing, rate: e.rate };
    const cur = remoteRef.current;
    if (!prev || !mediaKey(cur)) return;
    // Our own commands echo back as events for a moment after each sync. A file or Jellyfin play or pause that
    // disagrees with the shared state is the viewer's own click, so it still goes out even inside that window.
    const ownClick = e.playing !== cur!.playing && Boolean(cur!.url || cur!.jellyfinId);
    if (now < suppressUntil.current && !ownClick) return;

    const seeked = Math.abs(e.currentTime - playhead(prev, now)) > SEEK_SECONDS;
    if (seeked || ownClick || e.playing !== prev.playing || e.rate !== prev.rate) {
      void publish({ ...carry(cur!), playing: e.playing, position: e.currentTime, rate: e.rate });
    }
  };

  // Late joiners get the latest snapshot once; everyone after that follows the socket.
  useEffect(() => {
    let cancelled = false;
    remoteRef.current = null;
    lastSentTs.current = null;
    undecrypted.current = false;
    setRemote(null);
    // Fetches the latest snapshot. Runs on mount, on every socket reconnect (frames may have been missed), and when keys arrive after a failed decrypt.
    const load = async () => {
      try {
        const before = Date.now();
        const res = await api.get<{ state: Snapshot | null; serverNow: number }>(`/api/channels/${channelId}/watch`);
        if (cancelled) return;
        clockOffset.current = res.serverNow - (before + Date.now()) / 2;
        if (res.state) {
          const s = await openSnapshot(keyChannelId, res.state);
          if (cancelled) return;
          undecrypted.current = !s;
          if (s) accept(s);
        }
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      }
    };
    void load();
    const unsubscribe = onFrame((f: ServerFrame) => {
      if (f.t === 'ready') {
        void load();
        return;
      }
      if (f.t !== 'watch.sync' || f.channelId !== channelId || f.ts === lastSentTs.current) return;
      void openSnapshot(keyChannelId, f).then((s) => {
        if (cancelled) return;
        undecrypted.current = !s;
        if (s) accept(s);
      });
    });
    // Keys can arrive after the snapshot, so a snapshot that could not be opened gets another try.
    const unsubscribeKeys = onKeysChanged(() => {
      if (undecrypted.current) void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeKeys();
    };
  }, [channelId, keyChannelId]);

  const videoId = remote?.videoId ?? null;
  const fileUrl = remote?.url ?? null;
  const jellyfinId = remote?.jellyfinId ?? null;
  const queue = remote?.queue ?? [];
  /** files and Jellyfin both play in a <video>; only YouTube uses the iframe */
  const useVideo = Boolean(fileUrl || jellyfinId);
  const active = mediaKey(remote);
  // Tells the tabs layout whether something is playing, so it can keep a corner preview while the tab is left.
  useEffect(() => { onActiveChange?.(Boolean(active)); }, [active]);
  useEffect(() => () => onActiveChange?.(false), []);

  // Re-bind whenever the embed is (re)mounted: a new video, or it moving between the panel and the pop-out window.
  useEffect(() => {
    readyRef.current = false;
    local.current = null;
    if (useVideo) return bindVideo();
    if (!videoId) return;
    if (popped) {
      postToPopout({ kind: 'load', videoId });
      return;
    }
    const frame = frameRef.current;
    if (!frame) return;
    return bindPlayer(frame, (e) => onPlayerEvent.current(e));
  }, [videoId, fileUrl, jellyfinId, channelId, popped]);

  /** Reports a <video> element's state like the YouTube embed does, so the rest of the sync logic is shared. */
  const bindVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    const info = () =>
      onPlayerEvent.current({ kind: 'info', currentTime: video.currentTime, playing: !video.paused && !video.ended, rate: video.playbackRate });
    const ready = () => onPlayerEvent.current({ kind: 'ready' });
    const events = ['play', 'pause', 'seeked', 'ratechange'] as const;
    events.forEach((n) => video.addEventListener(n, info));
    video.addEventListener('ended', onEnded);
    video.addEventListener('loadedmetadata', ready);
    if (video.readyState >= 1) ready();
    return () => {
      events.forEach((n) => video.removeEventListener(n, info));
      video.removeEventListener('loadedmetadata', ready);
      video.removeEventListener('ended', onEnded);
    };
  };

  /** Everyone's video ends at about the same time. A random delay plus the play counter keeps the queue from advancing once per person. */
  const onEnded = () => {
    const cur = remoteRef.current;
    if (!cur || !(cur.queue?.length)) return;
    const n = cur.n ?? 0;
    setTimeout(() => {
      const now = remoteRef.current;
      if (!now || (now.n ?? 0) !== n || !now.queue?.length) return;
      const [next, ...rest] = now.queue;
      void publish(stateForItem(next, rest, n + 1, now.rate));
    }, Math.random() * 1500);
  };

  // Jellyfin: every viewer gets their own ticket and plays the HLS stream through the Chatward server.
  useEffect(() => {
    if (!jellyfinId) return;
    let live = true;
    let detach = () => {};
    startJellyfinPlayback(jellyfinId)
      .then((p) => { if (live && videoRef.current) detach = attachJellyfin(videoRef.current, p, setError); })
      .catch((e: unknown) => { if (live) setError(errorText(e)); });
    return () => { live = false; detach(); };
  }, [jellyfinId]);

  // A remote change, or our own publish echoed back into state, is applied here.
  useEffect(() => {
    applyRemote(remote);
  }, [remote]);

  // Drift correction: seek only when the projected playhead is off by more than the tolerance.
  useEffect(() => {
    const timer = setInterval(() => {
      const s = remoteRef.current;
      const l = local.current;
      if (!s || !mediaKey(s) || !s.playing || !readyRef.current || !l) return;
      const now = performance.now();
      if (now < suppressUntil.current) return;
      const expected = remotePlayhead(s, serverNow());
      if (Math.abs(playhead(l, now) - expected) > DRIFT_SECONDS) seekTo(expected);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const rate = remoteRef.current?.rate ?? 1;
    const link = parseYouTubeUrl(draft);
    const file = link ? null : parseVideoUrl(draft);
    if (!link && !file) {
      setError("That doesn't look like a YouTube link or an https video file link.");
      return;
    }
    setDraft('');
    const item: QueueItem = link ? { kind: 'youtube', ref: link.videoId } : { kind: 'url', ref: file! };
    // With nothing playing, the first link starts. Otherwise "Change video" replaces, keeping the queue.
    void publish({ ...stateForItem(item, remoteRef.current?.queue ?? [], (remoteRef.current?.n ?? 0) + 1, rate, link?.start ?? 0) });
  };

  const addToQueue = (item: QueueItem) => {
    const cur = remoteRef.current;
    if (!mediaKey(cur) || !cur) {
      void publish(stateForItem(item, [], (cur?.n ?? 0) + 1));
      return;
    }
    if ((cur.queue?.length ?? 0) >= QUEUE_MAX) { setError('The queue is full.'); return; }
    const position = local.current ? playhead(local.current, performance.now()) : cur.position;
    void publish({ ...carry(cur), queue: [...(cur.queue ?? []), item], playing: cur.playing, position, rate: cur.rate });
  };
  const addRef = useRef(addToQueue);
  addRef.current = addToQueue;
  useEffect(() => registerQueueHandler((item) => addRef.current(item)), []);

  const addDraft = () => {
    const link = parseYouTubeUrl(draft);
    const file = link ? null : parseVideoUrl(draft);
    if (!link && !file) { setError("That doesn't look like a YouTube link or an https video file link."); return; }
    setDraft('');
    addToQueue(link ? { kind: 'youtube', ref: link.videoId } : { kind: 'url', ref: file! });
  };

  const removeQueued = (i: number) => {
    const cur = remoteRef.current;
    if (!cur?.queue) return;
    const position = local.current ? playhead(local.current, performance.now()) : cur.position;
    void publish({ ...carry(cur), queue: cur.queue.filter((_, j) => j !== i), playing: cur.playing, position, rate: cur.rate });
  };

  const skip = () => {
    const cur = remoteRef.current;
    if (!cur) return;
    const [next, ...rest] = cur.queue ?? [];
    if (next) void publish(stateForItem(next, rest, (cur.n ?? 0) + 1, cur.rate));
    else stop();
  };

  /** Brings the embed back into the panel and closes the pop-out. Closing the pop-out window itself lands here too. */
  const dock = () => {
    popupRef.current?.close();
    popupRef.current = null;
    setPopped(false);
  };

  /** Opens the embed in a separate window. Picture in picture is the same window, small and always on top (see main/index.ts). */
  const popOut = (pip = false) => {
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus();
      return;
    }
    const win = pip
      ? window.open(popoutUrl(), 'chatward-watch-pip', 'width=480,height=300,resizable=yes')
      : window.open(popoutUrl(), 'chatward-watch-popout', 'width=960,height=540,resizable=yes');
    if (!win) {
      setError('The pop-out window was blocked.');
      return;
    }
    popupRef.current = win;
    setPopped(true);
  };

  const stop = () => {
    // Clear our own view first, so nothing the old embed reports while the stop is in flight gets published.
    stopping.current = true;
    local.current = null;
    readyRef.current = false;
    void publish({ videoId: null, url: null, jellyfinId: null, title: null, queue: [], n: remoteRef.current?.n ?? 0, playing: false, position: 0, rate: 1 });
  };

  // Messages from the pop-out: it says hello on load, relays player events, and says closed when it goes away.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!popupRef.current || e.source !== popupRef.current) return;
      const msg = e.data as PopoutToPanel | null;
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'hello') {
        const id = remoteRef.current?.videoId;
        if (id) postToPopout({ kind: 'load', videoId: id });
      } else if (msg.kind === 'event') {
        onPlayerEvent.current(msg.event);
      } else if (msg.kind === 'closed') {
        dock();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Closing the pop-out with its own window controls may not send a message, so poll for it.
  useEffect(() => {
    if (!popped) return;
    const timer = setInterval(() => {
      if (popupRef.current?.closed) dock();
    }, 500);
    return () => clearInterval(timer);
  }, [popped]);

  // The party ending, from Stop here or from another member, closes the pop-out too.
  useEffect(() => {
    if ((!videoId || useVideo) && popupRef.current) dock();
  }, [videoId, useVideo]);

  // Leaving the panel, or the app closing, takes the pop-out with it.
  useEffect(() => {
    const closePopup = () => popupRef.current?.close();
    window.addEventListener('pagehide', closePopup);
    return () => {
      window.removeEventListener('pagehide', closePopup);
      closePopup();
    };
  }, []);

  return (
    <section className="watch-party" aria-label="Watch party">
      <header className="watch-party-head">
        <span>Watch party</span>
        {active && (
          <span className="watch-party-head-actions">
            {!useVideo && !popped && <button type="button" onClick={() => popOut(true)}>Picture in picture</button>}
            <button type="button" className="watch-party-stop" onClick={stop}>Stop</button>
          </span>
        )}
      </header>

      {active ? (
        <>
          {popped && !useVideo ? (
            <div className="watch-party-popped">
              <p>Playing in a separate window. Closing that window brings the player back here.</p>
              <button type="button" onClick={dock}>Bring back</button>
            </div>
          ) : (
            <div className="watch-party-frame">
              {useVideo ? (
                <video key={fileUrl ?? jellyfinId} ref={videoRef} src={fileUrl ?? undefined} controls playsInline preload="metadata" />
              ) : (
              <iframe
                key={videoId ?? ""}
                ref={frameRef}
                src={embedSrc(videoId ?? "")}
                title="Watch party video"
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
              />
              )}
            </div>
          )}
          <div className="watch-party-bar">
            <button type="button" onClick={skip}>{queue.length ? 'Skip' : 'End'}</button>
            <span className="watch-party-hint">Play, pause and seeks in the player sync for everyone.</span>
          </div>
        </>
      ) : (
        <p className="watch-party-empty">Paste a YouTube link or an https video file (mp4/webm) link, or add a movie from 🍿 Movies, to watch together in sync.</p>
      )}

      {active && remote?.title && <p className="watch-party-now">Now playing: {remote.title}</p>}
      {queue.length > 0 && (
        <ol className="watch-party-queue" aria-label="Up next">
          {queue.map((it, i) => (
            <li key={`${i}-${it.ref}`}>
              <span>{itemLabel(it)}</span>
              <button type="button" aria-label={`Remove ${itemLabel(it)} from the queue`} onClick={() => removeQueued(i)}>Remove</button>
            </li>
          ))}
        </ol>
      )}

      <form className="watch-party-form" onSubmit={submit}>
        <input
          type="url"
          aria-label="YouTube or video file link"
          placeholder="https://www.youtube.com/watch?v=…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>{active ? 'Play now' : 'Start'}</button>
        {active && <button type="button" disabled={!draft.trim()} onClick={addDraft}>Add to queue</button>}
      </form>
      {error && <p role="alert" className="watch-party-error">{error}</p>}
    </section>
  );
}
