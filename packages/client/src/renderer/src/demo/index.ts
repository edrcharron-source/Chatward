// Demo mode entry. OWNER: demo-backend thread (stub exports below are the contract; keep signatures).
import { useSession } from '../state/session';

export const DEMO_URL = 'http://demo.chatward.local';

/** True while the app is running against the in-process mock backend. */
export function isDemo(): boolean {
  return useSession.getState().serverUrl === DEMO_URL;
}
/** Switch to demo: install network interceptors, fake sign-in as "You". */
export async function enterDemo(): Promise<void> { throw new Error('demo-backend not installed'); }
/** Leave demo: remove interceptors, log out, restore the previous server URL. */
export function exitDemo(): void {}
