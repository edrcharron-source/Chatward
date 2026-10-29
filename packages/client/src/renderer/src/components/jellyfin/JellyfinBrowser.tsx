import { useEffect, useRef, useState, type ReactElement } from 'react';
import Hls from 'hls.js';
import type { JellyfinItem, JellyfinPlayback } from '@chatward/shared';
import { api, fetchObjectUrl } from '../../api/http';
import { useSession } from '../../state/session';
import './jellyfin.css';

/** Whether this server has Jellyfin set up, so the app can hide the Movies button when it has not. */
export function useJellyfinEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    api.get<{ enabled: boolean }>('/api/jellyfin/status').then((r) => { if (live) setEnabled(r.enabled); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return enabled;
}

/** Asks the server for a ticketed HLS playlist for one item. Anything that wants to play Jellyfin (the player below, watch party) starts here. */
export const startJellyfinPlayback = (itemId: string) => api.post<JellyfinPlayback>(`/api/jellyfin/items/${itemId}/play`);

/** Attaches an HLS playlist from the Chatward server to a <video>. Returns a cleanup. */
export function attachJellyfin(video: HTMLVideoElement, playback: JellyfinPlayback, onError: (msg: string) => void): () => void {
  const src = useSession.getState().serverUrl.replace(/\/$/, '') + playback.url;
  if (!Hls.isSupported()) { onError('This device cannot play HLS video.'); return () => {}; }
  const hls = new Hls();
  hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) onError('Playback failed. Jellyfin may be busy transcoding; try again.'); });
  hls.loadSource(src);
  hls.attachMedia(video);
  return () => hls.destroy();
}

function Poster({ item }: { item: JellyfinItem }): ReactElement {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!item.posterUrl) return;
    let url: string | null = null;
    let live = true;
    fetchObjectUrl(item.posterUrl).then((u) => { if (live) { url = u; setSrc(u); } else URL.revokeObjectURL(u); }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [item.posterUrl]);
  return src ? <img src={src} alt="" /> : <div className="cw-jf-noposter">{item.name.slice(0, 1)}</div>;
}

function Player({ item, onBack }: { item: JellyfinItem; onBack: () => void }): ReactElement {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = () => {};
    let live = true;
    startJellyfinPlayback(item.id)
      .then((p) => { if (live && ref.current) stop = attachJellyfin(ref.current, p, setError); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not start playback.'));
    return () => { live = false; stop(); };
  }, [item.id]);
  return (
    <div className="cw-jf-player">
      <div className="cw-jf-bar"><button className="icon" onClick={onBack}>← Back</button><strong>{item.name}</strong></div>
      {error ? <div className="cw-jf-error">{error}</div> : <video ref={ref} controls autoPlay />}
    </div>
  );
}

/** Browse and play the Jellyfin library. Folders open in place; Movie and Episode tiles play. */
export function JellyfinBrowser({ onClose }: { onClose: () => void }): ReactElement {
  const [trail, setTrail] = useState<JellyfinItem[]>([]);
  const [items, setItems] = useState<JellyfinItem[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<JellyfinItem | null>(null);
  const parentId = trail.at(-1)?.id;

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      const qs = new URLSearchParams();
      if (query.trim()) qs.set('q', query.trim()); else if (parentId) qs.set('parentId', parentId);
      api.get<{ items: JellyfinItem[] }>(`/api/jellyfin/items?${qs}`)
        .then((r) => { if (live) { setItems(r.items); setError(null); } })
        .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the library.'); });
    }, query ? 300 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [parentId, query]);

  const open = (it: JellyfinItem) => (it.playable ? setPlaying(it) : (setQuery(''), setTrail((t) => [...t, it])));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal cw-jf" role="dialog" aria-modal="true" aria-label="Movies">
        {playing ? <Player item={playing} onBack={() => setPlaying(null)} /> : (
          <>
            <div className="cw-jf-bar">
              <strong>🍿 Movies</strong>
              {trail.length > 0 && <button className="icon" onClick={() => setTrail((t) => t.slice(0, -1))}>← {trail.at(-1)!.name}</button>}
              <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the library" />
              <button className="icon" onClick={onClose}>Close</button>
            </div>
            {error && <div className="cw-jf-error">{error}</div>}
            <div className="cw-jf-grid">
              {items.map((it) => (
                <button key={it.id} className="cw-jf-tile" onClick={() => open(it)}>
                  <Poster item={it} />
                  <span>{it.name}{it.year ? ` (${it.year})` : ''}</span>
                </button>
              ))}
              {!error && items.length === 0 && <div className="muted">Nothing here.</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
