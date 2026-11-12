import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './phone.css';

/**
 * A panel that slides up from the bottom of a phone screen, drawn like the app's other dialogs (.modal tokens). Drag its handle down, tap
 * outside it or press Escape to close it. It sits above the home bar and fits under the status bar.
 */
export default function Sheet({ title, label, onClose, children, className, full = false }: {
  title?: string;
  /** the name screen readers hear when there is no title */
  label?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** take the whole screen height (for long content such as settings) */
  full?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; y: number } | null>(null);
  const [dy, setDy] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { id: e.pointerId, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    setDy(Math.max(0, e.clientY - drag.current.y));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    if (dy > 90) onClose();
    setDy(0);
  };

  return createPortal(
    <div className="cw-sheet-layer">
      <div className="cw-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        className={`cw-sheet${full ? ' cw-sheet-full' : ''}${dy ? ' cw-sheet-dragging' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? label}
        tabIndex={-1}
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
      >
        <div className="cw-sheet-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <span className="cw-sheet-handle" aria-hidden="true" />
          {title && (
            <div className="cw-sheet-head">
              <strong>{title}</strong>
              <button type="button" className="icon cw-sheet-close" aria-label="Close" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>✕</button>
            </div>
          )}
        </div>
        <div className="cw-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
