/**
 * Whether this app is in use right now: its window is showing and focused, and it was touched, clicked or typed in
 * within the last few minutes. The server holds back phone notifications for chat only while one of your apps is in
 * use, so leaving the desktop app open (or the phone app in the background) no longer stops the phone from buzzing.
 */
const IDLE_MS = 3 * 60_000;

let lastInput = Date.now();
let last: boolean | null = null;
const listeners = new Set<(active: boolean) => void>();

export function isAppActive(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState !== 'visible') return false;
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  return Date.now() - lastInput < IDLE_MS;
}

/** Calls `cb` whenever isAppActive() changes. */
export function onAppActiveChange(cb: (active: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function check() {
  const now = isAppActive();
  if (now === last) return;
  last = now;
  for (const cb of listeners) cb(now);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const input = () => {
    const wasIdle = Date.now() - lastInput >= IDLE_MS;
    lastInput = Date.now();
    if (wasIdle || last === false) check();
  };
  for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) window.addEventListener(e, input, { capture: true, passive: true });
  window.addEventListener('focus', () => { lastInput = Date.now(); check(); });
  window.addEventListener('blur', check);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) lastInput = Date.now(); check(); });
  window.addEventListener('pagehide', check);
  setInterval(check, 30_000);
}
