import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { MessagePayload, ScrollComment, ScrollSocial } from '@chatward/shared';
import { useSession } from '../../state/session';
import { isDemo } from '../../demo';
import { loadVaultIndex } from '../vault/vaultIndex';
import { fetchVaultUrl, fetchVaultViewUrl, openDescriptor } from '../vault/vault';
import { GifPickerButton, GifView } from '../media';
import { shuffled } from './shuffle';
import { mockSlides } from './mockSlides';
import { addComment, deleteComment, getSocial, listComments, setLike } from './scrollApi';
import type { FeedSlide } from './types';
import './scroll.css';

type Gif = NonNullable<MessagePayload['gif']>;

/** Real Vault items as feed slides. Items whose descriptor cannot be opened (no channel key) are left out. */
async function vaultSlides(serverId: string): Promise<FeedSlide[]> {
  const index = await loadVaultIndex(serverId);
  const out: FeedSlide[] = [];
  for (const item of index?.items ?? []) {
    const d = await openDescriptor(item).catch(() => null);
    if (!d || (d.kind !== 'image' && d.kind !== 'video')) continue;
    out.push({
      id: item.id,
      title: d.name || (d.kind === 'video' ? 'Video' : 'Photo'),
      kind: d.kind,
      revoke: true,
      load: () => (d.kind === 'video' ? fetchVaultUrl(item, d, false) : fetchVaultViewUrl(item, d).then((v) => v.url)),
    });
  }
  return out;
}

/**
 * The Scroll feed: a full-window, vertical, snap-scrolling column of Vault pictures and videos in a random order for
 * this viewer. Each one has a like button and a comments sheet; comments can carry a GIF.
 */
export default function ScrollFeed({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const me = useSession((s) => s.user?.id ?? 'me');
  const [slides, setSlides] = useState<FeedSlide[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [social, setSocial] = useState<Record<string, ScrollSocial>>({});
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const urlsRef = useRef<Record<string, string>>({});
  const pendingRef = useRef<Set<string>>(new Set());

  // The order: shuffled per viewer and server, so it is random for each person and stable for them.
  const ordered = useMemo(() => (slides ? shuffled(slides, `${me}|${serverId}`) : []), [slides, me, serverId]);

  useEffect(() => {
    let alive = true;
    const load = isDemo() ? Promise.resolve(mockSlides()) : vaultSlides(serverId);
    load.then((list) => { if (alive) setSlides(list); }).catch((err) => { if (alive) setError(err instanceof Error ? err.message : 'Could not load the feed'); });
    getSocial(serverId).then((s) => { if (alive) setSocial(s); }).catch(() => {});
    return () => { alive = false; };
  }, [serverId]);

  // Free every object URL when the feed closes. A load still in flight when it closes frees its own URL.
  const closedRef = useRef(false);
  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      for (const url of Object.values(urlsRef.current)) URL.revokeObjectURL(url);
      urlsRef.current = {};
    };
  }, []);

  // Load the slide on screen and the one on each side; the rest wait until they are near.
  useEffect(() => {
    for (const i of [index - 1, index, index + 1]) {
      const slide = ordered[i];
      if (!slide || urlsRef.current[slide.id] || pendingRef.current.has(slide.id)) continue;
      pendingRef.current.add(slide.id);
      slide.load().then((url) => {
        pendingRef.current.delete(slide.id);
        if (closedRef.current || urlsRef.current[slide.id]) { if (slide.revoke) URL.revokeObjectURL(url); return; }
        urlsRef.current[slide.id] = url;
        setUrls((cur) => ({ ...cur, [slide.id]: url }));
      }).catch(() => pendingRef.current.delete(slide.id));
    }
  }, [index, ordered]);

  const onScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el || !el.clientHeight) return;
    setIndex(Math.round(el.scrollTop / el.clientHeight));
  }, []);

  // Keys: Escape closes the comments sheet, then the feed; arrow keys step through slides.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (commentsFor) setCommentsFor(null);
        else onClose();
        return;
      }
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.target.tagName));
      if (commentsFor || typing) return;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); feedRef.current?.scrollBy({ top: feedRef.current.clientHeight, behavior: 'smooth' }); }
      if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); feedRef.current?.scrollBy({ top: -feedRef.current.clientHeight, behavior: 'smooth' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commentsFor, onClose]);

  const toggleLike = async (id: string) => {
    const cur = social[id] ?? { count: 0, liked: false, comments: 0 };
    const liked = !cur.liked;
    setSocial((s) => ({ ...s, [id]: { ...cur, liked, count: Math.max(0, cur.count + (liked ? 1 : -1)) } }));
    try {
      const next = await setLike(id, liked);
      setSocial((s) => ({ ...s, [id]: { ...next, comments: s[id]?.comments ?? next.comments } }));
    } catch {
      setSocial((s) => ({ ...s, [id]: cur }));
    }
  };

  const current = ordered[index];

  return (
    <div className="cw-scroll" role="dialog" aria-modal="true" aria-label="Scroll feed">
      <header className="cw-scroll-top">
        <strong className="cw-scroll-title">Scroll!</strong>
        <button type="button" className="cw-tool cw-scroll-close" onClick={onClose}>Close</button>
      </header>

      {error && <p className="cw-scroll-empty" role="alert">{error}</p>}
      {!error && slides === null && <p className="cw-scroll-empty">Loading the feed…</p>}
      {slides && ordered.length === 0 && <p className="cw-scroll-empty">Nothing to scroll yet. Pictures and videos from the Vault show up here.</p>}

      {ordered.length > 0 && (
        <div className="cw-scroll-feed" ref={feedRef} onScroll={onScroll} tabIndex={0} aria-label="Vault pictures and videos">
          {ordered.map((slide, i) => {
            const s = social[slide.id];
            const url = urls[slide.id];
            return (
              <article key={slide.id} className="cw-scroll-slide" aria-label={`${i + 1} of ${ordered.length}: ${slide.title}`}>
                <div className="cw-scroll-stage">
                <div className="cw-scroll-media">
                  {url && slide.kind === 'video'
                    ? <FeedVideo src={url} title={slide.title} active={i === index} />
                    : url ? <img src={url} alt={slide.title} className="cw-scroll-image" /> : <span className="cw-scroll-loading muted">Loading…</span>}
                </div>
                <div className="cw-scroll-rail">
                  <button type="button" className="cw-scroll-act" aria-pressed={!!s?.liked} aria-label={`Like, ${s?.count ?? 0} likes`} onClick={() => void toggleLike(slide.id)}>
                    <span aria-hidden="true">{s?.liked ? '♥' : '♡'}</span>
                    <span>{s?.count ?? 0}</span>
                  </button>
                  <button type="button" className="cw-scroll-act" aria-label={`Comments, ${s?.comments ?? 0}`} onClick={() => setCommentsFor(slide.id)}>
                    <span aria-hidden="true">💬</span>
                    <span>{s?.comments ?? 0}</span>
                  </button>
                </div>
                <p className="cw-scroll-caption">{slide.title}</p>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {commentsFor && current && (
        <CommentsSheet
          key={commentsFor}
          serverId={serverId}
          itemId={commentsFor}
          me={me}
          onClose={() => setCommentsFor(null)}
          onCountChange={(n) => setSocial((s) => ({ ...s, [commentsFor]: { ...(s[commentsFor] ?? { count: 0, liked: false, comments: 0 }), comments: n } }))}
        />
      )}
    </div>
  );
}

/** A video that plays while it is the one on screen and pauses when you scroll away. Sound starts only if the browser allows it. */
function FeedVideo({ src, title, active }: { src: string; title: string; active: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!active) { v.pause(); return; }
    void v.play().catch(() => {
      // The browser blocked sound: start again muted, so the clip still plays.
      v.muted = true;
      void v.play().catch(() => {});
    });
  }, [active, src]);
  // A clip only plays while it is the one on screen, even when someone presses its play button on another slide.
  const stopIfAway = () => { if (!activeRef.current) ref.current?.pause(); };
  return <video ref={ref} src={src} controls playsInline loop autoPlay={active} onPlay={stopIfAway} className="cw-scroll-video" aria-label={title} />;
}

function CommentsSheet({ serverId, itemId, me, onClose, onCountChange }: {
  serverId: string; itemId: string; me: string; onClose: () => void; onCountChange: (n: number) => void;
}) {
  const [list, setList] = useState<ScrollComment[] | null>(null);
  const [text, setText] = useState('');
  const [gif, setGif] = useState<Gif | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listComments(itemId).then((c) => { if (alive) { setList(c); onCountChange(c.length); } }).catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body && !gif) return;
    setBusy(true);
    setProblem(null);
    try {
      const c = await addComment(itemId, body, gif);
      setList((cur) => { const next = [...(cur ?? []), c]; onCountChange(next.length); return next; });
      setText('');
      setGif(null);
    } catch {
      setProblem('Could not post that comment. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: ScrollComment) => {
    try {
      await deleteComment(c.id);
      setList((cur) => { const next = (cur ?? []).filter((x) => x.id !== c.id); onCountChange(next.length); return next; });
    } catch {
      setProblem('Could not delete that comment.');
    }
  };

  return (
    <section className="cw-scroll-sheet" role="dialog" aria-modal="false" aria-label="Comments">
      <header className="cw-scroll-sheet-top">
        <strong>Comments</strong>
        <button type="button" className="cw-tool" onClick={onClose}>Close</button>
      </header>
      <ol className="cw-scroll-comments">
        {list === null && <li className="muted">Loading…</li>}
        {list?.length === 0 && <li className="muted">No comments yet. Say something, or send a GIF.</li>}
        {list?.map((c) => (
          <li key={c.id} className="cw-scroll-comment">
            <div className="cw-scroll-comment-body">
              {c.text && <p>{c.text}</p>}
              {c.gif && <GifView gif={c.gif} serverId={serverId} />}
            </div>
            {c.authorId === me && <button type="button" className="cw-tool cw-scroll-del" onClick={() => void remove(c)} aria-label="Delete comment">Delete</button>}
          </li>
        ))}
      </ol>
      <form className="cw-scroll-compose" onSubmit={send}>
        {gif && (
          <div className="cw-scroll-pending">
            <span>GIF: {gif.title || 'attached'}</span>
            <button type="button" className="cw-tool" onClick={() => setGif(null)}>Remove GIF</button>
          </div>
        )}
        <div className="cw-scroll-compose-row">
          <label className="cw-scroll-sr" htmlFor={`scroll-comment-${itemId}`}>Comment</label>
          <input id={`scroll-comment-${itemId}`} className="cw-scroll-input" value={text} maxLength={500} placeholder="Add a comment" onChange={(e) => setText(e.target.value)} />
          <GifPickerButton serverId={serverId} onPick={setGif} />
          <button type="submit" className="cw-tool" disabled={busy || (!text.trim() && !gif)}>Post</button>
        </div>
        {problem && <p className="cw-scroll-problem" role="alert">{problem}</p>}
      </form>
    </section>
  );
}
