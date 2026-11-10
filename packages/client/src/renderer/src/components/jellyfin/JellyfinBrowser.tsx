import { useEffect, useRef, useState, type ReactElement } from 'react';
import Hls from 'hls.js';
import { JELLYFIN_QUALITIES, type JellyfinItem, type JellyfinPlayback, type JellyfinQuality } from '@chatward/shared';
import { api, fetchObjectUrl } from '../../api/http';
import { useSession } from '../../state/session';
import { queueToWatchParty, canQueueToWatchParty } from '../watchparty/bridge';
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
export const startJellyfinPlayback = (itemId: string, quality: JellyfinQuality = 'original') =>
  api.post<JellyfinPlayback>(`/api/jellyfin/items/${itemId}/play`, { quality });

// Each viewer's own picture quality, remembered on this device. Watch together still syncs: everyone just streams their own copy.
const QUALITY_KEY = 'cw.jellyfinQuality';
const qualityListeners = new Set<(q: JellyfinQuality) => void>();
function savedQuality(): JellyfinQuality {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    if (JELLYFIN_QUALITIES.some((q) => q.id === v)) return v as JellyfinQuality;
  } catch { /* storage blocked: use the default */ }
  return 'original';
}

/** The picture quality this viewer picked for Jellyfin movies, shared by every player in the app. */
export function useJellyfinQuality(): [JellyfinQuality, (q: JellyfinQuality) => void] {
  const [quality, setLocal] = useState(savedQuality);
  useEffect(() => {
    qualityListeners.add(setLocal);
    return () => { qualityListeners.delete(setLocal); };
  }, []);
  const set = (q: JellyfinQuality) => {
    try { localStorage.setItem(QUALITY_KEY, q); } catch { /* not remembered, still applies now */ }
    qualityListeners.forEach((fn) => fn(q));
  };
  return [quality, set];
}

/** A small dropdown for the picture quality. Changing it restarts the stream at the same spot. */
export function JellyfinQualityPicker({ quality, onChange }: { quality: JellyfinQuality; onChange: (q: JellyfinQuality) => void }): ReactElement {
  return (
    <label className="cw-jf-quality" title="Picture quality for movies. Higher needs a faster connection.">
      <span>Quality</span>
      <select value={quality} onChange={(e) => onChange(e.target.value as JellyfinQuality)}>
        {JELLYFIN_QUALITIES.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
      </select>
    </label>
  );
}

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
  const [note, setNote] = useState<string | null>(null);
  const [quality, setQuality] = useJellyfinQuality();
  const addToParty = () => {
    const ok = queueToWatchParty({ kind: 'jellyfin', ref: item.id, title: item.name });
    setNote(ok ? 'Added to the watch party.' : 'Join a voice channel and open its watch party first.');
  };
  useEffect(() => {
    let stop = () => {};
    let live = true;
    // A quality change restarts the stream, so pick up where it was.
    const video = ref.current;
    const resumeAt = video?.currentTime ?? 0;
    const wasPlaying = video ? !video.paused : true;
    setError(null);
    startJellyfinPlayback(item.id, quality)
      .then((p) => {
        if (!live || !ref.current) return;
        const v = ref.current;
        stop = attachJellyfin(v, p, setError);
        if (resumeAt > 0) {
          v.addEventListener('loadedmetadata', () => {
            v.currentTime = resumeAt;
            if (!wasPlaying) v.pause();
          }, { once: true });
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not start playback.'));
    return () => { live = false; stop(); };
  }, [item.id, quality]);
  return (
    <div className="cw-jf-player">
      <div className="cw-jf-bar"><button className="icon" onClick={onBack}>← Back</button><strong>{item.name}</strong>
        <button className="icon" onClick={addToParty} disabled={!canQueueToWatchParty()} title="Queue this for everyone in your call">Add to watch party</button>
        {note && <span className="muted">{note}</span>}
        <JellyfinQualityPicker quality={quality} onChange={setQuality} /></div>
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
