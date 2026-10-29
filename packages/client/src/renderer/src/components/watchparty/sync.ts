// Shared playback state: what it means, how it is encoded for the wire, and how a playhead is projected forward.
import type { MessagePayload } from '@chatward/shared';
import { VIDEO_ID } from './youtube';

/** Set by whichever member last changed playback. Encrypted with the channel key before it leaves the device. */
export interface WatchState {
  videoId: string | null; // YouTube id; null with no url means the party is stopped
  /** https link to a video file (mp4/webm); set instead of videoId for file playback */
  url?: string | null;
  playing: boolean;
  /** seconds into the video at the moment the change was made */
  position: number;
  rate: number;
}

/** A state plus the server ms timestamp it was accepted at. */
export interface StampedState extends WatchState {
  ts: number;
}

/** The one thing being watched: a YouTube id or a file url, null when stopped. */
export const mediaKey = (s: { videoId: string | null; url?: string | null } | null | undefined): string | null =>
  s?.videoId ?? s?.url ?? null;

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
  if (typeof s.playing !== 'boolean') return null;
  if (typeof s.position !== 'number' || !Number.isFinite(s.position) || s.position < 0) return null;
  if (typeof s.rate !== 'number' || !Number.isFinite(s.rate)) return null;
  return {
    videoId,
    url,
    playing: s.playing,
    position: s.position,
    rate: Math.min(RATE_MAX, Math.max(RATE_MIN, s.rate)),
  };
}
