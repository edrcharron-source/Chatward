// Demo-mode GIF search through KLIPY, run in the main process so the API key never reaches the renderer's network stack.
// Mirrors packages/server/src/modules/gifs.ts; the key comes from the secure store, not the environment.

const KLIPY_BASE = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;
const TIMEOUT_MS = 5000;

export interface GifResult { id: string; url: string; previewUrl: string; title: string; width: number; height: number }
type KlipyItem = Record<string, unknown>;
type FileSet = Record<string, Record<string, unknown> | undefined>;
type KlipyResponse = { result?: unknown; data?: { data?: unknown; has_next?: unknown } };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A file entry is either a direct URL string or an object carrying one. */
const fileUrl = (v: unknown): string | null => str(v) ?? str((v as { url?: unknown } | undefined)?.url);
const fileDim = (v: unknown, key: 'width' | 'height'): number => num((v as Record<string, unknown> | undefined)?.[key]);

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

/** Names the fields of the first item, so a mismatch shows in the GIF tab instead of an empty result. */
function shapeOf(item: KlipyItem): string {
  const files = item.files ?? item.file;
  const fileKeys = files && typeof files === 'object' ? Object.keys(files).join(',') : 'none';
  return `item keys: ${Object.keys(item).join(',')}; file keys: ${fileKeys}`;
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

  // A body without the expected list is a schema mismatch. Report it so the tab shows an error, not "No GIFs found".
  if (!Array.isArray(body.data?.data)) return { status: 502, body: { error: 'unexpected KLIPY response' } };
  const items = body.data.data as KlipyItem[];
  const results = items.map(toResult).filter((r): r is GifResult => r !== null);
  if (items.length > 0 && results.length === 0) {
    return { status: 502, body: { error: `unexpected KLIPY response (${shapeOf(items[0])})` } };
  }
  return { status: 200, body: body.data?.has_next === true ? { results, next: String(page + 1) } : { results } };
}
