// Spotify "listening to": sign-in and the currently playing track, run in the main process so tokens never reach the page.
// Uses Spotify's authorization-code flow with PKCE, which needs no client secret. The client ID comes from the build
// (SPOTIFY_CLIENT_ID in CI); a build without one says Spotify isn't set up. Only the refresh token is saved, encrypted.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { shell } from 'electron';

const CLIENT_ID = __SPOTIFY_CLIENT_ID__;
// Must match the Redirect URI saved in the Spotify app's settings exactly.
const PORT = 43821;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'user-read-currently-playing';
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const TIMEOUT_MS = 8000;
export const SPOTIFY_TOKEN_STORE = 'spotifyRefreshToken';

export interface SpotifyTrack { title: string; artist: string; url?: string }
export type NowPlaying =
  | { ok: true; track: SpotifyTrack | null }
  | { ok: false; error: string; signedOut?: boolean };

export interface TokenStore {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let access: { token: string; expiresAt: number } | null = null;
let pendingSignIn: Promise<void> | null = null;

export function spotifyStatus(store: TokenStore) {
  return { available: !!CLIENT_ID, connected: !!CLIENT_ID && !!store.get(SPOTIFY_TOKEN_STORE) };
}

export function disconnectSpotify(store: TokenStore) {
  access = null;
  store.remove(SPOTIFY_TOKEN_STORE);
}

/** Opens Spotify's sign-in page in the browser and waits for it to come back to 127.0.0.1. */
export function connectSpotify(store: TokenStore): Promise<void> {
  if (!CLIENT_ID) return Promise.reject(new Error('This Chatward build has no Spotify app set up.'));
  // A second click while the browser is open reuses the same sign-in instead of fighting over the port.
  pendingSignIn ??= signIn(store).finally(() => { pendingSignIn = null; });
  return pendingSignIn;
}

async function signIn(store: TokenStore) {
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const code = await new Promise<string>((resolve, reject) => {
    let server: Server | null = null;
    const finish = (err: Error | null, value?: string) => {
      clearTimeout(timer);
      server?.close();
      if (err) reject(err); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Spotify sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS);
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const ok = url.searchParams.get('state') === state && !!url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Chatward</title><body style="font-family:sans-serif;padding:40px">${
        ok ? 'Spotify is connected. You can close this tab and go back to Chatward.' : 'Spotify sign-in did not finish. Go back to Chatward and try again.'}</body>`);
      if (ok) finish(null, url.searchParams.get('code')!);
      else finish(new Error(url.searchParams.get('error') === 'access_denied' ? 'Spotify sign-in was cancelled.' : 'Spotify sign-in did not finish. Try again.'));
    });
    server.on('error', () => finish(new Error(`Could not listen on port ${PORT} for the Spotify sign-in. Close other copies of Chatward and try again.`)));
    server.listen(PORT, '127.0.0.1', () => {
      const auth = new URL('https://accounts.spotify.com/authorize');
      auth.search = new URLSearchParams({
        client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI, scope: SCOPE,
        code_challenge_method: 'S256', code_challenge: challenge, state,
      }).toString();
      void shell.openExternal(auth.toString());
    });
  });
  await tokenRequest(store, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
}

async function tokenRequest(store: TokenStore, params: Record<string, string>) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    // invalid_grant: the saved sign-in was revoked or expired, so the person has to connect again.
    if (body.error === 'invalid_grant') disconnectSpotify(store);
    throw Object.assign(new Error(res.status === 403
      ? 'Spotify refused this account. Ask the Chatward owner to add your Spotify email to the app.'
      : 'Spotify sign-in failed. Try connecting again.'), { signedOut: body.error === 'invalid_grant' });
  }
  access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - 60_000 };
  // Spotify may hand out a new refresh token each time; the old one then stops working.
  if (body.refresh_token) store.set(SPOTIFY_TOKEN_STORE, body.refresh_token);
}

async function accessToken(store: TokenStore): Promise<string> {
  if (access && access.expiresAt > Date.now()) return access.token;
  const refresh = store.get(SPOTIFY_TOKEN_STORE);
  if (!refresh) throw Object.assign(new Error('Spotify is not connected.'), { signedOut: true });
  await tokenRequest(store, { grant_type: 'refresh_token', refresh_token: refresh });
  return access!.token;
}

const TRACK_URL = /^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]{1,64}$/;

/** The track playing right now on any of the person's Spotify devices, or null when nothing is playing. */
export async function nowPlaying(store: TokenStore): Promise<NowPlaying> {
  if (!CLIENT_ID) return { ok: false, error: 'This Chatward build has no Spotify app set up.' };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: `Bearer ${await accessToken(store)}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401 && attempt === 0) { access = null; continue; }
      if (res.status === 204) return { ok: true, track: null };
      if (res.status === 403) return { ok: false, error: 'Spotify refused this account. Ask the Chatward owner to add your Spotify email to the app.' };
      if (!res.ok) return { ok: false, error: `Spotify answered ${res.status}.` };
      const body = (await res.json()) as {
        is_playing?: boolean; currently_playing_type?: string;
        item?: { name?: string; artists?: { name?: string }[]; external_urls?: { spotify?: string } } | null;
      };
      const item = body.item;
      if (!body.is_playing || body.currently_playing_type !== 'track' || !item?.name) return { ok: true, track: null };
      const url = item.external_urls?.spotify;
      return { ok: true, track: {
        title: item.name,
        artist: (item.artists ?? []).map((a) => a.name).filter(Boolean).join(', '),
        ...(url && TRACK_URL.test(url) ? { url } : {}),
      } };
    }
    return { ok: false, error: 'Spotify sign-in expired. Connect again.', signedOut: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not reach Spotify.', signedOut: !!(err as { signedOut?: boolean }).signedOut };
  }
}

// Spotify's share sheet copies short links (spotify.link/<code>, which redirects to spotify.app.link/<code>).
// The page behind one names what it points at; for a Jam that is a socialsession link.
const SHORT_LINK_HOSTS = ['spotify.link', 'spotify.app.link'];
const JAM_IN_PAGE = /https:\/\/(?:open\.spotify\.com|spotify\.app\.link)\/socialsession\/([A-Za-z0-9]{1,64})/;
const PAGE_MAX_CHARS = 300_000;

export const isSpotifyShortLink = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && SHORT_LINK_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
};

/** The Jam a Spotify short link points at (https://open.spotify.com/socialsession/<id>), or null if it is something else. */
export async function resolveJamLink(raw: string): Promise<string | null> {
  if (!isSpotifyShortLink(raw)) return null;
  try {
    // Follow redirects by hand so the app only ever talks to Spotify's own short-link hosts.
    let url = raw;
    for (let hop = 0; hop < 3; hop++) {
      const jam = url.match(JAM_IN_PAGE);
      if (jam) return `https://open.spotify.com/socialsession/${jam[1]}`;
      if (!isSpotifyShortLink(url)) return null;
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const next = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && next) { url = new URL(next, url).href; continue; }
      if (!res.ok) return null;
      const page = (await res.text()).slice(0, PAGE_MAX_CHARS).match(JAM_IN_PAGE);
      return page ? `https://open.spotify.com/socialsession/${page[1]}` : null;
    }
    return null;
  } catch {
    return null;
  }
}
