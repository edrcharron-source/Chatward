import type { VaultDescriptor, VaultItem } from '@chatward/shared';
import { api } from '../../api/http';
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

export async function uploadToVault(serverId: string, channelId: string, authorId: string, file: File): Promise<VaultItem> {
  const isVideo = file.type.startsWith('video/');
  if (!isVideo && !file.type.startsWith('image/')) throw new Error(`${file.name} is not a photo or video.`);
  let thumb: Blob; let width: number; let height: number; let durationSec: number | undefined;
  if (isVideo) {
    const info = await videoInfo(file);
    ({ thumb, w: width, h: height, durationSec } = info);
  } else {
    const bitmap = await createImageBitmap(file).catch(() => { throw new Error(`Couldn't read ${file.name}.`); });
    try { thumb = await drawThumb(bitmap, bitmap.width, bitmap.height); width = bitmap.width; height = bitmap.height; }
    finally { bitmap.close(); }
  }
  const full = await encryptBlob(await bytesOf(file));
  const small = await encryptBlob(await bytesOf(thumb));
  const descriptor: VaultDescriptor = {
    name: file.name.slice(0, 255), mime: file.type, kind: isVideo ? 'video' : 'image', size: file.size,
    width, height, durationSec, key: full.key, iv: full.iv, thumbKey: small.key, thumbIv: small.iv,
  };
  const { ciphertext, keyVersion } = await encryptPayload(channelId, authorId, { text: JSON.stringify(descriptor) });

  const body = new Uint8Array(4 + small.blob.length + full.blob.length);
  new DataView(body.buffer).setUint32(0, small.blob.length);
  body.set(small.blob, 4);
  body.set(full.blob, 4 + small.blob.length);
  const q = new URLSearchParams({ channelId, keyVersion: String(keyVersion), meta: ciphertext });
  const { item } = await api.putRaw<{ item: VaultItem }>('POST', `/api/servers/${serverId}/vault?${q}`, body as Uint8Array<ArrayBuffer>, 'application/octet-stream');
  return item;
}

export async function openDescriptor(item: VaultItem): Promise<VaultDescriptor | null> {
  const msg = await decryptMessage({ id: item.id, channelId: item.channelId, authorId: item.ownerId, createdAt: item.createdAt, editedAt: null, keyVersion: item.keyVersion, ciphertext: item.ciphertext });
  if (!msg) return null;
  try { return JSON.parse(msg.text) as VaultDescriptor; } catch { return null; }
}

/** Downloads and decrypts the thumbnail or the file; returns an object URL the caller revokes. */
export async function fetchVaultUrl(item: VaultItem, d: VaultDescriptor, thumb: boolean): Promise<string> {
  const buf = await api.getBytes(`/api/vault/${item.id}/${thumb ? 'thumb' : 'file'}`);
  const plain = await decryptBlob(new Uint8Array(buf), thumb ? d.thumbKey : d.key, thumb ? d.thumbIv : d.iv);
  return URL.createObjectURL(new Blob([plain as Uint8Array<ArrayBuffer>], { type: thumb ? 'image/webp' : d.mime }));
}
