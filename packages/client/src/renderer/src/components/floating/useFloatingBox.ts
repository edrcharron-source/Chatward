import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { clampBox, defaultBox, moveBox, resizeBox, type FloatBox } from './floatingBox';

/** Pointer movement under this many pixels is a click, not a drag. */
const DRAG_SLOP = 4;

interface Drag { mode: 'move' | 'resize'; x: number; y: number; start: FloatBox; moved: boolean }

function viewport() {
  return { vw: window.innerWidth, vh: window.innerHeight };
}

/**
 * A floating box's place and size, with pointer handlers for its drag strip (`move`) and its corner grip (`resize`).
 * `saved` is the place the user left it (null = the default corner). The box follows the pointer while it is dragged
 * and saves once the pointer is let go, so settings are written once per gesture.
 *
 * Usage: spread `bar` on the drag strip and `grip` on the corner handle. After a drag, `consumeDrag()` returns true
 * once, so a click at the end of a drag does not also count as a click.
 */
export function useFloatingBox(saved: FloatBox | null, save: (b: FloatBox) => void) {
  const [vp, setVp] = useState(viewport);
  const [live, setLive] = useState<FloatBox | null>(null);
  const liveRef = useRef<FloatBox | null>(null);
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    const onResize = () => setVp(viewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Keep the box on screen when the window shrinks, and fall back to the corner when nothing is saved.
  const base = clampBox(saved ?? defaultBox(vp.vw, vp.vh), vp.vw, vp.vh);
  const box = live ?? base;

  const start = (mode: Drag['mode']) => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: base, moved: false };
  };

  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    d.moved = true;
    const next = d.mode === 'move'
      ? moveBox(d.start, dx, dy, vp.vw, vp.vh)
      : resizeBox(d.start, dx, vp.vw, vp.vh);
    liveRef.current = next;
    setLive(next);
  };

  const end = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d?.moved && liveRef.current) {
      dragged.current = true;
      save(liveRef.current);
    }
    liveRef.current = null;
    setLive(null);
  };

  const consumeDrag = () => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  };

  const handlers = (mode: Drag['mode']) => ({
    onPointerDown: start(mode),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  });

  return { box, bar: handlers('move'), grip: handlers('resize'), consumeDrag };
}
