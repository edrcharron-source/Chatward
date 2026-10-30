import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Attachment, Channel, Member, MessagePayload } from '@chatward/shared';
import { useChat } from '../../state/chat';
import { buildIndex, closeSearch, EMPTY_FILTERS, indexedEntries, jumpTo, setFilters, statusOf, useSearch } from '../../state/search';
import { isMediaAttachment, isSearching, searchEntries, searchWords, snippet, type SearchEntry, type SearchKind } from '../../state/searchMatch';
import { useDecryptedUrl } from '../media/AttachmentView';
import { GifView } from '../media';
import Avatar from '../chat/Avatar';
import PixelIcon from '../icons/PixelIcon';
import './search.css';

const KINDS: { id: SearchKind; label: string }[] = [
  { id: 'any', label: 'Anything' },
  { id: 'media', label: 'Pictures, videos & GIFs' },
  { id: 'files', label: 'Files' },
  { id: 'links', label: 'Links' },
];
// Results are drawn this many at a time, so a search that matches thousands of messages stays quick.
const PAGE = 100;

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Mounts its children only once scrolled into view, so a long list does not download every picture at once. */
function WhenVisible({ children, className }: { children: ReactNode; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const win = el.ownerDocument.defaultView ?? window;
    const io = new win.IntersectionObserver((list) => { if (list.some((e) => e.isIntersecting)) setSeen(true); });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return <span ref={ref} className={className}>{seen ? children : null}</span>;
}

function ImageThumb({ attachment }: { attachment: Attachment }) {
  const { url, failed } = useDecryptedUrl(attachment);
  if (failed) return <span className="sr-thumb-label">Couldn't load</span>;
  return url ? <img src={url} alt={attachment.name} /> : null;
}

/** Small previews of what a message carries: pictures, GIFs, videos, files and links. */
function Extras({ payload }: { payload: MessagePayload }) {
  const atts = payload.attachments ?? [];
  if (!atts.length && !payload.gif && !payload.linkPreviews?.length) return null;
  return (
    <div className="sr-extras">
      {atts.map((a) => a.mime.startsWith('image/')
        ? <WhenVisible key={a.uploadId} className="sr-thumb"><ImageThumb attachment={a} /></WhenVisible>
        : <span key={a.uploadId} className="sr-chip" title={a.name}>{isMediaAttachment(a) ? '🎞' : '📄'} {a.name}</span>)}
      {payload.gif && <WhenVisible className="sr-thumb"><GifView gif={payload.gif} /></WhenVisible>}
      {payload.linkPreviews?.map((l) => <span key={l.url} className="sr-chip" title={l.url}>🔗 {l.title || l.url}</span>)}
    </div>
  );
}

function Result({ entry, words, member, onPick }: { entry: SearchEntry; words: string[]; member?: Member; onPick: () => void }) {
  const p = entry.payload!;
  const parts = p.text ? snippet(p.text, words) : [];
  return (
    <li>
      <button type="button" className="sr-result" onClick={onPick} title="Show in chat">
        <Avatar user={member?.user} size={28} />
        <span className="sr-main">
          <span className="sr-head">
            <span className="sr-name">{member?.user.displayName ?? 'Unknown user'}</span>
            <time className="sr-time">{formatDate(entry.message.createdAt)}</time>
          </span>
          {parts.length > 0 && (
            <span className="sr-text">{parts.map((s, i) => (i % 2 ? <mark key={i}>{s}</mark> : s))}</span>
          )}
          <Extras payload={p} />
        </span>
      </button>
    </li>
  );
}

export default function SearchPanel({ channel, members }: { channel: Channel; members: Member[] }) {
  const filters = useSearch((s) => s.panels[channel.id]) ?? EMPTY_FILTERS;
  const status = useSearch((s) => s.status[channel.id]) ?? statusOf(channel.id);
  const held = useChat((s) => s.channels[channel.id]?.messages);
  const payloads = useChat((s) => s.payloads);
  const [shown, setShown] = useState(PAGE);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setShown(PAGE); }, [filters.text, filters.authorId, filters.kind]);

  // What the index read plus what the chat holds right now. The chat's copy wins: it already has edits and new messages.
  const results = useMemo(() => {
    const all = new Map<string, SearchEntry>();
    for (const e of indexedEntries(channel.id)) all.set(e.message.id, e);
    for (const m of held ?? []) {
      const payload = payloads[m.id];
      if (payload !== undefined) all.set(m.id, { message: m, payload });
    }
    return searchEntries(all.values(), filters);
  }, [channel.id, filters, held, payloads, status.version]);

  const words = searchWords(filters.text);
  const memberOf = (id: string) => members.find((m) => m.user.id === id);
  const searching = isSearching(filters);
  const close = () => closeSearch(channel.id);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };

  let progress: string;
  if (status.error) progress = `Stopped after ${status.scanned.toLocaleString()} messages: ${status.error}`;
  else if (status.complete) progress = `Searched all ${status.scanned.toLocaleString()} messages`;
  else progress = `Reading history… ${status.scanned.toLocaleString()} messages so far`;

  return (
    <aside className="sr-panel" aria-label="Search messages" onKeyDown={onKey}>
      <div className="sr-top">
        <div className="sr-field">
          <PixelIcon name="search" />
          <input
            ref={inputRef}
            type="search"
            placeholder={`Search #${channel.name}`}
            aria-label="Search for words"
            value={filters.text}
            onChange={(e) => setFilters(channel.id, { text: e.target.value })}
          />
        </div>
        <button type="button" className="icon" aria-label="Close search" title="Close search (Esc)" onClick={close}>
          <PixelIcon name="close" />
        </button>
      </div>
      <div className="sr-filters">
        <label>
          <span className="muted">From</span>
          <select value={filters.authorId} onChange={(e) => setFilters(channel.id, { authorId: e.target.value })} aria-label="From person">
            <option value="">Anyone</option>
            {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.displayName}</option>)}
          </select>
        </label>
        <label>
          <span className="muted">Has</span>
          <select value={filters.kind} onChange={(e) => setFilters(channel.id, { kind: e.target.value as SearchKind })} aria-label="Message has">
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </label>
      </div>
      <div className="sr-status muted" aria-live="polite">
        {searching && <strong>{results.length === 1 ? '1 result' : `${results.length.toLocaleString()} results`} · </strong>}
        {progress}
        {status.error && <button type="button" className="sr-retry" onClick={() => void buildIndex(channel.id)}>Retry</button>}
      </div>
      {!searching ? (
        <p className="sr-hint muted">Type a word, or pick a person or a kind of message to list them all. Click a result to see it in the chat.</p>
      ) : results.length === 0 ? (
        <p className="sr-hint muted">{status.complete ? 'Nothing matches.' : 'Nothing yet. Still reading older messages…'}</p>
      ) : (
        <ol className="sr-list">
          {results.slice(0, shown).map((e) => (
            <Result key={e.message.id} entry={e} words={words} member={memberOf(e.message.authorId)} onPick={() => jumpTo(e.message)} />
          ))}
          {results.length > shown && (
            <li className="sr-more"><button type="button" onClick={() => setShown((n) => n + PAGE)}>Show more</button></li>
          )}
        </ol>
      )}
    </aside>
  );
}
