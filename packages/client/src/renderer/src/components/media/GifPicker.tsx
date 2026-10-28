import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { MessagePayload } from '@chatward/shared';
import { api } from '../../api/http';
import { usePopover } from './Popover';

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

function GifPanel({ onPick }: { onPick: (gif: Gif) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [disabled, setDisabled] = useState(false);
  const [hint, setHint] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      <div className="media-gif-grid">
        {results.map((g) => (
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

export function GifPickerButton({ onPick }: { onPick: (gif: Gif) => void }): ReactElement {
  const { open, setOpen, ref } = usePopover();
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
          <GifPanel
            onPick={(gif) => {
              onPick(gif);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

export function GifView({ gif }: { gif: Gif }): ReactElement | null {
  return <img className="media-gif" src={gif.url} alt={gif.title || 'GIF'} loading="lazy" referrerPolicy="no-referrer" />;
}
