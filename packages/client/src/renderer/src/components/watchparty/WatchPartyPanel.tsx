import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { Message, MessagePayload, ServerFrame } from '@chatward/shared';
import { api } from '../../api/http';
import { onFrame } from '../../api/ws';
import { decryptMessage, encryptPayload, onKeysChanged } from '../../crypto';
import { useSession } from '../../state/session';
import { decodeState, DRIFT_SECONDS, encodeState, mediaKey, parseVideoUrl, playhead, SEEK_SECONDS, type StampedState, type WatchState } from './sync';
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

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

/**
 * `callChannelId` is the voice channel whose call is watching: the server keeps the snapshot per call and only lets people
 * in that call change it. Voice channels have no message key of their own, so the state is encrypted with the key of
 * `keyChannelId`, the call's server's first text channel, the same channel the call's media key comes from.
 */
export function WatchPartyPanel({ callChannelId: channelId, keyChannelId }: { callChannelId: string; keyChannelId: string }): ReactElement {
  const me = useSession((s) => s.user?.id ?? null);
  const [remote, setRemote] = useState<StampedState | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** true while the embed lives in the pop-out window instead of the panel */
  const [popped, setPopped] = useState(false);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameWrapRef = useRef<HTMLDivElement>(null);
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
    if (!prev || !mediaKey(cur) || now < suppressUntil.current) return;

    const seeked = Math.abs(e.currentTime - playhead(prev, now)) > SEEK_SECONDS;
    if (seeked || e.playing !== prev.playing || e.rate !== prev.rate) {
      void publish({ videoId: cur!.videoId, url: cur!.url, playing: e.playing, position: e.currentTime, rate: e.rate });
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
  const active = mediaKey(remote);

  // Re-bind whenever the embed is (re)mounted: a new video, or it moving between the panel and the pop-out window.
  useEffect(() => {
    readyRef.current = false;
    local.current = null;
    if (fileUrl) return bindVideo();
    if (!videoId) return;
    if (popped) {
      postToPopout({ kind: 'load', videoId });
      return;
    }
    const frame = frameRef.current;
    if (!frame) return;
    return bindPlayer(frame, (e) => onPlayerEvent.current(e));
  }, [videoId, fileUrl, channelId, popped]);

  /** Reports a <video> element's state like the YouTube embed does, so the rest of the sync logic is shared. */
  const bindVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    const info = () =>
      onPlayerEvent.current({ kind: 'info', currentTime: video.currentTime, playing: !video.paused && !video.ended, rate: video.playbackRate });
    const ready = () => onPlayerEvent.current({ kind: 'ready' });
    const events = ['play', 'pause', 'seeked', 'ratechange'] as const;
    events.forEach((n) => video.addEventListener(n, info));
    video.addEventListener('loadedmetadata', ready);
    if (video.readyState >= 1) ready();
    return () => {
      events.forEach((n) => video.removeEventListener(n, info));
      video.removeEventListener('loadedmetadata', ready);
    };
  };

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
    void publish(link ? { videoId: link.videoId, playing: true, position: link.start, rate } : { videoId: null, url: file, playing: true, position: 0, rate });
  };

  const togglePlay = () => {
    const s = remoteRef.current;
    if (!mediaKey(s) || !s) return;
    const position = local.current ? playhead(local.current, performance.now()) : s.position;
    void publish({ videoId: s.videoId, url: s.url, playing: !s.playing, position, rate: s.rate });
  };

  /** Brings the embed back into the panel and closes the pop-out. Closing the pop-out window itself lands here too. */
  const dock = () => {
    popupRef.current?.close();
    popupRef.current = null;
    setPopped(false);
  };

  const popOut = () => {
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus();
      return;
    }
    const win = window.open(popoutUrl(), 'chatward-watch-popout', 'width=960,height=540,resizable=yes');
    if (!win) {
      setError('The pop-out window was blocked.');
      return;
    }
    popupRef.current = win;
    setPopped(true);
  };

  const fullscreen = () => void frameWrapRef.current?.requestFullscreen();

  const stop = () => {
    // Clear our own view first, so nothing the old embed reports while the stop is in flight gets published.
    stopping.current = true;
    local.current = null;
    readyRef.current = false;
    void publish({ videoId: null, url: null, playing: false, position: 0, rate: 1 });
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
    if ((!videoId || fileUrl) && popupRef.current) dock();
  }, [videoId, fileUrl]);

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
            {!fileUrl && !popped && <button type="button" onClick={popOut}>Pop out</button>}
            <button type="button" className="watch-party-stop" onClick={stop}>Stop</button>
          </span>
        )}
      </header>

      {active ? (
        <>
          {popped && !fileUrl ? (
            <div className="watch-party-popped">
              <p>Playing in a separate window. Closing that window brings the player back here.</p>
              <button type="button" onClick={dock}>Bring back</button>
            </div>
          ) : (
            <div className="watch-party-frame" ref={frameWrapRef}>
              {fileUrl ? (
                <video key={fileUrl} ref={videoRef} src={fileUrl} controls playsInline preload="metadata" />
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
            <button type="button" onClick={togglePlay}>{remote?.playing ? 'Pause' : 'Play'}</button>
            {!popped && <button type="button" onClick={fullscreen}>Fullscreen</button>}
            <span className="watch-party-hint">Play, pause, seeks and speed sync for everyone.</span>
          </div>
        </>
      ) : (
        <p className="watch-party-empty">Paste a YouTube link or an https video file (mp4/webm) link to watch together in sync.</p>
      )}

      <form className="watch-party-form" onSubmit={submit}>
        <input
          type="url"
          aria-label="YouTube or video file link"
          placeholder="https://www.youtube.com/watch?v=…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>{active ? 'Change video' : 'Start'}</button>
      </form>
      {error && <p role="alert" className="watch-party-error">{error}</p>}
    </section>
  );
}
