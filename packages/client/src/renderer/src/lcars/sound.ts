import { useSettings } from '../state/settings';

// Synthesised console chirp, same approach as notify.ts (no asset files).
let ctx: AudioContext | null = null;

export function playLcarsBeep() {
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t0);
    osc.frequency.exponentialRampToValueAtTime(1320, t0 + 0.06);
    const level = 0.06 * useSettings.getState().soundVolume;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(level, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.13);
  } catch {
    // Audio can be unavailable (no output device); the beep is decoration, so fail silently.
  }
}

/** Plays a beep on any button or choice press while the LCARS skin and beeps are both on. */
export function installLcarsBeeps(): () => void {
  function onClick(e: MouseEvent) {
    const { uiStyle, lcarsBeeps } = useSettings.getState();
    if (uiStyle !== 'lcars' || !lcarsBeeps) return;
    const target = e.target as Element | null;
    if (target?.closest('button, [role="button"], .choice')) playLcarsBeep();
  }
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
