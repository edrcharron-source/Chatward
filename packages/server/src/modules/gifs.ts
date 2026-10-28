import type { Express } from 'express';
import type { Ctx } from '../ctx.js';

const KLIPY_BASE = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;
const QUERY_MAX = 100;
const PAGE_MAX = 10_000;
const TIMEOUT_MS = 5000;

type GifResult = { id: string; url: string; previewUrl: string; title: string; width: number; height: number };
type Variant = { url?: unknown; width?: unknown; height?: unknown };
type KlipyItem = { slug?: unknown; id?: unknown; title?: unknown; width?: unknown; height?: unknown; files?: Record<string, Record<string, Variant | undefined> | undefined> };
type KlipyResponse = { result?: unknown; data?: { data?: unknown; has_next?: unknown } };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Maps a KLIPY item to our shape. Field names follow KLIPY's documented `files.{hd,md,sm}.{gif,webp,mp4}` layout. */
function toResult(item: KlipyItem): GifResult | null {
  const files = item.files ?? {};
  const full = files.hd ?? files.md ?? files.sm;
  const small = files.sm ?? files.xs ?? full;
  const url = str(full?.gif?.url) ?? str(full?.webp?.url);
  if (!url) return null;
  const previewUrl = str(small?.webp?.url) ?? str(small?.gif?.url) ?? url;
  const id = str(item.slug) ?? str(item.id);
  if (!id) return null;
  return {
    id,
    url,
    previewUrl,
    title: str(item.title) ?? '',
    width: num(full?.gif?.width) || num(item.width),
    height: num(full?.gif?.height) || num(item.height),
  };
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

    const items = Array.isArray(body.data?.data) ? (body.data!.data as KlipyItem[]) : [];
    const results = items.map(toResult).filter((r): r is GifResult => r !== null);
    res.json(body.data?.has_next === true ? { results, next: String(page + 1) } : { results });
  }

  app.get('/api/gifs/search', ctx.requireAuth, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > QUERY_MAX) { res.status(400).json({ error: `q must be at most ${QUERY_MAX} characters` }); return; }
    if (!key) { res.json({ results: [], disabled: true }); return; }
    if (!q) { res.json({ results: [] }); return; }
    void proxy('search', q, req.query.pos, res);
  });

  app.get('/api/gifs/trending', ctx.requireAuth, (req, res) => {
    void proxy('trending', null, req.query.pos, res);
  });
}
