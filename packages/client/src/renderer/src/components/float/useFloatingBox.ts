import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

/**
 * The corner previews (the watch party while its tab is left, and a voice screen share while the Voice tab is left).
 * Each one is a box in the window that can be dragged by its top strip and resized from its corner. The position and
 * width are remembered per preview, and the box is kept inside the window, also when the window is resized.
 * The height always follows the 16:9 picture, so the video is never letterboxed inside the box.
 */

const MARGIN = 16;
const DEFAULT_W = 320;
const MIN_W = 200;
const MAX_W = 640;
export const FLOAT_ASPECT = 9 / 16;
/** how far the pointer has to move before a press counts as a drag, so plain clicks still reach the buttons */
const DRAG_START = 4;

export interface FloatBox { x: number; y: number; w: number }

/** Keeps a box's width in range for the window, and its position inside the window. */
function fit(b: FloatBox): FloatBox {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxW = Math.max(MIN_W, Math.min(MAX_W, vw - 2 * MARGIN));
  const w = Math.min(Math.max(b.w, MIN_W), maxW);
  const h = w * FLOAT_ASPECT;
  const x = Math.min(Math.max(b.x, 0), Math.max(0, vw - w));
  const y = Math.min(Math.max(b.y, 0), Math.max(0, vh - h));
  return { x, y, w };
}

function corner(c: 'br' | 'bl'): FloatBox {
  const w = DEFAULT_W;
  const h = w * FLOAT_ASPECT;
  return fit({
    x: c === 'br' ? window.innerWidth - w - MARGIN : MARGIN,
    y: window.innerHeight - h - MARGIN,
    w,
  });
}

function load(key: string): FloatBox | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<FloatBox> | null;
    if (v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.w === 'number') return { x: v.x, y: v.y, w: v.w };
  } catch {
    // no storage (private window, blocked): the default place is used
  }
  return null;
}

function save(key: string, b: FloatBox): void {
  try {
    localStorage.setItem(key, JSON.stringify(b));
  } catch {
    // the box still works for this session without it being remembered
  }
}

export interface FloatingBoxHandlers {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
}

/**
 * `start` is the corner the box sits in before it has been moved: 'br' bottom-right or 'bl' bottom-left.
 * Returns the style to place the box, and handlers for its drag strip (`move`) and its resize corner (`resize`).
 */
export function useFloatingBox(id: string, start: 'br' | 'bl') {
  const key = `cw-float:${id}`;
  const [box, setBox] = useState<FloatBox>(() => fit(load(key) ?? corner(start)));
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onResize = () => setBox((b) => fit(b));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // a drag still running when the preview goes away must not keep listening
  useEffect(() => () => stop.current?.(), []);

  const begin = (mode: 'move' | 'resize') => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const origin = fit(load(key) ?? corner(start));
    let last: FloatBox | null = null;
    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!last && Math.hypot(dx, dy) < DRAG_START) return;
      const next = fit(mode === 'move'
        ? { x: origin.x + dx, y: origin.y + dy, w: origin.w }
        : { x: origin.x, y: origin.y, w: origin.w + dx });
      last = next;
      setBox(next);
    };
    const end = () => {
      stop.current?.();
      if (last) save(key, last);
    };
    const detach = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      stop.current = null;
    };
    stop.current = detach;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const style: CSSProperties = { left: box.x, top: box.y, width: box.w, height: box.w * FLOAT_ASPECT };
  return {
    style,
    move: { onPointerDown: begin('move') } satisfies FloatingBoxHandlers,
    resize: { onPointerDown: begin('resize') } satisfies FloatingBoxHandlers,
  };
}
