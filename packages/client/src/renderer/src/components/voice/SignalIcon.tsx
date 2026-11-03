// The call's connection signal: a wifi-style icon with three bars and a dot. Each skin shows its own icon style (the same
// three sets as the rest of the app: solid for Original, blueprint lines for Lebserver, chunky pixels for Retro ASCII).
// The bars light up with the latency, and hovering or focusing the icon shows the latency in ms.
import { useEffect, useState, type PointerEvent, type FocusEvent } from 'react';
import type { Room } from 'livekit-client';
import './SignalIcon.css';

/** Lit bars for a latency: all three under 30 ms, two up to 60 ms, one beyond that. */
export function signalLevel(ms: number | null): { bars: 0 | 1 | 2 | 3; color: string; text: string } {
  if (ms === null) return { bars: 0, color: 'var(--text-muted, #888)', text: 'Measuring…' };
  const text = `${Math.round(ms)} ms`;
  if (ms <= 30) return { bars: 3, color: '#3ba55d', text };
  if (ms <= 60) return { bars: 2, color: '#f0b232', text };
  return { bars: 1, color: '#ed4245', text };
}

/** The room's signalling round-trip time, read every two seconds while connected. Null until the first reply. */
export function useRoomPing(room: Room | null): number | null {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    if (!room) {
      setMs(null);
      return;
    }
    const read = () => {
      const rtt = room.engine?.client?.rtt;
      setMs(typeof rtt === 'number' && rtt > 0 ? rtt : null);
    };
    read();
    const timer = setInterval(read, 2000);
    return () => clearInterval(timer);
  }, [room]);
  return ms;
}

// Solid (Original): round strokes on a 24 x 24 grid. The bars are arcs at 45 degrees either side of straight up.
// The dot sits at (12, 20). Bar radii are 5.5, 9.9 and 14.3; the ends are at 45 degrees either side.
const SOLID_BARS = [
  'M8.11 16.11 A5.5 5.5 0 0 1 15.89 16.11',
  'M5 13 A9.9 9.9 0 0 1 19 13',
  'M1.89 9.89 A14.3 14.3 0 0 1 22.11 9.89',
];

// Blueprint (Lebserver): straight, square-capped chevrons on a 24 x 24 grid.
const BLUEPRINT_BARS = [
  'M8.11 16.11 L12 14.5 L15.89 16.11',
  'M5 13 L12 10.1 L19 13',
  'M1.89 9.89 L12 5.7 L22.11 9.89',
];

// Chunky (Retro ASCII): a 16 x 16 pixel grid. 1, 2, 3 are the bars (inner to outer), 0 is the dot.
const CHUNKY_ROWS = [
  '................',
  '................',
  '....33333333....',
  '..333333333333..',
  '.3333......3333.',
  '333...2222...333',
  '.3..22222222..3.',
  '..222222222222..',
  '...22......22...',
  '.....111111.....',
  '....11111111....',
  '.....1....1.....',
  '......0000......',
  '................',
  '................',
  '................',
];

function pixelPath(bar: string): string {
  let d = '';
  CHUNKY_ROWS.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === bar) d += `M${x} ${y}h1v1h-1z`;
  }));
  return d;
}

const CHUNKY_PATHS = { 1: pixelPath('1'), 2: pixelPath('2'), 3: pixelPath('3'), 0: pixelPath('0') };

/** Bars are numbered 1 (inner) to 3 (outer). A bar is lit when `bars` is at least its number. */
export default function SignalIcon({ bars, color, size = 18 }: { bars: 0 | 1 | 2 | 3; color: string; size?: number }) {
  const lit = (n: number) => (bars >= n ? undefined : 'off');
  return (
    <svg className="cw-signal" style={{ color }} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g className="cw-sig-solid">
        {SOLID_BARS.map((d, i) => (
          <path key={i} className={`cw-sig-bar ${lit(i + 1) ?? ''}`} d={d} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
        ))}
        <circle className="cw-sig-bar" cx="12" cy="20" r="2.5" fill="currentColor" />
      </g>
      <g className="cw-sig-blueprint">
        {BLUEPRINT_BARS.map((d, i) => (
          <path key={i} className={`cw-sig-bar ${lit(i + 1) ?? ''}`} d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" />
        ))}
        <rect className="cw-sig-bar" x="10" y="18" width="4" height="4" fill="currentColor" />
      </g>
      <g className="cw-sig-chunky" shapeRendering="crispEdges" transform="scale(1.5)">
        {([1, 2, 3] as const).map((n) => (
          <path key={n} className={`cw-sig-bar ${lit(n) ?? ''}`} d={CHUNKY_PATHS[n]} fill="currentColor" />
        ))}
        <path className="cw-sig-bar" d={CHUNKY_PATHS[0]} fill="currentColor" />
      </g>
    </svg>
  );
}

/** Height of the latency popup plus its gap, used to decide whether it fits below the icon. */
const POPUP_ROOM = 40;
/** Width of the popup, used to decide whether it should hang inward from the right edge. */
const POPUP_WIDTH = 96;

/**
 * The icon with its latency popup. The popup opens below the icon, unless there isn't room under it on screen
 * (LCARS keeps its voice controls at the bottom of the window), in which case it opens above. Near the right edge it
 * lines up to the icon's right side instead, so it never runs off screen.
 */
export function SignalButton({ bars, color, text }: { bars: 0 | 1 | 2 | 3; color: string; text: string }) {
  const [place, setPlace] = useState({ up: false, right: false });
  const measure = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const up = window.innerHeight - rect.bottom < POPUP_ROOM;
    const right = rect.left + POPUP_WIDTH > window.innerWidth;
    setPlace((prev) => (prev.up === up && prev.right === right ? prev : { up, right }));
  };
  const onEnter = (e: PointerEvent<HTMLSpanElement>) => measure(e.currentTarget);
  const onFocus = (e: FocusEvent<HTMLSpanElement>) => measure(e.currentTarget);
  const cls = ['cw-signal-wrap', place.up ? 'cw-signal-up' : '', place.right ? 'cw-signal-right' : ''].filter(Boolean).join(' ');
  return (
    <span className={cls} onPointerEnter={onEnter} onFocus={onFocus}>
      <button type="button" className="cw-signal-btn" aria-label={`Connection: ${text}`}>
        <SignalIcon bars={bars} color={color} />
      </button>
      <span className="cw-signal-pop" role="tooltip">{text}</span>
    </span>
  );
}
