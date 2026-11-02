import { isSafeGifUrl } from './safeUrls';

// "Copy image" for chat pictures and GIFs. The picture is turned into a PNG here (every app can paste that), and a GIF's
// own file goes along too, so on Windows it keeps moving when pasted into apps that take files (Discord, Explorer).

/** True for the GIF provider's https links (not inline data pictures): those can also be copied as a link. */
export function isGifLink(src: string): boolean {
  return src.startsWith('https:') && isSafeGifUrl(src);
}

/** True when the bytes are a GIF file (they start with "GIF8"). */
export function isGifBytes(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
}

function dataUrlBytes(src: string): Uint8Array {
  const comma = src.indexOf(',');
  const meta = src.slice(5, comma);
  const body = src.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

/** The picture's file. Chat pictures are decrypted object URLs; GIF search pictures are downloaded by the app itself. */
async function pictureBytes(src: string): Promise<Uint8Array> {
  if (src.startsWith('blob:')) return new Uint8Array(await (await fetch(src)).arrayBuffer());
  if (src.startsWith('data:image/')) return dataUrlBytes(src);
  if (isGifLink(src)) {
    const api = window.chatward?.clipboard;
    if (!api) throw new Error('Copying GIFs needs the Chatward app.');
    return api.fetchGif(src);
  }
  throw new Error('That picture can not be copied.');
}

/** Draws the picture (a GIF's first frame) and returns it as PNG bytes. */
async function toPng(bytes: Uint8Array): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('That picture could not be copied.');
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('That picture could not be copied.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/**
 * Copies the picture shown at `src` to the clipboard. Resolves 'animated' when a GIF went on as a file too
 * (it keeps moving where files can be pasted), 'still' when only the picture went on.
 */
export async function copyPicture(src: string, name: string): Promise<'animated' | 'still'> {
  const bytes = await pictureBytes(src);
  const png = await toPng(bytes);
  const api = window.chatward?.clipboard;
  if (api) return api.copyImage(png, isGifBytes(bytes) ? { bytes, name } : undefined);
  // Outside the app (a plain browser): the web clipboard takes PNG pictures only.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })]);
  return 'still';
}

/** Copies a GIF search link as text. Pasted into Discord and most chat apps, it shows the moving GIF. */
export async function copyGifLink(src: string): Promise<void> {
  if (!isGifLink(src)) throw new Error('That link can not be copied.');
  const api = window.chatward?.clipboard;
  if (api) await api.copyGifLink(src);
  else await navigator.clipboard.writeText(src);
}
