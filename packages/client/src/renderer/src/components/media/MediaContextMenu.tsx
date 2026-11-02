import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { copyGifLink, copyPicture, isGifLink } from './copyImage';

/** Pictures that get the menu: chat pictures, chat GIFs, and the full-window viewer. Not the GIF picker's tiles. */
const TARGETS = 'img.media-image, img.media-gif, img.media-lightbox-img';

interface Target { src: string; name: string; gif: boolean; x: number; y: number }

/**
 * Right-click menu on pictures and GIFs: Copy image (and Copy GIF link for GIF search results).
 * Mount once per window (the main window and each popped-out window): it listens on its own window's page.
 */
export default function MediaContextMenu(): ReactElement {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    const d = anchorRef.current?.ownerDocument;
    if (!d) return;
    setDoc(d);
    const onContextMenu = (e: MouseEvent) => {
      const img = (e.target as Element | null)?.closest?.(TARGETS) as HTMLImageElement | null;
      if (!img || img.closest('.media-gif-grid') || !(img.currentSrc || img.src)) return;
      e.preventDefault();
      const src = img.currentSrc || img.src;
      const name = img.alt || 'Picture';
      const gif = img.classList.contains('media-gif') || /\.gif$/i.test(name) || isGifLink(src);
      setTarget({ src, name, gif, x: e.clientX, y: e.clientY });
    };
    d.addEventListener('contextmenu', onContextMenu);
    return () => d.removeEventListener('contextmenu', onContextMenu);
  }, []);

  return (
    <>
      <span ref={anchorRef} hidden />
      {doc && target && <Menu key={`${target.x},${target.y},${target.src}`} doc={doc} target={target} onClose={() => setTarget(null)} />}
    </>
  );
}

function Menu({ doc, target, onClose }: { doc: Document; target: Target; onClose: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.x, top: target.y });
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const view = doc.defaultView ?? window;

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(target.x, view.innerWidth - width - 4)),
      top: Math.max(4, Math.min(target.y, view.innerHeight - height - 4)),
    });
  }, [target.x, target.y, view, status]);

  // Close on a press outside, Escape, scrolling or the window losing focus. Escape is caught before the picture
  // viewer's own Escape (which would zoom out or close the viewer).
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    const close = () => onClose();
    view.addEventListener('mousedown', onDown, true);
    view.addEventListener('keydown', onKey, true);
    view.addEventListener('blur', close);
    view.addEventListener('resize', close);
    doc.addEventListener('scroll', close, true);
    return () => {
      view.removeEventListener('mousedown', onDown, true);
      view.removeEventListener('keydown', onKey, true);
      view.removeEventListener('blur', close);
      view.removeEventListener('resize', close);
      doc.removeEventListener('scroll', close, true);
    };
  }, [doc, view, onClose]);

  useEffect(() => { ref.current?.querySelector('button')?.focus(); }, []);

  // After "Copied", close by itself.
  useEffect(() => {
    if (!status || status.error) return;
    const t = setTimeout(onClose, 900);
    return () => clearTimeout(t);
  }, [status, onClose]);

  const run = async (job: () => Promise<string>) => {
    setBusy(true);
    setStatus({ text: 'Copying…' });
    try {
      setStatus({ text: await job() });
    } catch (err) {
      setStatus({ text: err instanceof Error && err.message ? err.message : 'Could not copy that.', error: true });
    } finally {
      setBusy(false);
    }
  };

  const label = target.gif ? 'Copy GIF' : 'Copy image';
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`${target.name} options`}
      className="media-popover media-menu"
      style={{ left: pos.left, top: pos.top }}
      // Keep the menu's clicks to itself, so nothing under it (the picture viewer) reacts to them.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" disabled={busy} onClick={() => void run(async () => { await copyPicture(target.src, target.name); return 'Copied'; })}>
        {label}
      </button>
      {isGifLink(target.src) && (
        <button type="button" role="menuitem" disabled={busy} onClick={() => void run(async () => { await copyGifLink(target.src); return 'Link copied'; })}>
          Copy GIF link
        </button>
      )}
      {status && <p className={status.error ? 'media-menu-status media-error' : 'media-menu-status'} role="status">{status.text}</p>}
    </div>,
    doc.body,
  );
}
