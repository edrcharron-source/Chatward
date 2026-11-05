// Small animated ASCII pieces for the Lebserver skin, in the style of lebai: a progress ring for Workouts and a
// sound meter on voice tiles. Decoration only (aria-hidden, no controls). Shown only while the Lebserver skin and
// Settings > Appearance > Animated backgrounds are on; they stop while the window is hidden and hold still under
// reduced motion.
import { useEffect, useState } from 'react';
import { useSettings } from '../../state/settings';
import './lebai.css';

/** True when the Lebserver skin's animated art should be drawn. */
export function useLebaiArt(): boolean {
  return useSettings((s) => s.skin === 'lebserver' && s.animatedBackgrounds);
}

/** Seconds since mount, updated about `fps` times a second while `on`; 0 forever under reduced motion. */
function useClock(on: boolean, fps = 12): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!on || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const start = performance.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      timer = null;
      if (document.hidden) return;
      setT((performance.now() - start) / 1000);
      timer = setTimeout(tick, 1000 / fps);
    };
    const onVisible = () => { if (!document.hidden && !timer) tick(); };
    document.addEventListener('visibilitychange', onVisible);
    tick();
    return () => { if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [on, fps]);
  return t;
}

type Cell = [ch: string, cls: string];
function rows(cells: Cell[][]) {
  return cells.map((row, y) => (
    <span key={y}>
      {row.map(([ch, cls], x) => (cls ? <span key={x} className={cls}>{ch}</span> : ch))}
      {'\n'}
    </span>
  ));
}

/** A ring of characters that fills clockwise with `done / planned`, the filled part shimmering slowly. */
export function AsciiRing({ done, planned, size = 9 }: { done: number; planned: number; size?: number }) {
  const t = useClock(true);
  const frac = planned > 0 ? Math.min(1, done / planned) : 0;
  const W = size * 4 + 5, H = size * 2 + 3;
  const cells: Cell[][] = [];
  for (let y = 0; y < H; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < W; x++) {
      const dx = (x - (W - 1) / 2) / 2, dy = y - (H - 1) / 2;
      if (Math.abs(Math.hypot(dx, dy) - size) >= 1.1) { row.push([' ', '']); continue; }
      const ang = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1;
      if (ang < frac) {
        const s = Math.sin(ang * 20 - t * 3);
        row.push([s > 0.3 ? '#' : '*', s > 0.6 ? 'lb-a3' : s > -0.2 ? 'lb-a2' : 'lb-a1']);
      } else row.push(['.', 'lb-a0']);
    }
    cells.push(row);
  }
  return <pre className="lb-ascii lb-ring" aria-hidden="true">{rows(cells)}</pre>;
}

const LEVELS = ' .:-=+*#%@';
/** A mirrored sound meter that moves while `active` (someone is talking) and rests as a flat line otherwise. */
export function AsciiMeter({ active, cols = 28, height = 7 }: { active: boolean; cols?: number; height?: number }) {
  const t = useClock(active);
  const mid = (height - 1) / 2;
  const cells: Cell[][] = [];
  for (let y = 0; y < height; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < cols; x++) {
      const amp = active ? 0.35 + 0.65 * Math.abs(Math.sin(x * 0.55 + t * 7) * Math.sin(x * 0.17 - t * 3)) : 0;
      const d = mid === 0 ? 0 : Math.abs(y - mid) / mid;
      if (active && d <= amp) row.push([LEVELS[Math.min(LEVELS.length - 1, Math.floor((1 - d / Math.max(amp, 0.01)) * LEVELS.length) + 2)], 'lb-a4']);
      else row.push([y === Math.round(mid) ? '-' : ' ', y === Math.round(mid) ? 'lb-a0' : '']);
    }
    cells.push(row);
  }
  return <pre className="lb-ascii lb-meter" aria-hidden="true">{rows(cells)}</pre>;
}
