import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Express } from 'express';
import type { LinkPreview } from '@chatward/shared';
import type { Ctx } from '../ctx.js';

const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_IMAGE_DATA_URL = 300 * 1024;
// Raw bytes that keep the base64 data URL under MAX_IMAGE_DATA_URL.
const MAX_IMAGE_BYTES = 220 * 1024;
const REDIRECT_CODES = [301, 302, 303, 307, 308];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Target was refused by the SSRF policy (scheme, credentials, or a non-public address). */
class BlockedError extends Error {}
/** Upstream failed: timeout, bad redirect, network error. */
class FetchError extends Error {}

function isBlockedV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19));
}

function isBlockedAddress(address: string): boolean {
  if (net.isIPv4(address)) return isBlockedV4(address);
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    // Mapped (::ffff:), NAT64 (64:ff9b::) and deprecated IPv4-compatible (::x) forms can all smuggle private IPv4.
    return a.startsWith('::') || a.startsWith('::ffff:') || a.startsWith('64:ff9b:') ||
      /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff') || a.startsWith('2001:db8:');
  }
  return true;
}

/** Resolves a hostname and refuses if ANY answer is non-public, so a mixed record can't sneak through. */
async function resolvePublic(hostname: string): Promise<{ address: string; family: number }> {
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) throw new BlockedError('address not allowed');
  return addresses[0];
}

type Response = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean };

/** One request pinned to an already-validated address, so DNS cannot change between check and connect. */
async function fetchOnce(url: URL, maxBytes: number, accept: string): Promise<Response> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BlockedError('scheme not allowed');
  const target = await resolvePublic(url.hostname.replace(/^\[|\]$/g, ''));
  const client = url.protocol === 'https:' ? https : http;

  return new Promise<Response>((resolve, reject) => {
    const req = client.get(url, {
      headers: { 'User-Agent': 'ChatwardLinkPreview/1.0', Accept: accept, 'Accept-Encoding': 'identity' },
      lookup: (_host: string, _opts: unknown, cb: (err: null, address: string, family: number) => void) => cb(null, target.address, target.family),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).subarray(0, maxBytes), truncated });
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        chunks.push(chunk);
        if (size > maxBytes) { truncated = true; res.destroy(); }
      });
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** GET with manual redirects; every hop is re-validated by fetchOnce. */
async function safeGet(start: URL, maxBytes: number, accept: string): Promise<Response & { finalUrl: URL }> {
  let url = start;
  for (let hop = 0; ; hop++) {
    const res = await fetchOnce(url, maxBytes, accept);
    if (!REDIRECT_CODES.includes(res.status)) return { ...res, finalUrl: url };
    const location = res.headers.location;
    if (!location || hop >= MAX_REDIRECTS) throw new FetchError('bad redirect');
    url = new URL(location, url);
  }
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const cp = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  }).trim();
}

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function parseMeta(html: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs = parseAttrs(tag);
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, decodeEntities(attrs.content));
  }
  return meta;
}

function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/** Fetches og:image and embeds it as a data URL. Returns undefined on any problem; a preview is never worth failing for. */
async function fetchImage(src: string, base: URL): Promise<string | undefined> {
  try {
    const { status, body, truncated } = await safeGet(new URL(src, base), MAX_IMAGE_BYTES, 'image/png,image/jpeg,image/webp,image/gif');
    if (status !== 200 || truncated) return undefined;
    const mime = sniffImage(body);
    if (!mime) return undefined;
    const dataUrl = `data:${mime};base64,${body.toString('base64')}`;
    return dataUrl.length <= MAX_IMAGE_DATA_URL ? dataUrl : undefined;
  } catch {
    return undefined;
  }
}

export function register(app: Express, ctx: Ctx): void {
  // Sender-side only: the sending client fetches here and embeds the result in the encrypted message.
  app.get('/api/linkpreview', ctx.requireAuth, async (req, res) => {
    const raw = typeof req.query.url === 'string' ? req.query.url : '';
    if (!raw || raw.length > 2048) { res.status(400).json({ error: 'url required' }); return; }
    let url: URL;
    try { url = new URL(raw); } catch { res.status(400).json({ error: 'invalid url' }); return; }

    try {
      const page = await safeGet(url, MAX_HTML_BYTES, 'text/html,application/xhtml+xml');
      const contentType = String(page.headers['content-type'] ?? '');
      if (page.status < 200 || page.status >= 300 || !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        res.json({ url: raw });
        return;
      }

      const html = page.body.toString('utf8');
      const meta = parseMeta(html);
      const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 64 * 1024))?.[1];
      const imageSrc = meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image');

      const out: LinkPreview = { url: raw };
      const title = meta.get('og:title') ?? meta.get('twitter:title') ?? (titleTag ? decodeEntities(titleTag) : undefined);
      const description = meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description');
      const siteName = meta.get('og:site_name');
      if (title) out.title = title.slice(0, 300);
      if (description) out.description = description.slice(0, 500);
      if (siteName) out.siteName = siteName.slice(0, 100);
      if (imageSrc) {
        const image = await fetchImage(imageSrc, page.finalUrl);
        if (image) out.image = image;
      }
      res.json(out);
    } catch (err) {
      if (err instanceof BlockedError) res.status(400).json({ error: 'url not allowed' });
      else res.status(502).json({ error: 'could not fetch page' });
    }
  });
}
