/**
 * Geometry for a small floating player that sits over the app window: it can be dragged anywhere inside the window
 * and resized from its bottom-right corner, keeping the video's 16:9 shape. Pure functions only, so they can be tested
 * without the DOM. The React side is in useFloatingBox.ts.
 */

/** Top-left corner and width in window pixels. The height follows from the width (see boxHeight). */
export interface FloatBox { x: number; y: number; w: number }

/** The strip above the video that drags the box. */
export const BAR_HEIGHT = 26;
/** Gap kept between the box and the window's edges. */
export const EDGE = 8;
export const MIN_WIDTH = 200;
/** Widest the box may get, and never wider than the window allows. */
export const MAX_WIDTH = 720;
/** Starts in the bottom-right corner at this width. */
export const DEFAULT_WIDTH = 320;

/** Height of the whole box: the drag strip plus the 16:9 video. */
export function boxHeight(w: number): number {
  return w * 9 / 16 + BAR_HEIGHT;
}

/** The widest the box may be in a window this size: not wider than the window, nor taller than it. */
function maxWidth(vw: number, vh: number): number {
  const byHeight = (vh - EDGE * 2 - BAR_HEIGHT) * 16 / 9;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, vw - EDGE * 2, byHeight));
}

/** Keeps a box inside the window: width within its limits, and the whole box on screen. */
export function clampBox(b: FloatBox, vw: number, vh: number): FloatBox {
  const w = Math.round(Math.min(Math.max(b.w, MIN_WIDTH), maxWidth(vw, vh)));
  const h = boxHeight(w);
  const x = Math.round(Math.min(Math.max(b.x, EDGE), Math.max(EDGE, vw - w - EDGE)));
  const y = Math.round(Math.min(Math.max(b.y, EDGE), Math.max(EDGE, vh - h - EDGE)));
  return { x, y, w };
}

/** The bottom-right corner placement used until the box has been moved or resized. */
export function defaultBox(vw: number, vh: number): FloatBox {
  const w = Math.min(DEFAULT_WIDTH, maxWidth(vw, vh));
  return clampBox({ x: vw - w - 16, y: vh - boxHeight(w) - 16, w }, vw, vh);
}

/** The box after its drag strip moved by (dx, dy) from `start`. */
export function moveBox(start: FloatBox, dx: number, dy: number, vw: number, vh: number): FloatBox {
  return clampBox({ ...start, x: start.x + dx, y: start.y + dy }, vw, vh);
}

/** The box after its bottom-right corner moved by dx from `start`. The top-left corner stays put. */
export function resizeBox(start: FloatBox, dx: number, vw: number, vh: number): FloatBox {
  return clampBox({ ...start, w: start.w + dx }, vw, vh);
}

/** Reads a saved box from settings, or null when the saved value is missing or not usable. */
export function parseBox(v: unknown): FloatBox | null {
  if (!v || typeof v !== 'object') return null;
  const { x, y, w } = v as Record<string, unknown>;
  if (![x, y, w].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { x: x as number, y: y as number, w: w as number };
}
