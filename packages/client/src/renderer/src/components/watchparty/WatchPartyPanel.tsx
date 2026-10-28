import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { Message, MessagePayload, ServerFrame } from '@chatward/shared';
import { api } from '../../api/http';
import { onFrame } from '../../api/ws';
import { decryptMessage, encryptPayload } from '../../crypto';
import { useSession } from '../../state/session';
import { decodeState, DRIFT_SECONDS, encodeState, playhead, SEEK_SECONDS, type StampedState, type WatchState } from './sync';
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

export function WatchPartyPanel({ channelId }: { channelId: string }): ReactElement {
  const me = useSession((s) => s.user?.id ?? null);
  const [remote, setRemote] = useState<StampedState | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** true while the embed lives in the pop-out window instead of the panel */
  const [popped, setPopped] = useState(false);

  const frameRef = useRef<HTMLIFrameElement>(null);
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
    if (popupRef.current) postToPopout({ kind: 'command', func, args });
    else sendCommand(frameRef.current, func, args);
  };

  const seekTo = (position: number) => {
    const now = performance.now();
    command('seekTo', [position, true]);
    suppressUntil.current = now + SUPPRESS_MS;
    local.current = { position, at: now, playing: local.current?.playing ?? false, rate: local.current?.rate ?? 1 };
  };

  const applyRemote = (s: StampedState | null) => {
    if (!s?.videoId || !readyRef.current) return;
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
      const { ciphertext, keyVersion } = await encryptPayload(channelId, me, encodeState(next));
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
    const videoId = remoteRef.current?.videoId;
    if (!prev || !videoId || now < suppressUntil.current) return;

    const seeked = Math.abs(e.currentTime - playhead(prev, now)) > SEEK_SECONDS;
    if (seeked || e.playing !== prev.playing || e.rate !== prev.rate) {
      void publish({ videoId, playing: e.playing, position: e.currentTime, rate: e.rate });
    }
  };

  // Late joiners get the latest snapshot once; everyone after that follows the socket.
  useEffect(() => {
    let cancelled = false;
    remoteRef.current = null;
    lastSentTs.current = null;
    setRemote(null);
    (async () => {
      try {
        const before = Date.now();
        const res = await api.get<{ state: Snapshot | null; serverNow: number }>(`/api/channels/${channelId}/watch`);
        if (cancelled) return;
        clockOffset.current = res.serverNow - (before + Date.now()) / 2;
        if (res.state) {
          const s = await openSnapshot(channelId, res.state);
          if (!cancelled && s) accept(s);
        }
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      }
    })();
    const unsubscribe = onFrame((f: ServerFrame) => {
      if (f.t !== 'watch.sync' || f.channelId !== channelId || f.ts === lastSentTs.current) return;
      void openSnapshot(channelId, f).then((s) => {
        if (!cancelled && s) accept(s);
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [channelId]);

  const videoId = remote?.videoId ?? null;

  // Re-bind whenever the embed is (re)mounted: a new video, or it moving between the panel and the pop-out window.
  useEffect(() => {
    readyRef.current = false;
    local.current = null;
    if (!videoId) return;
    if (popped) {
      postToPopout({ kind: 'load', videoId });
      return;
    }
    const frame = frameRef.current;
    if (!frame) return;
    return bindPlayer(frame, (e) => onPlayerEvent.current(e));
  }, [videoId, channelId, popped]);

  // A remote change, or our own publish echoed back into state, is applied here.
  useEffect(() => {
    applyRemote(remote);
  }, [remote]);

  // Drift correction: seek only when the projected playhead is off by more than the tolerance.
  useEffect(() => {
    const timer = setInterval(() => {
      const s = remoteRef.current;
      const l = local.current;
      if (!s?.videoId || !s.playing || !readyRef.current || !l) return;
      const now = performance.now();
      if (now < suppressUntil.current) return;
      const expected = remotePlayhead(s, serverNow());
      if (Math.abs(playhead(l, now) - expected) > DRIFT_SECONDS) seekTo(expected);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const link = parseYouTubeUrl(draft);
    if (!link) {
      setError("That doesn't look like a YouTube link.");
      return;
    }
    setDraft('');
    void publish({ videoId: link.videoId, playing: true, position: link.start, rate: remoteRef.current?.rate ?? 1 });
  };

  const togglePlay = () => {
    const s = remoteRef.current;
    if (!s?.videoId) return;
    const position = local.current ? playhead(local.current, performance.now()) : s.position;
    void publish({ videoId: s.videoId, playing: !s.playing, position, rate: s.rate });
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
    void publish({ videoId: null, playing: false, position: 0, rate: 1 });
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
    if (!videoId && popupRef.current) dock();
  }, [videoId]);

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
        {videoId && (
          <span className="watch-party-head-actions">
            {!popped && <button type="button" onClick={popOut}>Pop out</button>}
            <button type="button" className="watch-party-stop" onClick={stop}>Stop</button>
          </span>
        )}
      </header>

      {videoId ? (
        <>
          {popped ? (
            <div className="watch-party-popped">
              <p>Playing in a separate window. Closing that window brings the player back here.</p>
              <button type="button" onClick={dock}>Bring back</button>
            </div>
          ) : (
            <div className="watch-party-frame" ref={frameWrapRef}>
              <iframe
                key={videoId}
                ref={frameRef}
                src={embedSrc(videoId)}
                title="Watch party video"
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
              />
            </div>
          )}
          <div className="watch-party-bar">
            <button type="button" onClick={togglePlay}>{remote?.playing ? 'Pause' : 'Play'}</button>
            {!popped && <button type="button" onClick={fullscreen}>Fullscreen</button>}
            <span className="watch-party-hint">Play, pause, seeks and speed sync for everyone.</span>
          </div>
        </>
      ) : (
        <p className="watch-party-empty">Paste a YouTube link to watch together in sync.</p>
      )}

      <form className="watch-party-form" onSubmit={submit}>
        <input
          type="url"
          aria-label="YouTube link"
          placeholder="https://www.youtube.com/watch?v=…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>{videoId ? 'Change video' : 'Start'}</button>
      </form>
      {error && <p role="alert" className="watch-party-error">{error}</p>}
    </section>
  );
}
