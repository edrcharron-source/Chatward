import { useEffect, useRef, useState, type ReactElement } from 'react';
import Hls from 'hls.js';
import type { JellyfinItem, JellyfinPlayback } from '@chatward/shared';
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
export const startJellyfinPlayback = (itemId: string) => api.post<JellyfinPlayback>(`/api/jellyfin/items/${itemId}/play`);

/** iPhone/iPad and Safari play HLS themselves. Jellyfin's own web app uses that there too: it handles seeking in a movie
 *  that is still being transcoded far better than hls.js does on iOS, where jumping ahead used to snap back or stall. */
function playsHlsNatively(video: HTMLVideoElement): boolean {
  const ua = navigator.userAgent;
  const apple = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
    || (/Safari/.test(ua) && !/Chrome|Chromium|Edg|Electron|Android/.test(ua));
  return apple && video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/** Attaches an HLS playlist from the Chatward server to a <video>, optionally starting at `startAt` seconds. Returns a cleanup. */
export function attachJellyfin(video: HTMLVideoElement, playback: JellyfinPlayback, onError: (msg: string) => void, startAt = 0): () => void {
  const src = useSession.getState().serverUrl.replace(/\/$/, '') + playback.url;
  const failed = 'Playback failed. Jellyfin may be busy transcoding; try again.';
  if (playsHlsNatively(video)) {
    const onMeta = () => { if (startAt > 0) video.currentTime = startAt; };
    const onErr = () => onError(failed);
    video.addEventListener('loadedmetadata', onMeta, { once: true });
    video.addEventListener('error', onErr);
    video.src = src;
    return () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
      video.removeAttribute('src');
      video.load();
    };
  }
  if (!Hls.isSupported()) { onError('This device cannot play HLS video.'); return () => {}; }
  const hls = new Hls(startAt > 0 ? { startPosition: startAt } : {});
  hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) onError(failed); });
  hls.loadSource(src);
  hls.attachMedia(video);
  return () => hls.destroy();
}

// Where each movie was left off, kept on this device only (every friend shares one Jellyfin account, so Jellyfin's own
// resume point would mix everyone's up). Too close to the start or the end counts as nothing to resume.
const RESUME_KEY = 'cw.jellyfin.resume';
const RESUME_MAX = 50;
type ResumeMap = Record<string, { t: number; at: number }>;
const readResume = (): ResumeMap => { try { return JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}') as ResumeMap; } catch { return {}; } };
export function resumePoint(itemId: string): number {
  const t = readResume()[itemId]?.t;
  return typeof t === 'number' && t > 0 ? t : 0;
}
function saveResume(itemId: string, t: number, duration: number): void {
  const map = readResume();
  if (t < 30 || (duration > 0 && t > duration - 120)) delete map[itemId];
  else map[itemId] = { t: Math.floor(t), at: Date.now() };
  const keep = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, RESUME_MAX);
  try { localStorage.setItem(RESUME_KEY, JSON.stringify(Object.fromEntries(keep))); } catch { /* private mode */ }
}
const clock = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + `:${String(sec).padStart(2, '0')}`;
};

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
  const [resumedAt] = useState(() => resumePoint(item.id));
  const [showResumed, setShowResumed] = useState(resumedAt > 0);
  const addToParty = () => {
    const ok = queueToWatchParty({ kind: 'jellyfin', ref: item.id, title: item.name });
    setNote(ok ? 'Added to the watch party.' : 'Join a voice channel and open its watch party first.');
  };
  const startOver = () => {
    setShowResumed(false);
    if (ref.current) ref.current.currentTime = 0;
  };
  useEffect(() => {
    let stop = () => {};
    let live = true;
    startJellyfinPlayback(item.id)
      .then((p) => { if (live && ref.current) stop = attachJellyfin(ref.current, p, setError, resumedAt); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not start playback.'));
    return () => { live = false; stop(); };
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the spot every few seconds and whenever playback pauses or the player closes.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const duration = () => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : item.runtimeSeconds ?? 0);
    let last = 0;
    let started = false;
    const save = () => { if (started) saveResume(item.id, v.currentTime, duration()); };
    const onTime = () => {
      // Before the first frame (or before the resume jump lands) currentTime is 0; saving that would wipe the spot.
      if (!started && !v.seeking && v.currentTime > 0) started = true;
      if (Date.now() - last > 5000) { last = Date.now(); save(); }
    };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('pause', save);
    v.addEventListener('ended', save);
    return () => {
      save();
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('pause', save);
      v.removeEventListener('ended', save);
    };
  }, [item.id, error]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="cw-jf-player">
      <div className="cw-jf-bar"><button className="icon" onClick={onBack}>← Back</button><strong>{item.name}</strong>
        {showResumed && <span className="muted">Picked up at {clock(resumedAt)} <button className="icon" onClick={startOver}>Start over</button></span>}
        <button className="icon" onClick={addToParty} disabled={!canQueueToWatchParty()} title="Queue this for everyone in your call">Add to watch party</button>
        {note && <span className="muted">{note}</span>}</div>
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
