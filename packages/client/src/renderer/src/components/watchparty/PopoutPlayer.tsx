import { useEffect, useRef, useState, type ReactElement } from 'react';
import { bindPlayer, embedSrc, sendCommand, type PlayerEvent } from './youtube';
import type { PanelToPopout, PopoutToPanel } from './popout';
import { useSettings, type Settings } from '../../state/settings';
import { applySkin } from '../../skins';
import './watchparty.css';

/** The pop-out window's whole UI: the embed the panel tells it to show, and a fullscreen button. */
export function PopoutPlayer(): ReactElement {
  const [videoId, setVideoId] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const opener = window.opener as Window | null;

  const send = (msg: PopoutToPanel) => opener?.postMessage(msg, '*');

  // The skin is chosen in the main window, so this one applies the saved setting and follows later changes made there.
  useEffect(() => {
    void applySkin(useSettings.getState().skin);
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'chatward.settings') void applySkin((JSON.parse(e.newValue ?? '{}') as Partial<Settings>).skin ?? '');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== opener) return;
      const msg = e.data as PanelToPopout | null;
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'load') setVideoId(msg.videoId);
      else if (msg.kind === 'command') sendCommand(frameRef.current, msg.func, msg.args);
      else if (msg.kind === 'close') window.close();
    };
    const onHide = () => send({ kind: 'closed' });
    window.addEventListener('message', onMessage);
    window.addEventListener('pagehide', onHide);
    send({ kind: 'hello' });
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  // The embed's own events go back to the panel, which decides what to publish.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !videoId) return;
    return bindPlayer(frame, (e: PlayerEvent) => send({ kind: 'event', event: e }));
  }, [videoId]);

  return (
    <div className="watch-popout">
      {videoId ? (
        <iframe
          key={videoId}
          ref={frameRef}
          src={embedSrc(videoId)}
          title="Watch party video"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      ) : (
        <p className="watch-popout-empty">Waiting for the watch party to start…</p>
      )}
      <div className="watch-popout-bar">
        <span className="watch-party-hint">Synced with the watch party.</span>
        <button type="button" onClick={() => void document.documentElement.requestFullscreen()}>Fullscreen</button>
      </div>
    </div>
  );
}
