import { useEffect, useState } from 'react';
import './orbit.css';

/**
 * Pieces of the Orbit layout (see docs/SKINS.md, "Orbit"). The Orbit layout is the tabs layout with a different frame:
 * TabsLayout draws the same tab bar, panes, member list and call controls, and adds these around them:
 *
 * - OrbitBackdrop, the faint line-art drawing (circles, an eight-point and a six-point star, a ring of ticks, a thin
 *   frame round the window) behind everything;
 * - OrbitMark, the small emblem before the server's name;
 * - OrbitWindowButtons, minimize, maximize and close at the end of the top bar, which is the window's title bar while
 *   this layout is on screen (orbit.css hides the app's usual one).
 *
 * All of the artwork is drawn here in code.
 */

const C = { x: 560, y: 430 };

function ring(r: number, n: number, turn: number): Array<[number, number]> {
  return Array.from({ length: n }, (_, i) => {
    const a = ((turn + (360 * i) / n) * Math.PI) / 180;
    return [C.x + r * Math.cos(a), C.y + r * Math.sin(a)];
  });
}
const f = (n: number) => n.toFixed(1);
const polygon = (p: Array<[number, number]>) => `M${p.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L')} Z`;
/** Joins every point to the one `step` places on, which draws a star. */
const star = (p: Array<[number, number]>, step: number) =>
  p.map(([x, y], i) => { const [x2, y2] = p[(i + step) % p.length]; return `M${f(x)} ${f(y)} L${f(x2)} ${f(y2)}`; }).join(' ');

const OCT = ring(330, 8, -90);
const OCT_TURNED = ring(330, 8, -67.5);
const HEX = ring(200, 6, -90);
const SPOKES = ring(330, 12, -90).map(([x, y]) => `M${C.x} ${C.y} L${f(x)} ${f(y)}`).join(' ');
const MARKERS = OCT.map(([x, y]) => `M${f(x)} ${f(y - 5)} l5 5 -5 5 -5 -5 Z`).join(' ');

export function OrbitBackdrop() {
  return (
    <svg className="orbit-backdrop" viewBox="0 0 1280 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <filter id="orbit-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves={4} seed={7} />
          <feColorMatrix values="0 0 0 0 0.6  0 0 0 0 0.65  0 0 0 0 0.75  0 0 0 0.09 0" />
        </filter>
        <radialGradient id="orbit-glow" cx={C.x / 1280} cy={C.y / 800} r="0.55">
          <stop offset="0" className="orbit-glow-stop" stopOpacity="1" />
          <stop offset="1" className="orbit-glow-stop" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect className="orbit-grain" width="1280" height="800" filter="url(#orbit-grain)" />
      <rect width="1280" height="800" fill="url(#orbit-glow)" className="orbit-glow" />
      <g className="orbit-lines" fill="none" stroke="currentColor" strokeWidth="1">
        <circle cx={C.x} cy={C.y} r="330" strokeOpacity=".16" />
        <circle cx={C.x} cy={C.y} r="212" strokeOpacity=".14" />
        <circle cx={C.x} cy={C.y} r="200" strokeOpacity=".12" />
        <circle cx={C.x} cy={C.y} r="206" strokeOpacity=".16" strokeWidth="7" strokeDasharray="1 5" />
        <circle cx={C.x} cy={C.y} r="120" strokeOpacity=".12" />
        <circle cx={C.x} cy={C.y} r="460" strokeOpacity=".06" />
        <path d={polygon(OCT)} strokeOpacity=".1" />
        <path d={star(OCT, 3)} strokeOpacity=".12" />
        <path d={star(OCT_TURNED, 2)} strokeOpacity=".07" />
        <path d={star(HEX, 2)} strokeOpacity=".13" />
        <path d={SPOKES} strokeOpacity=".05" />
        <path d={`M0 ${C.y} H1280 M${C.x} 0 V800`} strokeOpacity=".05" />
        <path d={MARKERS} strokeOpacity=".35" />
      </g>
    </svg>
  );
}

/** The emblem before the server's name: a ring, a triangle and a small circle. */
export function OrbitMark() {
  return (
    <svg className="orbit-mark" viewBox="0 0 30 30" width="26" height="26" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="15" cy="15" r="13" /><path d="M15 5 L24 21 L6 21 Z" /><circle cx="15" cy="16" r="3" />
      </g>
    </svg>
  );
}

/** Whether the window is maximized, kept up to date as it is resized. */
function useMaximized(): boolean {
  const controls = window.chatward?.windowControls;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!controls) return;
    const check = () => { void controls.isMaximized().then(setMaximized, () => {}); };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [controls]);
  return maximized;
}

/** Minimize, maximize and close at the end of the top bar. Without the desktop app's bridge, or on macOS (which draws its own), there are none. */
export function OrbitWindowButtons() {
  const controls = window.chatward?.windowControls;
  const maximized = useMaximized();
  if (!controls || controls.platform === 'darwin') return null;
  return (
    <div className="orbit-window">
      <button type="button" className="orbit-win" aria-label="Minimize" title="Minimize" tabIndex={-1} onClick={() => controls.minimize()}>
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M4 12h16" /></svg>
      </button>
      <button type="button" className="orbit-win" aria-label={maximized ? 'Restore' : 'Maximize'} title={maximized ? 'Restore' : 'Maximize'} tabIndex={-1}
        onClick={() => controls.toggleMaximize()}>
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path d={maximized ? 'M8 4h12v12M4 8h12v12H4z' : 'M4 4h16v16H4z'} />
        </svg>
      </button>
      <button type="button" className="orbit-win close" aria-label="Close" title="Close" tabIndex={-1} onClick={() => controls.close()}>
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" /></svg>
      </button>
    </div>
  );
}
