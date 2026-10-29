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
