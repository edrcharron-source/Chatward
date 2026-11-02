export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSize {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

/**
 * Fits a window inside a display's work area (the part not covered by the taskbar). A window larger than the area
 * shrinks to it, and the minimum size shrinks with it so the window can still be resized down to the area.
 */
export function fitWindow(work: Area, want: WindowSize): Area & { minWidth: number; minHeight: number } {
  const width = Math.min(want.width, work.width);
  const height = Math.min(want.height, work.height);
  return {
    x: work.x + Math.round((work.width - width) / 2),
    y: work.y + Math.round((work.height - height) / 2),
    width,
    height,
    minWidth: Math.min(want.minWidth, width),
    minHeight: Math.min(want.minHeight, height),
  };
}

/** Which edge or corner of the window is being dragged to resize it. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export function isResizeEdge(value: unknown): value is ResizeEdge {
  return typeof value === 'string' && ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].includes(value);
}

/**
 * The window's bounds after dragging `edge` by (dx, dy) from where it was when the drag started. The opposite edge stays
 * put, and the window never gets smaller than its minimum size (the dragged edge stops instead).
 */
export function resizeBounds(start: Area, edge: ResizeEdge, dx: number, dy: number, min: { width: number; height: number }): Area {
  let { x, y, width, height } = start;
  if (edge.includes('e')) width = Math.max(min.width, start.width + dx);
  if (edge.includes('s')) height = Math.max(min.height, start.height + dy);
  if (edge.includes('w')) { width = Math.max(min.width, start.width - dx); x = start.x + start.width - width; }
  if (edge.includes('n')) { height = Math.max(min.height, start.height - dy); y = start.y + start.height - height; }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
