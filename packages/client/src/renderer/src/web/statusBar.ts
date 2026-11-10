/** Keeps the phone's status bar the same colour as the app's top bar. The web build's theme-color tag sets the colour
 *  of the iPhone status bar (and the Android address bar), so it is updated whenever the skin or light/dark changes.
 *  Some skins make the bar a little see-through over the page, so the colour is worked out as it looks on screen. */
export function syncStatusBarColour(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const apply = () => {
    const colour = topBarColour();
    if (colour && meta.content !== colour) meta.content = colour;
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin'] });
}

function rgba(css: string): [number, number, number, number] | null {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a = '1'] = m[1].split(/[,\s/]+/).filter(Boolean);
  return [Number(r), Number(g), Number(b), Number(a)];
}

/** The top bar's background (--bg-1) laid over the page background, as an opaque #rrggbb. */
function topBarColour(): string {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;background:var(--bg-1)';
  document.body.appendChild(probe);
  const bar = rgba(getComputedStyle(probe).backgroundColor);
  probe.remove();
  const page = rgba(getComputedStyle(document.body).backgroundColor) ?? [0, 0, 0, 1];
  if (!bar) return '';
  const a = bar[3];
  const mix = [0, 1, 2].map((i) => Math.round(bar[i] * a + page[i] * (1 - a)));
  return `#${mix.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
