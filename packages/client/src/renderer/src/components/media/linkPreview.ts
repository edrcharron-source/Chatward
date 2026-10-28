import type { LinkPreview } from '@chatward/shared';
import { api } from '../../api/http';
import { useSettings } from '../../state/settings';

const MAX_PREVIEWS = 3;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;
const YOUTUBE_ID = /^[\w-]{11}$/;
const TWEET_ID = /^\d{1,25}$/;

/** http(s) URLs in a message body, de-duplicated, in order of appearance. */
export function extractUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, '');
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' || url.protocol === 'https:') found.add(url.href);
    } catch {
      // Not a parseable URL; skip it.
    }
  }
  return [...found];
}

/** Recognises YouTube and X/Twitter links that get a click-to-load embed. */
function detectEmbed(url: string): LinkPreview['embed'] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^(www|m|mobile)\./, '');

  if (host === 'youtube.com' || host === 'youtu.be') {
    const id =
      host === 'youtu.be'
        ? parsed.pathname.slice(1).split('/')[0]
        : parsed.searchParams.get('v') ?? /^\/(?:embed|shorts|live)\/([\w-]+)/.exec(parsed.pathname)?.[1];
    return id && YOUTUBE_ID.test(id) ? { kind: 'youtube', id } : undefined;
  }

  if (host === 'twitter.com' || host === 'x.com') {
    const id = /^\/[^/]+\/status(?:es)?\/(\d+)/.exec(parsed.pathname)?.[1];
    return id && TWEET_ID.test(id) ? { kind: 'twitter', id } : undefined;
  }

  return undefined;
}

interface PreviewMeta {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

async function fetchPreview(url: string): Promise<LinkPreview | null> {
  const embed = detectEmbed(url);
  try {
    const meta = await api.get<PreviewMeta>(`/api/linkpreview?url=${encodeURIComponent(url)}`);
    const preview: LinkPreview = {
      url,
      title: meta.title,
      description: meta.description,
      siteName: meta.siteName,
      // The server embeds images as data URLs. Anything else is dropped so viewers never fetch third-party images.
      image: meta.image?.startsWith('data:image/') ? meta.image : undefined,
      embed,
    };
    return preview.title || preview.description || preview.image || embed ? preview : null;
  } catch {
    return embed ? { url, embed } : null;
  }
}

const THUMB_MAX_PX = 200;
const THUMB_QUALITY = 0.6;

/** Re-encodes a preview image as a small JPEG so it can fit the message size cap. Undefined if it cannot be decoded. */
export async function shrinkPreviewImage(dataUrl: string): Promise<string | undefined> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const scale = Math.min(1, THUMB_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', THUMB_QUALITY);
  } catch {
    return undefined;
  }
}

/** Sender-side: fetch previews via /api/linkpreview (max 3 urls), respecting settings.linkPreviews. Never throws. */
export async function buildLinkPreviews(urls: string[]): Promise<LinkPreview[]> {
  try {
    if (!useSettings.getState().linkPreviews) return [];
    const previews = await Promise.all(urls.slice(0, MAX_PREVIEWS).map(fetchPreview));
    return previews.filter((p): p is LinkPreview => p !== null);
  } catch {
    return [];
  }
}
