import { useSettings } from '../../state/settings';

/**
 * Keeps the desktop window in step with the layout setting: the LCARS layout gets the shaped window (transparent, no
 * system border or shadow, so only the frame shows) and every other layout the usual one. The main process moves the
 * page to a window of the right kind when they differ (without reloading it), so this only does something when the
 * layout changes or the saved choice was lost.
 */
export function syncShapedWindow(): void {
  const controls = window.chatward?.windowControls;
  if (!controls?.setShaped || controls.platform === 'darwin') return;
  let last: boolean | undefined;
  const sync = (layout: string) => {
    const want = layout === 'lcars';
    if (want === last) return;
    last = want;
    controls.setShaped(want);
  };
  sync(useSettings.getState().layout);
  useSettings.subscribe((s) => sync(s.layout));
}
