import type { VaultAlbum, VaultAlbumMeta, VaultAnnotation, VaultDescriptor, VaultItem, VaultNotes } from '@chatward/shared';
import { api, ApiError } from '../../api/http';
import { readPhotoFacts, stripGps } from './exif';
import { decryptBlob, decryptMessage, encryptBlob, encryptPayload } from '../../crypto';

const THUMB_EDGE = 320;
const THUMB_QUALITY = 0.8;

export interface VaultPage { items: VaultItem[]; hasMore: boolean; usedBytes: number; quotaBytes: number; maxBytes: number }

const toBlob = (c: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make a thumbnail"))), 'image/webp', THUMB_QUALITY));

function drawThumb(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const scale = Math.min(1, THUMB_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return toBlob(canvas);
}

/** Loads the first moments of a video to get its size, length and a still frame. */
async function videoInfo(file: File): Promise<{ w: number; h: number; durationSec: number; thumb: Blob }> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error("Couldn't read that video"));
    });
    v.currentTime = Math.min(1, (v.duration || 1) / 2);
    await new Promise<void>((resolve) => { v.onseeked = () => resolve(); });
    return { w: v.videoWidth, h: v.videoHeight, durationSec: Math.round(v.duration || 0), thumb: await drawThumb(v, v.videoWidth, v.videoHeight) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/** Longest edge of the preview shown in the viewer. The original is only downloaded for Save. */
const PREVIEW_EDGE = 1600;
const PREVIEW_QUALITY = 0.82;
/** Below this size and edge, the original is already light enough to show as it is. */
const PREVIEW_SKIP_BYTES = 600 * 1024;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A file read and cleaned up for the Vault, before anything is encrypted or sent. */
export interface VaultReady {
  file: File;
  /** The bytes that will be stored: the file itself, minus location data for JPEG photos. */
  bytes: Uint8Array;
  sha256: string;
  takenAt?: number;
  takenAtSource?: 'exif' | 'file';
  camera?: string;
  gpsRemoved: boolean;
}

/** Reads a photo or video, removes location from JPEGs, and fingerprints it so repeats can be spotted. */
export async function readForVault(file: File): Promise<VaultReady> {
  if (!file.type.startsWith('video/') && !file.type.startsWith('image/')) throw new Error(`${file.name} is not a photo or video.`);
  let bytes: Uint8Array = await bytesOf(file);
  let gpsRemoved = false;
  let facts: { takenAt?: number; camera?: string } = {};
  if (file.type === 'image/jpeg') {
    facts = readPhotoFacts(bytes);
    const clean = stripGps(bytes);
    bytes = clean.bytes;
    gpsRemoved = clean.removed;
  }
  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  const fromFile = file.lastModified || undefined;
  return {
    file, bytes, sha256, camera: facts.camera, gpsRemoved,
    takenAt: facts.takenAt ?? fromFile,
    takenAtSource: facts.takenAt ? 'exif' : fromFile ? 'file' : undefined,
  };
}

/** The larger copy shown in the viewer, or null when the original is small enough or is animated. */
async function makePreview(bitmap: ImageBitmap, file: File): Promise<Blob | null> {
  if (file.type === 'image/gif') return null;
  if (Math.max(bitmap.width, bitmap.height) <= PREVIEW_EDGE && file.size <= PREVIEW_SKIP_BYTES) return null;
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make a preview"))), 'image/webp', PREVIEW_QUALITY));
}

const RETRIES = 5;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends the encrypted file in pieces after the first request, resuming from what the server has after a failure. */
async function sendInPieces(uploadId: string, blob: Uint8Array, from: number, chunk: number, onProgress?: (sent: number, total: number) => void): Promise<VaultItem> {
  let offset = from;
  let failures = 0;
  for (;;) {
    onProgress?.(offset, blob.length);
    try {
      const piece = blob.subarray(offset, Math.min(blob.length, offset + chunk));
      const r = await api.putRaw<{ item?: VaultItem; received?: number }>('PUT', `/api/vault/uploads/${uploadId}?offset=${offset}`, piece as Uint8Array<ArrayBuffer>, 'application/octet-stream');
      if (r.item) { onProgress?.(blob.length, blob.length); return r.item; }
      offset = r.received ?? offset + piece.length;
      failures = 0;
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      // Refusals other than "wrong offset" or a busy upload will not get better by trying again.
      if (status && status !== 409 && status < 500) throw err;
      if (++failures > RETRIES) throw err;
      await pause(1000 * 2 ** (failures - 1));
      const at = await api.get<{ received: number }>(`/api/vault/uploads/${uploadId}`);
      offset = at.received;
    }
  }
}

export async function uploadToVault(serverId: string, channelId: string, authorId: string, file: File, opts: { ready?: VaultReady; onProgress?: (sent: number, total: number) => void } = {}): Promise<VaultItem> {
  const ready = opts.ready ?? await readForVault(file);
  const isVideo = file.type.startsWith('video/');
  let thumb: Blob; let preview: Blob | null = null; let width: number; let height: number; let durationSec: number | undefined;
  if (isVideo) {
    const info = await videoInfo(file);
    ({ thumb, w: width, h: height, durationSec } = info);
  } else {
    const bitmap = await createImageBitmap(file).catch(() => { throw new Error(`Couldn't read ${file.name}.`); });
    try {
      thumb = await drawThumb(bitmap, bitmap.width, bitmap.height);
      preview = await makePreview(bitmap, file).catch(() => null);
      width = bitmap.width; height = bitmap.height;
    } finally { bitmap.close(); }
  }
  const full = await encryptBlob(ready.bytes);
  const small = await encryptBlob(await bytesOf(thumb));
  const mid = preview ? await encryptBlob(await bytesOf(preview)) : null;
  const descriptor: VaultDescriptor = {
    name: file.name.slice(0, 255), mime: file.type, kind: isVideo ? 'video' : 'image', size: ready.bytes.length,
    width, height, durationSec, takenAt: ready.takenAt, takenAtSource: ready.takenAtSource,
    ...(ready.camera ? { camera: ready.camera.slice(0, 80) } : {}),
    sha256: ready.sha256, ...(ready.gpsRemoved ? { gpsRemoved: true } : {}),
    key: full.key, iv: full.iv, thumbKey: small.key, thumbIv: small.iv,
    ...(mid ? { prevKey: mid.key, prevIv: mid.iv } : {}),
  };
  const { ciphertext, keyVersion } = await encryptPayload(channelId, authorId, { text: JSON.stringify(descriptor) });

  const prev = mid?.blob ?? new Uint8Array(0);
  const first = Math.min(full.blob.length, FIRST_PIECE_BYTES);
  const body = new Uint8Array(8 + small.blob.length + prev.length + first);
  const view = new DataView(body.buffer);
  view.setUint32(0, small.blob.length);
  body.set(small.blob, 4);
  view.setUint32(4 + small.blob.length, prev.length);
  body.set(prev, 8 + small.blob.length);
  body.set(full.blob.subarray(0, first), 8 + small.blob.length + prev.length);
  const q = new URLSearchParams({ channelId, keyVersion: String(keyVersion), meta: ciphertext, size: String(full.blob.length) });
  opts.onProgress?.(0, full.blob.length);
  let started: { item?: VaultItem; uploadId?: string; received?: number; chunkBytes?: number };
  try {
    started = await api.putRaw('POST', `/api/servers/${serverId}/vault/uploads?${q}`, body as Uint8Array<ArrayBuffer>, 'application/octet-stream');
  } catch (err) {
    // A server from before resumable uploads: send it the old single-request way, without the preview.
    if (err instanceof ApiError && err.status === 404 && err.message !== 'server not found') return legacyUpload(serverId, channelId, keyVersion, ciphertext, small.blob, full.blob);
    throw err;
  }
  if (started.item) { opts.onProgress?.(full.blob.length, full.blob.length); return started.item; }
  return sendInPieces(started.uploadId!, full.blob, started.received ?? first, started.chunkBytes ?? FIRST_PIECE_BYTES, opts.onProgress);
}

/** The first request carries up to this much of the file, so most photos need only one request. */
const FIRST_PIECE_BYTES = 8 * 1024 * 1024;

async function legacyUpload(serverId: string, channelId: string, keyVersion: number, meta: string, thumb: Uint8Array, file: Uint8Array): Promise<VaultItem> {
  const body = new Uint8Array(4 + thumb.length + file.length);
  new DataView(body.buffer).setUint32(0, thumb.length);
  body.set(thumb, 4);
  body.set(file, 4 + thumb.length);
  const q = new URLSearchParams({ channelId, keyVersion: String(keyVersion), meta });
  const { item } = await api.putRaw<{ item: VaultItem }>('POST', `/api/servers/${serverId}/vault?${q}`, body as Uint8Array<ArrayBuffer>, 'application/octet-stream');
  return item;
}

export async function openDescriptor(item: VaultItem): Promise<VaultDescriptor | null> {
  const msg = await decryptMessage({ id: item.id, channelId: item.channelId, authorId: item.ownerId, createdAt: item.createdAt, editedAt: null, keyVersion: item.keyVersion, ciphertext: item.ciphertext });
  if (!msg) return null;
  try { return JSON.parse(msg.text) as VaultDescriptor; } catch { return null; }
}

/** Downloads and decrypts the thumbnail or the file; returns an object URL the caller revokes. */
export async function fetchVaultUrl(item: Pick<VaultItem, 'id'>, d: VaultDescriptor, thumb: boolean): Promise<string> {
  return thumb ? fetchVaultFile(item.id, d.thumbKey, d.thumbIv, 'image/webp', true) : fetchVaultFile(item.id, d.key, d.iv, d.mime);
}

/** The best copy for looking at: the preview when there is one (falling back to the file if it fails), else the file. */
export async function fetchVaultViewUrl(item: Pick<VaultItem, 'id'>, d: VaultDescriptor): Promise<{ url: string; original: boolean }> {
  if (d.prevKey && d.prevIv) {
    try { return { url: await fetchVaultFile(item.id, d.prevKey, d.prevIv, 'image/webp', 'preview'), original: false }; }
    catch { /* fall through to the original */ }
  }
  return { url: await fetchVaultUrl(item, d, false), original: true };
}

/** Downloads and decrypts one Vault file from its id and key alone (Watch together has no descriptor); returns an object URL. */
export async function fetchVaultFile(id: string, key: string, iv: string, mime: string, thumb: boolean | 'preview' = false): Promise<string> {
  const part = thumb === 'preview' ? 'preview' : thumb ? 'thumb' : 'file';
  const buf = await api.getBytes(`/api/vault/${encodeURIComponent(id)}/${part}`);
  const plain = await decryptBlob(new Uint8Array(buf), key, iv);
  return URL.createObjectURL(new Blob([plain as Uint8Array<ArrayBuffer>], { type: mime }));
}

/** Opens one person's sealed tags; null when the channel key is missing or the data is not tags. */
export async function openNotes(a: VaultAnnotation): Promise<VaultNotes | null> {
  const msg = await decryptMessage({ id: a.itemId, channelId: a.channelId, authorId: a.authorId, createdAt: a.updatedAt, editedAt: null, keyVersion: a.keyVersion, ciphertext: a.ciphertext });
  if (!msg) return null;
  try {
    const n = JSON.parse(msg.text) as Partial<VaultNotes>;
    return { tags: Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === 'string') : [], people: Array.isArray(n.people) ? n.people.filter((p) => typeof p === 'string') : [], ...(n.caption ? { caption: n.caption } : {}) };
  } catch { return null; }
}

/** Saves my tags for an item, or removes them when there are none. */
export async function saveNotes(item: VaultItem, me: string, notes: VaultNotes): Promise<void> {
  if (!notes.tags.length && !notes.people.length && !notes.caption) { await api.del(`/api/vault/${item.id}/annotation`); return; }
  const { ciphertext, keyVersion } = await encryptPayload(item.channelId, me, { text: JSON.stringify(notes) });
  await api.post(`/api/vault/${item.id}/annotation`, { keyVersion, ciphertext });
}

export const normalizeTag = (t: string) => t.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, 32);

export type NotesByItem = Record<string, Record<string, VaultNotes>>;
/** Everyone's tags for one item, merged. */
export function mergedNotes(by: Record<string, VaultNotes> | undefined): { tags: string[]; people: string[] } {
  const tags = new Set<string>(); const people = new Set<string>();
  for (const n of Object.values(by ?? {})) { n.tags.forEach((t) => tags.add(t)); n.people.forEach((p) => people.add(p)); }
  return { tags: [...tags].sort(), people: [...people] };
}

/** Opens an album's sealed name; null when the channel key is missing. */
export async function openAlbumMeta(a: VaultAlbum): Promise<VaultAlbumMeta | null> {
  const msg = await decryptMessage({ id: a.id, channelId: a.channelId, authorId: a.sealedBy, createdAt: a.updatedAt, editedAt: null, keyVersion: a.keyVersion, ciphertext: a.ciphertext });
  if (!msg) return null;
  try {
    const m = JSON.parse(msg.text) as Partial<VaultAlbumMeta>;
    return typeof m.name === 'string' ? { name: m.name, ...(typeof m.description === 'string' ? { description: m.description } : {}) } : null;
  } catch { return null; }
}

const sealAlbum = async (channelId: string, me: string, meta: VaultAlbumMeta) => {
  const clean: VaultAlbumMeta = { name: meta.name.trim().slice(0, 80), ...(meta.description?.trim() ? { description: meta.description.trim().slice(0, 500) } : {}) };
  const { ciphertext, keyVersion } = await encryptPayload(channelId, me, { text: JSON.stringify(clean) });
  return { channelId, keyVersion, ciphertext };
};

export const albumsApi = {
  list: (serverId: string) => api.get<{ albums: VaultAlbum[] }>(`/api/servers/${serverId}/vault/albums`).then((r) => r.albums),
  create: async (serverId: string, channelId: string, me: string, meta: VaultAlbumMeta, itemIds: string[] = []) =>
    (await api.post<{ album: VaultAlbum }>(`/api/servers/${serverId}/vault/albums`, { ...(await sealAlbum(channelId, me, meta)), itemIds: itemIds.slice(0, 500) })).album,
  rename: async (album: VaultAlbum, channelId: string, me: string, meta: VaultAlbumMeta) =>
    (await api.patch<{ album: VaultAlbum }>(`/api/vault/albums/${album.id}`, await sealAlbum(channelId, me, meta))).album,
  setCover: async (albumId: string, coverItemId: string | null) => (await api.patch<{ album: VaultAlbum }>(`/api/vault/albums/${albumId}`, { coverItemId })).album,
  /** Adds and takes out items, 500 at a time. Returns the album as it ends up. */
  change: async (albumId: string, add: string[] = [], remove: string[] = []): Promise<VaultAlbum> => {
    let album: VaultAlbum | null = null;
    for (let i = 0; i < Math.max(add.length, remove.length, 1); i += 500) {
      album = (await api.post<{ album: VaultAlbum }>(`/api/vault/albums/${albumId}/items`, { add: add.slice(i, i + 500), remove: remove.slice(i, i + 500) })).album;
    }
    return album!;
  },
  remove: (albumId: string) => api.del(`/api/vault/albums/${albumId}`),
};
