// YouTube link parsing and the embed's postMessage protocol.
// We drive the embed directly instead of loading the IFrame API script, so the CSP (script-src 'self') stays as it is.

export const YT_ORIGIN = 'https://www.youtube-nocookie.com';

export const VIDEO_ID = /^[\w-]{11}$/;

export interface YouTubeLink {
  videoId: string;
  /** seconds, from a t= or start= parameter; 0 when absent */
  start: number;
}

/** Parses watch, youtu.be, embed, shorts and live links. Returns null for anything else. */
export function parseYouTubeUrl(input: string): YouTubeLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.replace(/^(www|m)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.slice(1);
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      id = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] ?? null;
    }
  } else {
    return null;
  }
  if (!id || !VIDEO_ID.test(id)) return null;
  return { videoId: id, start: parseStart(url.searchParams.get('t') ?? url.searchParams.get('start')) };
}

/** Accepts plain seconds ("90") or YouTube's "1h2m3s" form. */
function parseStart(raw: string | null): number {
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function embedSrc(videoId: string): string {
  return `${YT_ORIGIN}/embed/${videoId}?enablejsapi=1&playsinline=1&rel=0`;
}

interface InfoDelivery { currentTime: number; playerState: number; playbackRate: number }

export type PlayerEvent =
  | { kind: 'ready' }
  | { kind: 'info'; currentTime: number; playing: boolean; rate: number };

/** playerState 1 = playing, 3 = buffering; buffering counts as playing so it does not look like a pause. */
const isPlayingState = (state: number) => state === 1 || state === 3;

/** Listens to one embed. Returns an unbind function. Call again with the new iframe when the src changes. */
export function bindPlayer(frame: HTMLIFrameElement, onEvent: (e: PlayerEvent) => void): () => void {
  const listen = () => frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening' }), YT_ORIGIN);

  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || e.origin !== YT_ORIGIN) return;
    const data = parse(e.data);
    if (!data) return;
    if (data.event === 'onReady') onEvent({ kind: 'ready' });
    const info = data.event === 'infoDelivery' ? (data.info as Partial<InfoDelivery> | undefined) : undefined;
    if (info && typeof info.currentTime === 'number' && typeof info.playerState === 'number') {
      onEvent({ kind: 'info', currentTime: info.currentTime, playing: isPlayingState(info.playerState), rate: info.playbackRate ?? 1 });
    }
  };

  window.addEventListener('message', onMessage);
  frame.addEventListener('load', listen);
  listen();
  return () => {
    window.removeEventListener('message', onMessage);
    frame.removeEventListener('load', listen);
  };
}

export function sendCommand(frame: HTMLIFrameElement | null, func: string, args: unknown[] = []): void {
  frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), YT_ORIGIN);
}

function parse(raw: unknown): { event?: string; info?: Record<string, unknown> } | null {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? (raw as { event?: string }) : null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as { event?: string }) : null;
  } catch {
    return null;
  }
}
