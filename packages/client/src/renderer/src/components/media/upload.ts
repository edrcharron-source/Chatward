import type { Attachment } from '@chatward/shared';
import { api } from '../../api/http';
import { encryptBlob } from '../../crypto';

const MAX_EDGE = 1600;
const WEBP_QUALITY = 0.82;
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Mimes we render inline. Anything else (SVG included) is shown as a download chip. */
export const INLINE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

interface Prepared {
  bytes: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
}

/** Re-encoding through a canvas drops EXIF/location metadata and caps the long edge. */
async function reencode(bitmap: ImageBitmap, sourceMime: string): Promise<Prepared> {
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  // PNG stays lossless so transparency survives; everything else becomes WebP.
  const target = sourceMime === 'image/png' ? 'image/png' : 'image/webp';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, target, WEBP_QUALITY));
  if (!blob) throw new Error("Couldn't process that image");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, width, height };
}

async function prepare(file: File): Promise<Prepared> {
  if (!RASTER_MIMES.has(file.type) && file.type !== 'image/gif') {
    return { bytes: new Uint8Array(await file.arrayBuffer()), mime: 'application/octet-stream' };
  }
  const bitmap = await createImageBitmap(file);
  try {
    // GIFs go up untouched so they keep their animation.
    if (file.type === 'image/gif') {
      return { bytes: new Uint8Array(await file.arrayBuffer()), mime: 'image/gif', width: bitmap.width, height: bitmap.height };
    }
    return await reencode(bitmap, file.type);
  } finally {
    bitmap.close();
  }
}

/** Compress/resize, encrypt, upload. Returns the attachment descriptor that goes inside the message payload. */
export async function uploadAttachment(file: File): Promise<Attachment> {
  const prepared = await prepare(file);
  const { blob, key, iv } = await encryptBlob(prepared.bytes);
  // Crypto always allocates a plain ArrayBuffer; the narrower type is what fetch/Blob require.
  const { uploadId } = await api.putRaw<{ uploadId: string }>('POST', '/api/uploads', blob as Uint8Array<ArrayBuffer>, 'application/octet-stream');
  return {
    uploadId,
    name: file.name.slice(0, 255),
    mime: prepared.mime,
    size: prepared.bytes.byteLength,
    width: prepared.width,
    height: prepared.height,
    key,
    iv,
  };
}
