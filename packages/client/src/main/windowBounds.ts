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

/** How round each corner of a shaped window is, in pixels. 0 leaves that corner square. */
export interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

/** How far in from the side row `row` (counted from the corner's edge) of a round corner starts. */
function cornerInset(radius: number, row: number): number {
  if (row >= radius) return 0;
  const dy = radius - (row + 0.5);
  // The first pixel whose centre is inside the curve, so the edge never shows the window behind the frame's colour.
  return Math.max(0, Math.ceil(radius - Math.sqrt(radius * radius - dy * dy) - 0.5));
}

/**
 * The window's outline as rectangles (BrowserWindow.setShape takes rectangles, not curves): one per run of rows
 * that start and end at the same place, so the round corners become small steps and the middle is one big block.
 * Each radius is capped at half the window's smaller side.
 */
export function roundedShape(width: number, height: number, radii: CornerRadii): Area[] {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (!w || !h) return [];
  const cap = (r: number) => Math.max(0, Math.min(Math.floor(Number.isFinite(r) ? r : 0), Math.floor(Math.min(w, h) / 2)));
  const tl = cap(radii.topLeft), tr = cap(radii.topRight), bl = cap(radii.bottomLeft), br = cap(radii.bottomRight);
  const rects: Area[] = [];
  for (let y = 0; y < h; ) {
    const fromBottom = h - 1 - y;
    const left = Math.max(cornerInset(tl, y), cornerInset(bl, fromBottom));
    const right = Math.max(cornerInset(tr, y), cornerInset(br, fromBottom));
    let end = y + 1;
    while (end < h) {
      const fb = h - 1 - end;
      if (Math.max(cornerInset(tl, end), cornerInset(bl, fb)) !== left || Math.max(cornerInset(tr, end), cornerInset(br, fb)) !== right) break;
      end++;
    }
    rects.push({ x: left, y, width: Math.max(0, w - left - right), height: end - y });
    y = end;
  }
  return rects;
}
