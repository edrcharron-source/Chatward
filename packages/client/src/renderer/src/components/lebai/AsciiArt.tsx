// Small animated ASCII pieces for the Lebserver skin, in the style of lebai: a progress ring for Workouts and a
// sound meter on voice tiles that follows each person's real audio. Decoration only (aria-hidden, no controls).
// Shown only while the Lebserver skin and Settings > Appearance > Animated backgrounds are on; they stop while the window is hidden and hold still under
// reduced motion.
import { useEffect, useState } from 'react';
import { useSettings } from '../../state/settings';
import { voiceLevel } from '../../state/voiceAudio';
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

/** Turns a loudness reading (RMS, 0..1) into a meter height (0..1). Speech sits around 0.02-0.2 RMS. */
function meterAmp(rms: number): number {
  return rms < 0.004 ? 0 : Math.min(1, Math.sqrt(rms) * 2.4);
}

/**
 * The last `cols` loudness readings for one person in the call, newest last, taken about `fps` times a second while
 * `on`. Null while there is no audio to read for them (the meter then falls back to its drawn animation). Holds
 * still under reduced motion and while the window is hidden, and skips re-rendering while they are silent.
 */
function useLevelHistory(userId: string | undefined, local: boolean, on: boolean, cols: number, fps = 15): number[] | null {
  const [hist, setHist] = useState<number[] | null>(null);
  useEffect(() => {
    if (!on || !userId || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setHist(null);
      return;
    }
    let cur: number[] | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      timer = null;
      if (document.hidden) return;
      const rms = voiceLevel(userId, local);
      if (rms === null) {
        if (cur !== null) setHist((cur = null));
      } else {
        const prev = cur ?? new Array<number>(cols).fill(0);
        // jump up at once and ease down, so short words still read as a shape
        const amp = Math.max(meterAmp(rms), (prev[cols - 1] ?? 0) * 0.55);
        const next = amp < 0.02 ? 0 : amp;
        if (cur === null || next > 0 || prev.some((v) => v > 0)) setHist((cur = [...prev.slice(1), next]));
      }
      timer = setTimeout(tick, 1000 / fps);
    };
    const onVisible = () => { if (!document.hidden && !timer) tick(); };
    document.addEventListener('visibilitychange', onVisible);
    tick();
    return () => { if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [userId, local, on, cols, fps]);
  return hist;
}

/**
 * A mirrored sound meter for a voice tile. In a call it draws the person's real loudness over the last couple of
 * seconds, scrolling right to left (your own mic on your tile, their incoming audio on theirs). Where there is no
 * audio to read (the demo's call list before joining, say) it falls back to a drawn animation while `speaking`.
 * A flat line means silence, or that they are muted (`live` false).
 */
export function AsciiMeter({ speaking, userId, local = false, live = true, cols = 28, height = 7 }: {
  speaking: boolean; userId?: string; local?: boolean; live?: boolean; cols?: number; height?: number;
}) {
  const hist = useLevelHistory(userId, local, live, cols);
  const drawn = !hist && speaking;
  const t = useClock(drawn);
  const mid = (height - 1) / 2;
  const cells: Cell[][] = [];
  for (let y = 0; y < height; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < cols; x++) {
      const amp = hist ? hist[x] : drawn ? 0.35 + 0.65 * Math.abs(Math.sin(x * 0.55 + t * 7) * Math.sin(x * 0.17 - t * 3)) : 0;
      const d = mid === 0 ? 0 : Math.abs(y - mid) / mid;
      if (amp > 0 && d <= amp) row.push([LEVELS[Math.min(LEVELS.length - 1, Math.floor((1 - d / Math.max(amp, 0.01)) * LEVELS.length) + 2)], 'lb-a4']);
      else row.push([y === Math.round(mid) ? '-' : ' ', y === Math.round(mid) ? 'lb-a0' : '']);
    }
    cells.push(row);
  }
  return <pre className="lb-ascii lb-meter" aria-hidden="true">{rows(cells)}</pre>;
}
