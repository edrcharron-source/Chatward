// The app's icons. Each skin has its own set: solid shapes for the Original look, sharp "blueprint" lines for Lebserver
// and chunky 16 x 16 pixel art for Retro ASCII. Every icon carries all three and icons.css shows the active skin's one,
// so a skin change (and a popped-out window, which copies the skin) needs no re-render. Icons take the current text colour.
import './icons.css';
import { BLUEPRINT } from './blueprintIcons';
import { CHUNKY } from './chunkyIcons';
import { SOLID } from './solidIcons';
import type { IconName, VectorIcon } from './iconTypes';

export type PixelIconName = IconName;

/** Builds the markup for one vector icon, punching its `cut` shapes out through a mask with id `maskId`. */
function vectorMarkup(icon: VectorIcon, maskId: string): string {
  if (!icon.cut) return icon.body + (icon.over ?? '');
  return `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">`
    + `<rect width="24" height="24" fill="#fff" stroke="none"/>${icon.cut}</mask>`
    + `<g mask="url(#${maskId})">${icon.body}</g>${icon.over ?? ''}`;
}

/** Turns a pixel grid into two path strings: full pixels and half-tone ones. */
function pixelPaths(rows: string[]): { full: string; half: string } {
  let full = '';
  let half = '';
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '#') full += `M${x} ${y}h1v1h-1z`;
    else if (ch === '+') half += `M${x} ${y}h1v1h-1z`;
  }));
  return { full, half };
}

const markup = new Map<IconName, { solid: string; blueprint: string; chunky: { full: string; half: string } }>();

function iconMarkup(name: IconName) {
  let m = markup.get(name);
  if (!m) {
    m = {
      solid: vectorMarkup(SOLID[name], `cw-ic-s-${name}`),
      blueprint: vectorMarkup(BLUEPRINT[name], `cw-ic-b-${name}`),
      chunky: pixelPaths(CHUNKY[name]),
    };
    markup.set(name, m);
  }
  return m;
}

export default function PixelIcon({ name, size = 16 }: { name: PixelIconName; size?: number }) {
  const m = iconMarkup(name);
  // The markup is the fixed icon data above, never user input.
  return (
    <svg className="cw-pixel-icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <g className="cw-ic-solid" dangerouslySetInnerHTML={{ __html: m.solid }} />
      <g className="cw-ic-blueprint" dangerouslySetInnerHTML={{ __html: m.blueprint }} />
      <svg className="cw-ic-chunky" viewBox="0 0 16 16" width="24" height="24" shapeRendering="crispEdges">
        <path d={m.chunky.full} fill="currentColor" />
        {m.chunky.half && <path d={m.chunky.half} fill="currentColor" opacity={0.42} />}
      </svg>
    </svg>
  );
}
