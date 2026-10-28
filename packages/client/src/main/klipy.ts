// Demo-mode GIF search through KLIPY, run in the main process so the API key never reaches the renderer's network stack.
// Mirrors packages/server/src/modules/gifs.ts; the key comes from the secure store, not the environment.

const KLIPY_BASE = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;
const TIMEOUT_MS = 5000;

export interface GifResult { id: string; url: string; previewUrl: string; title: string; width: number; height: number }
type Variant = { url?: unknown; width?: unknown; height?: unknown };
type KlipyItem = { slug?: unknown; id?: unknown; title?: unknown; width?: unknown; height?: unknown; files?: Record<string, Record<string, Variant | undefined> | undefined> };
type KlipyResponse = { result?: unknown; data?: { data?: unknown; has_next?: unknown } };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

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

/** `null` when no key is configured, so the caller can fall back to placeholders. */
export async function searchGifs(
  key: string | null,
  kind: 'search' | 'trending',
  q: string,
  pos: string | undefined,
): Promise<{ status: number; body: unknown } | null> {
  if (!key) return null;
  const page = Math.min(10_000, Math.max(1, parseInt(pos ?? '1', 10) || 1));
  const url = new URL(`${KLIPY_BASE}/${encodeURIComponent(key)}/gifs/${kind}`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(PER_PAGE));
  if (kind === 'search') url.searchParams.set('q', q);

  let body: KlipyResponse;
  try {
    const upstream = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!upstream.ok) throw new Error(`klipy ${upstream.status}`);
    body = (await upstream.json()) as KlipyResponse;
  } catch {
    // Never echo the upstream URL: it contains the API key.
    return { status: 502, body: { error: 'gif provider unavailable' } };
  }
  if (body.result === false) return { status: 502, body: { error: 'gif provider unavailable' } };

  const items = Array.isArray(body.data?.data) ? (body.data!.data as KlipyItem[]) : [];
  const results = items.map(toResult).filter((r): r is GifResult => r !== null);
  return { status: 200, body: body.data?.has_next === true ? { results, next: String(page + 1) } : { results } };
}
