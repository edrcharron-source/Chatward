import type { Area } from 'react-easy-crop';

const SIZE = 256;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = src;
  });
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the picture.'))), 'image/webp', quality);
  });
}

/** Crops the chosen square to a 256px WebP no larger than maxBytes. */
export async function cropToAvatar(src: string, area: Area, maxBytes: number): Promise<Blob> {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas is not available.');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, SIZE, SIZE);
  for (const quality of [0.9, 0.8, 0.7, 0.6]) {
    const blob = await encode(canvas, quality);
    if (blob.size <= maxBytes) return blob;
  }
  throw new Error('That picture is still too large after compression.');
}
