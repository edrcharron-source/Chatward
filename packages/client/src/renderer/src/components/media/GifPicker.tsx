import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { MessagePayload } from '@chatward/shared';
import { api } from '../../api/http';
import { usePopover } from './Popover';
import { isSafeGifUrl } from './safeUrls';
import GifLibraryPanel from '../gifs/GifLibraryPanel';
import LibraryGifImage from '../gifs/LibraryGifImage';
import SaveGifButton from '../gifs/SaveGifButton';

type Gif = NonNullable<MessagePayload['gif']>;

interface GifResult {
  id: string;
  url: string;
  previewUrl: string;
  title: string;
  width: number;
  height: number;
}

interface GifPage {
  results: GifResult[];
  next?: string;
  disabled?: boolean;
  hint?: string;
}

const SEARCH_DEBOUNCE_MS = 300;

/** Host part of a file address, for the log line. Never the full URL. */
function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol;
  } catch {
    return 'invalid url';
  }
}

function GifPanel({ onPick }: { onPick: (gif: Gif) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [disabled, setDisabled] = useState(false);
  const [hint, setHint] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = results.filter((g) => isSafeGifUrl(g.url) && isSafeGifUrl(g.previewUrl));
  // Only the newest request may update state, so a slow old search can't overwrite newer results.
  const latest = useRef(0);

  const load = useCallback(async (q: string, pos?: string) => {
    const request = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (pos) params.set('pos', pos);
      const page = await api.get<GifPage>(`/api/gifs/${q ? 'search' : 'trending'}?${params}`);
      if (request !== latest.current) return;
      const hidden = page.results.filter((g) => !isSafeGifUrl(g.url) || !isSafeGifUrl(g.previewUrl));
      if (hidden.length > 0) console.warn(`GIF picker hid ${hidden.length} result(s) from hosts not on the allowlist:`, hidden.map((g) => hostOf(g.url)));
      setDisabled(Boolean(page.disabled));
      setHint(page.hint);
      setResults((prev) => (pos ? [...prev, ...page.results] : page.results));
      setNext(page.next);
    } catch (err) {
      if (request === latest.current) setError(err instanceof Error ? err.message : 'Could not load GIFs');
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, load]);

  return (
    <div className="media-gif-panel">
      <input
        type="search"
        className="media-search"
        placeholder="Search GIFs"
        aria-label="Search GIFs"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {disabled && <p className="muted media-note">{hint ?? "GIF search isn't set up on this server yet."}</p>}
      {error && <p className="media-error">{error}</p>}
      {!loading && results.length > 0 && visible.length === 0 && (
        <p className="muted media-note">GIFs were found, but their file address isn't on the GIF host allowlist, so none can be shown.</p>
      )}
      <div className="media-gif-grid">
        {visible.map((g) => (
          <button
            key={g.id}
            type="button"
            className="media-gif-tile"
            aria-label={g.title || 'GIF'}
            onClick={() => onPick({ url: g.url, previewUrl: g.previewUrl, title: g.title, provider: 'klipy' })}
          >
            <img src={g.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
          </button>
        ))}
      </div>
      {!loading && !error && !disabled && results.length === 0 && <p className="muted media-note">No GIFs found.</p>}
      {next && (
        <button type="button" className="media-more" disabled={loading} onClick={() => void load(query.trim(), next)}>
          {loading ? 'Loading…' : 'More'}
        </button>
      )}
    </div>
  );
}

type Tab = 'server' | 'klipy';
// Library ids come from other people's messages, so only plain ids reach the request path.
const LIBRARY_ID = /^[0-9a-z-]{1,40}$/;

export function GifPickerButton({ serverId, onPick }: { serverId: string; onPick: (gif: Gif) => void }): ReactElement {
  const { open, setOpen, ref } = usePopover();
  const [tab, setTab] = useState<Tab>('server');
  const pick = (gif: Gif) => {
    onPick(gif);
    setOpen(false);
  };
  return (
    <div className="media-anchor" ref={ref}>
      <button
        type="button"
        className="icon media-toolbar-btn media-gif-btn"
        aria-label="GIFs"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        GIF
      </button>
      {open && (
        <div className="media-popover media-gif-popover" role="dialog" aria-label="GIF picker">
          <div className="gif-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'server'} onClick={() => setTab('server')}>Server</button>
            <button type="button" role="tab" aria-selected={tab === 'klipy'} onClick={() => setTab('klipy')}>Klipy</button>
          </div>
          {tab === 'server' ? <GifLibraryPanel serverId={serverId} onPick={pick} /> : <GifPanel onPick={pick} />}
        </div>
      )}
    </div>
  );
}

/** A GIF in a message or the composer. With `serverId`, a hover button saves a KLIPY GIF to the server's library. */
export function GifView({ gif, serverId }: { gif: Gif; serverId?: string }): ReactElement | null {
  if (gif.provider === 'library') {
    return gif.libraryId && LIBRARY_ID.test(gif.libraryId) ? <LibraryGifImage id={gif.libraryId} title={gif.title} className="media-gif" /> : <span className="muted media-gif-blocked">GIF removed</span>;
  }
  if (!isSafeGifUrl(gif.url)) return <span className="muted media-gif-blocked">GIF blocked</span>;
  const img = <img className="media-gif" src={gif.url} alt={gif.title || 'GIF'} loading="lazy" referrerPolicy="no-referrer" />;
  if (!serverId || gif.url.startsWith('data:')) return img;
  return (
    <span className="media-gif-wrap">
      {img}
      <SaveGifButton serverId={serverId} source={{ kind: 'klipy', url: gif.url }} defaultName={gif.title} />
    </span>
  );
}
