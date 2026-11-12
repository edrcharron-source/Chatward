import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './phone.css';

/**
 * A panel that slides up from the bottom of a phone screen, like the sheets in iPhone apps. Drag its handle down, tap
 * outside it or press Escape to close it. It sits above the home bar and fits under the status bar.
 */
export default function Sheet({ title, onClose, children, className, full = false }: {
  title?: string;
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
        aria-label={title}
        tabIndex={-1}
        style={dy ? { transform: `translateY(${dy}px)` } : undefined}
      >
        <div className="cw-sheet-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <span className="cw-sheet-handle" aria-hidden="true" />
          {title && (
            <div className="cw-sheet-head">
              <strong>{title}</strong>
              <button type="button" className="cw-sheet-done" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>Done</button>
            </div>
          )}
        </div>
        <div className="cw-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** A tappable row in a sheet or a phone settings list: an icon, a label, optional detail text and a chevron. */
export function SheetRow({ icon, label, detail, onClick, danger = false, chevron = true }: {
  icon?: ReactNode; label: string; detail?: ReactNode; onClick: () => void; danger?: boolean; chevron?: boolean;
}) {
  return (
    <button type="button" className={`cw-row${danger ? ' cw-row-danger' : ''}`} onClick={onClick}>
      {icon && <span className="cw-row-icon" aria-hidden="true">{icon}</span>}
      <span className="cw-row-label">{label}</span>
      {detail && <span className="cw-row-detail">{detail}</span>}
      {chevron && <span className="cw-row-chevron" aria-hidden="true">›</span>}
    </button>
  );
}
