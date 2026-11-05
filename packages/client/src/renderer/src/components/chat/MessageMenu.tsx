import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem { label: string; onPick: () => void; danger?: boolean }

/** A message's right-click menu (Reply, Copy text, Edit, Delete). Drawn in the window the message is in. */
export default function MessageMenu({ doc, x, y, items, onClose }: { doc: Document; x: number; y: number; items: MenuItem[]; onClose: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const view = doc.defaultView ?? window;

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, view.innerWidth - width - 4)), top: Math.max(4, Math.min(y, view.innerHeight - height - 4)) });
  }, [x, y, view]);

  // Close on a press outside, Escape, scrolling, resizing or the window losing focus.
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

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Message options"
      className="media-popover media-menu cv-msg-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={it.danger ? 'cv-msg-menu-danger' : undefined}
          onClick={() => { onClose(); it.onPick(); }}
        >
          {it.label}
        </button>
      ))}
    </div>,
    doc.body,
  );
}
