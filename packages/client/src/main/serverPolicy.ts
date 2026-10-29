// Which servers the app's page may connect to. The page is served from app://, and the main process attaches a
// Content-Security-Policy that names the server the user connected to. A policy only applies to a page as it loads,
// so changing server reloads the page.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_ORIGIN = 'app://chatward';

const FILE = 'server-origin.txt';

/** Reduces a typed server address to "scheme://host[:port]". Null when it is not an http or https address. */
export function serverOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * connect-src lets the page reach itself and the server's host, on any port: LiveKit (voice) runs on its own port of
 * the same host in both the cloud and PC-only setups. Without a server, the page reaches only itself. Everything else
 * stays as before, since images, previews and embeds were never limited to one server.
 */
export function buildCsp(origin: string | null): string {
  const connect = ["'self'", 'blob:'];
  if (origin) {
    const u = new URL(origin);
    const ws = u.protocol === 'https:' ? 'wss' : 'ws';
    connect.push(`${u.protocol}//${u.hostname}:*`, `${ws}://${u.hostname}:*`);
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://klipy.com https://*.klipy.com",
    "media-src 'self' blob: data: https:",
    `connect-src ${connect.join(' ')}`,
    'frame-src https://www.youtube-nocookie.com https://platform.twitter.com https://twitframe.com https://*.twitter.com https://*.x.com',
    "worker-src 'self' blob:",
  ].join('; ');
}

/** The server origin saved by an earlier run, so the first page load of a launch already has the right policy. */
export function loadServerOrigin(dir: string): string | null {
  try {
    return readFileSync(join(dir, FILE), 'utf8') || null;
  } catch {
    return null;
  }
}

export function saveServerOrigin(dir: string, origin: string | null): void {
  writeFileSync(join(dir, FILE), origin ?? '');
}
