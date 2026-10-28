import { api } from './http';
import { useSession } from '../state/session';

const RENEW_WHEN_LEFT_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;

/** When a token expires, in ms since the epoch. Null when the token has no readable expiry. */
function expiresAtMs(token: string): number | null {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const exp = (JSON.parse(atob(payload)) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch { return null; }
}

/** Swaps the token for a fresh 30-day one once it is within a week of expiring. */
export async function renewTokenIfDue() {
  const { token, user } = useSession.getState();
  if (!token || !user) return;
  const exp = expiresAtMs(token);
  if (exp === null || exp - Date.now() > RENEW_WHEN_LEFT_MS) return;
  try {
    const res = await api.post<{ token: string }>('/api/auth/refresh');
    useSession.getState().setAuth(res.token, user);
  } catch { /* offline: the next check tries again. A rejected token signs the user out in http.ts. */ }
}

/** Keeps the token fresh while the app is open. Returns a function that stops the checks. */
export function keepTokenFresh(): () => void {
  void renewTokenIfDue();
  const id = setInterval(() => void renewTokenIfDue(), CHECK_EVERY_MS);
  return () => clearInterval(id);
}
