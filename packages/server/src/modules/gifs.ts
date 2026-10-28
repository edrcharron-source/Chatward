import type { Express } from 'express';
import type { Ctx } from '../ctx.js';
import { perMember } from '../userLimit.js';

const KLIPY_BASE = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;
const QUERY_MAX = 100;
const PAGE_MAX = 10_000;
const TIMEOUT_MS = 5000;

type GifResult = { id: string; url: string; previewUrl: string; title: string; width: number; height: number };
type KlipyItem = Record<string, unknown>;
type FileSet = Record<string, Record<string, unknown> | undefined>;
type KlipyResponse = { result?: unknown; data?: { data?: unknown; has_next?: unknown } };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A file entry is either a direct URL string or an object carrying one. */
const fileUrl = (v: unknown): string | null => str(v) ?? str((v as { url?: unknown } | undefined)?.url);
const fileDim = (v: unknown, key: 'width' | 'height'): number => num((v as Record<string, unknown> | undefined)?.[key]);

/** Maps a KLIPY item to our shape. Field names follow KLIPY's documented `files.{hd,md,sm}.{gif,webp,mp4}` layout. */
function toResult(item: KlipyItem): GifResult | null {
  const files = (item.files ?? item.file ?? {}) as FileSet;
  const full = files.hd ?? files.md ?? files.sm;
  const small = files.sm ?? files.xs ?? full;
  const url = fileUrl(full?.gif) ?? fileUrl(full?.webp);
  if (!url) return null;
  const previewUrl = fileUrl(small?.webp) ?? fileUrl(small?.gif) ?? url;
  const id = str(item.slug) ?? str(item.id) ?? (typeof item.id === 'number' ? String(item.id) : null);
  if (!id) return null;
  return {
    id,
    url,
    previewUrl,
    title: str(item.title) ?? '',
    width: fileDim(full?.gif, 'width') || num(item.width),
    height: fileDim(full?.gif, 'height') || num(item.height),
  };
}

/** Names the first item's fields in the error, so a mismatch is visible in the GIF tab. */
function shapeOf(item: KlipyItem): string {
  const files = item.files ?? item.file;
  const fileKeys = files && typeof files === 'object' ? Object.keys(files).join(',') : 'none';
  return `item keys: ${Object.keys(item).join(',')}; file keys: ${fileKeys}`;
}

export function register(app: Express, ctx: Ctx): void {
  const key = ctx.config.klipyApiKey;

  async function proxy(kind: 'search' | 'trending', q: string | null, pos: unknown, res: import('express').Response): Promise<void> {
    if (!key) { res.json({ results: [], disabled: true }); return; }

    const page = Math.min(PAGE_MAX, Math.max(1, parseInt(typeof pos === 'string' ? pos : '1', 10) || 1));
    const url = new URL(`${KLIPY_BASE}/${encodeURIComponent(key)}/gifs/${kind}`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(PER_PAGE));
    if (q !== null) url.searchParams.set('q', q);

    let body: KlipyResponse;
    try {
      const upstream = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!upstream.ok) throw new Error(`klipy ${upstream.status}`);
      body = (await upstream.json()) as KlipyResponse;
    } catch {
      // Never echo the upstream URL: it contains the API key.
      res.status(502).json({ error: 'gif provider unavailable' });
      return;
    }
    if (body.result === false) { res.status(502).json({ error: 'gif provider unavailable' }); return; }

    if (!Array.isArray(body.data?.data)) { res.status(502).json({ error: 'unexpected KLIPY response' }); return; }
    const items = body.data.data as KlipyItem[];
    const results = items.map(toResult).filter((r): r is GifResult => r !== null);
    if (items.length > 0 && results.length === 0) { res.status(502).json({ error: `unexpected KLIPY response (${shapeOf(items[0])})` }); return; }
    res.json(body.data?.has_next === true ? { results, next: String(page + 1) } : { results });
  }

  app.get('/api/gifs/search', ctx.requireAuth, perMember(60_000, 60), (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > QUERY_MAX) { res.status(400).json({ error: `q must be at most ${QUERY_MAX} characters` }); return; }
    if (!key) { res.json({ results: [], disabled: true }); return; }
    if (!q) { res.json({ results: [] }); return; }
    void proxy('search', q, req.query.pos, res);
  });

  app.get('/api/gifs/trending', ctx.requireAuth, perMember(60_000, 60), (req, res) => {
    void proxy('trending', null, req.query.pos, res);
  });
}
