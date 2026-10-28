import { signOut, useSession } from '../state/session';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// A request that never gets an answer would leave the screen waiting forever, so each one gives up after this long.
const DEFAULT_TIMEOUT_MS = 20_000;
// Uploads and downloads of files can take much longer on a slow connection, so they get a wider limit.
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

async function req<T>(method: string, path: string, body?: unknown, opts: { raw?: BodyInit; contentType?: string; timeoutMs?: number } = {}): Promise<T> {
  const { serverUrl, token } = useSession.getState();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (opts.raw !== undefined) { payload = opts.raw; headers['Content-Type'] = opts.contentType ?? 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const res = await fetch(serverUrl.replace(/\/$/, '') + path, { method, headers, body: payload, signal });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
    // Sign out only if the refused token is still the current one. A password change swaps in a new token, so requests still in flight with the old one fail without ending the session.
    if (res.status === 401 && token && useSession.getState().token === token) void signOut();
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? res.json() : res.arrayBuffer()) as Promise<T>;
}

/** A JSON POST that the browser keeps going while the window unloads. Fire and forget: the page may be gone before it answers. */
export function postOnUnload(path: string, body: unknown): void {
  const { serverUrl, token } = useSession.getState();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  void fetch(serverUrl.replace(/\/$/, '') + path, { method: 'POST', headers, body: JSON.stringify(body), keepalive: true }).catch(() => {});
}

export const api = {
  get: <T>(path: string) => req<T>('GET', path),
  post: <T>(path: string, body?: unknown, timeoutMs?: number) => req<T>('POST', path, body ?? {}, { timeoutMs }),
  patch: <T>(path: string, body: unknown) => req<T>('PATCH', path, body),
  del: <T>(path: string, body?: unknown) => req<T>('DELETE', path, body),
  /** raw-bytes upload (encrypted blobs, avatars, sounds) */
  putRaw: <T>(method: 'POST' | 'PUT', path: string, bytes: BodyInit, contentType: string) =>
    req<T>(method, path, undefined, { raw: bytes, contentType, timeoutMs: TRANSFER_TIMEOUT_MS }),
  /** GET bytes (needs auth header, so can't be a plain <img src>) */
  getBytes: (path: string) => req<ArrayBuffer>('GET', path, undefined, { timeoutMs: TRANSFER_TIMEOUT_MS }),
};

/** Fetch an authed image/audio and return an object URL (caller revokes when done). */
export async function fetchObjectUrl(path: string, mime?: string): Promise<string> {
  const buf = await api.getBytes(path);
  return URL.createObjectURL(new Blob([buf], mime ? { type: mime } : undefined));
}
