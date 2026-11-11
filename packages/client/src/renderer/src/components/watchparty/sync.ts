// Shared playback state: what it means, how it is encoded for the wire, and how a playhead is projected forward.
import type { MessagePayload } from '@chatward/shared';
import { VIDEO_ID } from './youtube';

/** Set by whichever member last changed playback. Encrypted with the channel key before it leaves the device. */
export interface WatchState {
  videoId: string | null; // YouTube id; null with no url means the party is stopped
  /** https link to a video file (mp4/webm); set instead of videoId for file playback */
  url?: string | null;
  /** Jellyfin item id (32 hex); each viewer asks the server for their own ticket, so no credential is shared */
  jellyfinId?: string | null;
  /** Vault video: its item id plus the file key, so each viewer downloads and decrypts it themselves */
  vault?: VaultFile | null;
  /** display name of the current item (Jellyfin items have no readable id) */
  title?: string | null;
  /** items waiting after the current one, played in order */
  queue?: QueueItem[];
  /** how many items have started in this party; lets the clients agree on who already advanced the queue */
  n?: number;
  playing: boolean;
  /** seconds into the video at the moment the change was made */
  position: number;
  rate: number;
}

/**
 * A Vault video. The key and iv open the encrypted file. They ride inside the watch state, which is itself encrypted
 * with the server's channel key, the same way a Vault item shared in chat carries its keys.
 */
export interface VaultFile {
  id: string;
  key: string;
  iv: string;
  mime: string;
}

/** One entry in the shared queue. `ref` is a YouTube id, an https file url, a Jellyfin item id or a Vault item id, by `kind`. */
export interface QueueItem {
  kind: 'youtube' | 'url' | 'jellyfin' | 'vault';
  ref: string;
  title?: string;
  /** kind 'vault' only: what opens the file */
  vault?: Omit<VaultFile, 'id'>;
}

export const QUEUE_MAX = 50;
const JELLYFIN_ID = /^[0-9a-f]{32}$/i;
const VAULT_ID = /^[0-9a-z]{9,32}$/;
const B64 = /^[A-Za-z0-9+/=_-]{0,64}$/;
const VIDEO_MIME = /^video\/[a-z0-9.+-]{1,40}$/i;

/** A well-formed Vault file reference, or null. */
function parseVaultFile(raw: unknown): VaultFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== 'string' || !VAULT_ID.test(v.id)) return null;
  if (typeof v.key !== 'string' || !B64.test(v.key) || typeof v.iv !== 'string' || !B64.test(v.iv)) return null;
  if (typeof v.mime !== 'string' || !VIDEO_MIME.test(v.mime)) return null;
  return { id: v.id, key: v.key, iv: v.iv, mime: v.mime };
}

/** The queue item that plays a Vault video. */
export const vaultItem = (f: VaultFile, title?: string): QueueItem =>
  ({ kind: 'vault', ref: f.id, title: title?.trim().slice(0, 120) || undefined, vault: { key: f.key, iv: f.iv, mime: f.mime } });

const cleanTitle = (t: unknown): string | undefined => (typeof t === 'string' && t.trim() ? t.trim().slice(0, 120) : undefined);

function parseQueueItem(raw: unknown): QueueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ref !== 'string') return null;
  const title = cleanTitle(r.title);
  if (r.kind === 'youtube') return VIDEO_ID.test(r.ref) ? { kind: 'youtube', ref: r.ref, title } : null;
  if (r.kind === 'url') { const u = parseVideoUrl(r.ref); return u ? { kind: 'url', ref: u, title } : null; }
  if (r.kind === 'jellyfin') return JELLYFIN_ID.test(r.ref) ? { kind: 'jellyfin', ref: r.ref.toLowerCase(), title } : null;
  if (r.kind === 'vault') {
    const f = parseVaultFile({ ...(r.vault && typeof r.vault === 'object' ? r.vault : {}), id: r.ref });
    return f ? vaultItem(f, title) : null;
  }
  return null;
}

/**
 * The queue with the item at `from` moved to index `to`. Returns null when nothing would change, or when the item at
 * `from` is no longer `ref` (someone else changed the queue mid-drag), so a stale drag never moves the wrong thing.
 */
export function moveQueueItem(queue: QueueItem[], from: number, to: number, ref: string): QueueItem[] | null {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length || queue[from].ref !== ref) return null;
  const next = queue.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** The state that starts playing `item` from `position`, carrying the rest of the queue. */
export function stateForItem(item: QueueItem, rest: QueueItem[], n: number, rate = 1, position = 0): WatchState {
  return {
    videoId: item.kind === 'youtube' ? item.ref : null,
    url: item.kind === 'url' ? item.ref : null,
    jellyfinId: item.kind === 'jellyfin' ? item.ref : null,
    vault: item.kind === 'vault' && item.vault ? { id: item.ref, ...item.vault } : null,
    title: item.title ?? null,
    queue: rest, n, playing: true, position, rate,
  };
}

/** A state plus the server ms timestamp it was accepted at. */
export interface StampedState extends WatchState {
  ts: number;
}

/** The one thing being watched: a YouTube id, a file url, a Jellyfin id or a Vault id, null when stopped. */
export const mediaKey = (s: { videoId: string | null; url?: string | null; jellyfinId?: string | null; vault?: VaultFile | null } | null | undefined): string | null =>
  s?.videoId ?? s?.url ?? s?.jellyfinId ?? s?.vault?.id ?? null;

/** Returns the https URL for a playable video file link, or null. */
export function parseVideoUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    return u.protocol === 'https:' && u.href.length <= 2000 ? u.href : null;
  } catch {
    return null;
  }
}

export const RATE_MIN = 0.25;
export const RATE_MAX = 2;
/** Drift beyond this is corrected with a seek. Smaller drift is not visible, and seeking costs a rebuffer. */
export const DRIFT_SECONDS = 0.5;
/** A local jump this big that we did not cause is treated as the user seeking. */
export const SEEK_SECONDS = 1.5;

/** Where playback should be at `now` (same clock as `anchor.at`). */
export function playhead(anchor: { position: number; at: number; playing: boolean; rate: number }, now: number): number {
  if (!anchor.playing) return anchor.position;
  return anchor.position + (Math.max(0, now - anchor.at) / 1000) * anchor.rate;
}

export function encodeState(state: WatchState): MessagePayload {
  // Rides in the message payload's text field so it gets the same channel-key encryption and AAD as chat messages.
  return { text: JSON.stringify({ v: 1, ...state }) };
}

/** Returns null for anything that is not a well-formed state, so a bad or hostile payload is ignored. */
export function decodeState(payload: MessagePayload): WatchState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload.text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const videoId = s.videoId === null ? null : typeof s.videoId === 'string' ? s.videoId : undefined;
  if (videoId === undefined || (videoId !== null && !VIDEO_ID.test(videoId))) return null;
  const url = s.url === undefined || s.url === null ? null : typeof s.url === 'string' ? parseVideoUrl(s.url) : undefined;
  if (url === undefined || (s.url != null && url === null) || (videoId && url)) return null;
  const jellyfinId = s.jellyfinId == null ? null : typeof s.jellyfinId === 'string' && JELLYFIN_ID.test(s.jellyfinId) ? s.jellyfinId.toLowerCase() : undefined;
  if (jellyfinId === undefined || (jellyfinId && (videoId || url))) return null;
  const vault = s.vault == null ? null : parseVaultFile(s.vault) ?? undefined;
  if (vault === undefined || (vault && (videoId || url || jellyfinId))) return null;
  const queue: QueueItem[] = [];
  if (s.queue !== undefined) {
    if (!Array.isArray(s.queue) || s.queue.length > QUEUE_MAX) return null;
    for (const raw of s.queue) { const it = parseQueueItem(raw); if (!it) return null; queue.push(it); }
  }
  const n = typeof s.n === 'number' && Number.isInteger(s.n) && s.n >= 0 ? s.n : 0;
  if (typeof s.playing !== 'boolean') return null;
  if (typeof s.position !== 'number' || !Number.isFinite(s.position) || s.position < 0) return null;
  if (typeof s.rate !== 'number' || !Number.isFinite(s.rate)) return null;
  return {
    videoId,
    url,
    jellyfinId,
    vault,
    title: cleanTitle(s.title) ?? null,
    queue,
    n,
    playing: s.playing,
    position: s.position,
    rate: Math.min(RATE_MAX, Math.max(RATE_MIN, s.rate)),
  };
}
