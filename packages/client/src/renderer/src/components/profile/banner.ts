import type { Area } from 'react-easy-crop';

export const BANNER_ASPECT = 3;
const WIDTH = 600;
const HEIGHT = WIDTH / BANNER_ASPECT;

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

/** Crops the chosen area to a 600x200 WebP no larger than maxBytes. */
export async function cropToBanner(src: string, area: Area, maxBytes: number): Promise<Blob> {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas is not available.');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, WIDTH, HEIGHT);
  for (const quality of [0.9, 0.8, 0.7, 0.6]) {
    const blob = await encode(canvas, quality);
    if (blob.size <= maxBytes) return blob;
  }
  throw new Error('That picture is still too large after compression.');
}
