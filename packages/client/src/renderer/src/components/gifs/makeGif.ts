import { GIFEncoder, applyPalette, quantize } from 'gifenc';

export interface CropArea { x: number; y: number; width: number; height: number }

export interface GifPlan {
  /** Seconds into the video. */
  start: number;
  end: number;
  fps: number;
  /** Part of the video frame to keep, in the video's own pixels. */
  crop: CropArea;
  /** Width of the finished GIF; never wider than the crop. */
  width: number;
}

/** Finished GIF size in pixels, keeping the crop's shape. */
export function outputSize(plan: Pick<GifPlan, 'crop' | 'width'>): { width: number; height: number } {
  const width = Math.max(1, Math.round(Math.min(plan.width, plan.crop.width)));
  const height = Math.max(1, Math.round(plan.crop.height * (width / plan.crop.width)));
  return { width, height };
}

/** The moments to grab, one per frame, from start up to (not including) end. */
export function frameTimes(start: number, end: number, fps: number): number[] {
  const count = Math.max(1, Math.floor((end - start) * fps + 1e-6));
  return Array.from({ length: count }, (_, i) => start + i / fps);
}

// Video GIFs land around this many bytes per pixel per frame after compression. Only for the rough estimate.
const BYTES_PER_PIXEL = 0.55;

/** Rough finished size in bytes, shown before the GIF is made. */
export function estimateBytes(plan: GifPlan): number {
  const { width, height } = outputSize(plan);
  return Math.round(width * height * frameTimes(plan.start, plan.end, plan.fps).length * BYTES_PER_PIXEL);
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - t) < 0.0005 && video.readyState >= 2) { resolve(); return; }
    const timer = setTimeout(() => { cleanup(); reject(new Error("The video stopped responding while making the GIF.")); }, 8000);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("Couldn't read that part of the video.")); };
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', fail); };
    video.addEventListener('seeked', done);
    video.addEventListener('error', fail);
    video.currentTime = t;
  });
}

/** Loads a video file into a hidden player for frame grabbing. Rejects when the app can't play the format. */
export function loadVideo(src: string, doc: Document = document): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = doc.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.onloadeddata = () => resolve(video);
    video.onerror = () => reject(new Error("The app can't play this video. Try saving it as an .mp4 first."));
    video.src = src;
  });
}

/**
 * Turns part of a video into GIF bytes on this PC. Plays nothing: it seeks to each frame's moment, draws the cropped
 * part scaled down onto a canvas, and hands the pixels to the encoder. Yields between frames so the window stays responsive.
 */
export async function encodeGif(
  video: HTMLVideoElement,
  plan: GifPlan,
  onProgress: (done: number) => void,
  isCancelled: () => boolean = () => false,
): Promise<Uint8Array> {
  const { width, height } = outputSize(plan);
  const canvas = video.ownerDocument.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is unavailable');
  ctx.imageSmoothingQuality = 'high';
  const gif = GIFEncoder();
  const times = frameTimes(plan.start, plan.end, plan.fps);
  const delay = Math.round(1000 / plan.fps);
  for (let i = 0; i < times.length; i++) {
    if (isCancelled()) throw new Error('cancelled');
    await seek(video, times[i]);
    ctx.drawImage(video, plan.crop.x, plan.crop.y, plan.crop.width, plan.crop.height, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay });
    onProgress((i + 1) / times.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  return gif.bytes();
}
