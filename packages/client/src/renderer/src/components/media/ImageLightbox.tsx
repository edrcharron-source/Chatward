import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement, type WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';

/** How far one click zooms in, relative to the picture's fitted size. */
const CLICK_ZOOM = 2.5;
const MAX_ZOOM = 8;
/** Pointer travel (px) above which a press counts as a drag, not a click. */
const DRAG_SLOP = 4;

interface View { scale: number; x: number; y: number }
const FITTED: View = { scale: 1, x: 0, y: 0 };

/** The biggest size that fits the box while keeping the picture's shape. Small pictures are scaled up too. */
export function fitSize(natW: number, natH: number, boxW: number, boxH: number): { w: number; h: number } {
  if (natW <= 0 || natH <= 0 || boxW <= 0 || boxH <= 0) return { w: 0, h: 0 };
  const k = Math.min(boxW / natW, boxH / natH);
  return { w: Math.round(natW * k), h: Math.round(natH * k) };
}

/** Keeps a zoomed picture from being dragged off screen: an edge can't come further in than the stage edge. */
function clamp(v: View, w: number, h: number, boxW: number, boxH: number): View {
  const maxX = Math.max(0, (w * v.scale - boxW) / 2);
  const maxY = Math.max(0, (h * v.scale - boxH) / 2);
  return { scale: v.scale, x: Math.min(maxX, Math.max(-maxX, v.x)), y: Math.min(maxY, Math.max(-maxY, v.y)) };
}

/**
 * Full-window picture viewer. The picture fills the window (keeping its shape);
 * click zooms in on that spot, drag moves it while zoomed, click again or Esc goes back.
 */
export default function ImageLightbox({ url, name, onClose, container }: {
  url: string;
  name: string;
  onClose: () => void;
  /** Where to mount; a popped-out window passes its own body so the viewer opens in that window. */
  container?: HTMLElement | null;
}): ReactElement {
  const host = container ?? document.body;
  const doc = host.ownerDocument;
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>(FITTED);
  const [dragging, setDragging] = useState(false);
  const press = useRef<{ id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);

  const viewRef = useRef(view);
  viewRef.current = view;
  const zoomed = view.scale > 1;
  const fit = fitSize(natural.w, natural.h, box.w, box.h);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const RO = doc.defaultView?.ResizeObserver ?? ResizeObserver;
    const ro = new RO(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  // Window resized while zoomed: keep the picture inside the new bounds.
  useEffect(() => {
    setView((v) => clamp(v, fit.w, fit.h, box.w, box.h));
  }, [fit.w, fit.h, box.w, box.h]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (viewRef.current.scale > 1) setView(FITTED);
      else onClose();
    };
    doc.addEventListener('keydown', onKeyDown, true);
    return () => doc.removeEventListener('keydown', onKeyDown, true);
  }, [doc, onClose]);

  /** Zooms to `scale`, keeping the spot under the pointer (clientX/Y) where it is. */
  const zoomAt = useCallback((scale: number, clientX: number, clientY: number) => {
    const el = stageRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = clientX - (r.left + r.width / 2);
    const cy = clientY - (r.top + r.height / 2);
    setView((v) => {
      const s = Math.min(MAX_ZOOM, Math.max(1, scale));
      if (s === 1) return FITTED;
      const k = s / v.scale;
      return clamp({ scale: s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }, fit.w, fit.h, r.width, r.height);
    });
  }, [fit.w, fit.h]);

  const onPointerDown = (e: ReactPointerEvent<HTMLImageElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLImageElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    if (!p.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    p.moved = true;
    if (!zoomed) return;
    setDragging(true);
    setView((v) => clamp({ scale: v.scale, x: p.vx + dx, y: p.vy + dy }, fit.w, fit.h, box.w, box.h));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLImageElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    setDragging(false);
    if (p.moved) return;
    if (zoomed) setView(FITTED);
    else zoomAt(CLICK_ZOOM, e.clientX, e.clientY);
  };

  const onPointerCancel = () => {
    press.current = null;
    setDragging(false);
  };

  const onWheel = (e: ReactWheelEvent) => {
    if (!fit.w) return;
    zoomAt(view.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
  };

  const cursor = dragging ? 'grabbing' : zoomed ? 'grab' : 'zoom-in';

  return createPortal(
    <div className="modal-backdrop media-lightbox" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <div className="media-lightbox-stage" ref={stageRef} onWheel={onWheel}>
        <img
          className="media-lightbox-img"
          src={url}
          alt={name}
          referrerPolicy="no-referrer"
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          style={{
            width: fit.w || undefined,
            height: fit.h || undefined,
            visibility: fit.w ? 'visible' : 'hidden',
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: dragging ? 'none' : 'transform 0.18s ease-out',
            cursor,
          }}
        />
      </div>
      <div className="media-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="media-lightbox-hint">{zoomed ? 'Drag to move · click or Esc to zoom out' : 'Click the picture to zoom'}</span>
        <button type="button" className="media-lightbox-close" autoFocus onClick={onClose}>
          Close
        </button>
      </div>
    </div>,
    host,
  );
}
