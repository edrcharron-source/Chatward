import { api } from '../../../api/http';
import prompts from './prompts.json';

/**
 * The image half of MobileCLIP S0, run in the browser with ONNX Runtime (WebAssembly). Pictures never leave the device:
 * the Chatward server only hands out the model file, and the text side is fixed prompts whose embeddings ship with the
 * app (sort/prompts.json, made by scripts/vault-sort-prompts.py).
 */

export const MODEL_NAME = prompts.model;
export const PROMPTS = prompts.prompts as { group: string; text: string; embed: number[] }[];
const EDGE = 256;
const CACHE_DB = 'chatward-vault-model';

type Ort = typeof import('onnxruntime-web');
type Session = import('onnxruntime-web').InferenceSession;
let loading: Promise<{ ort: Ort; session: Session } | null> | null = null;

interface ModelInfo { available: boolean; sha256?: string; bytes?: number }

/** Keeps the model in IndexedDB under its hash, so each device downloads it once. */
async function cachedModel(sha: string): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(CACHE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const get = req.result.transaction('files').objectStore('files').get(sha);
        get.onsuccess = () => { req.result.close(); resolve((get.result as ArrayBuffer | undefined) ?? null); };
        get.onerror = () => { req.result.close(); resolve(null); };
      };
    } catch { resolve(null); }
  });
}
async function storeModel(sha: string, bytes: ArrayBuffer): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.open(CACHE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onerror = () => resolve();
      req.onsuccess = () => {
        const t = req.result.transaction('files', 'readwrite');
        const store = t.objectStore('files');
        store.clear();
        store.put(bytes, sha);
        t.oncomplete = () => { req.result.close(); resolve(); };
        t.onerror = () => { req.result.close(); resolve(); };
      };
    } catch { resolve(); }
  });
}

/** Loads ONNX Runtime and the model once. Resolves to null when the server has no model (the sorter then uses clues only). */
export function loadSortModel(onProgress?: (msg: string) => void): Promise<{ ort: Ort; session: Session } | null> {
  loading ??= (async () => {
    const info = await api.get<ModelInfo>('/api/vault/sort-model/info').catch(() => ({ available: false }) as ModelInfo);
    if (!info.available || !info.sha256) return null;
    let bytes = await cachedModel(info.sha256);
    if (!bytes) {
      onProgress?.(`Downloading the photo sorter (${Math.round((info.bytes ?? 0) / 1048576)} MB, once per device)…`);
      bytes = await api.getBytes('/api/vault/sort-model');
      await storeModel(info.sha256, bytes);
    }
    const ort = await import('onnxruntime-web/wasm');
    const [wasm, mjs] = await Promise.all([
      import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url'),
      import('onnxruntime-web/ort-wasm-simd-threaded.mjs?url'),
    ]);
    ort.env.wasm.wasmPaths = { wasm: wasm.default, mjs: mjs.default };
    // Threads need cross-origin isolation, which the app does not have; one thread is quick enough for thumbnails.
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] });
    return { ort: ort as unknown as Ort, session };
  })().catch((err) => { loading = null; throw err; });
  return loading;
}

/** Turns an image into the model's input: shortest edge to 256, centre crop, RGB scaled to 0..1, channels first. */
export function pixelValues(source: CanvasImageSource, w: number, h: number): Float32Array {
  const scale = EDGE / Math.min(w, h);
  const sw = Math.max(EDGE, Math.round(w * scale)); const sh = Math.max(EDGE, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = EDGE; canvas.height = EDGE;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, -Math.floor((sw - EDGE) / 2), -Math.floor((sh - EDGE) / 2), sw, sh);
  const { data } = g.getImageData(0, 0, EDGE, EDGE);
  const out = new Float32Array(3 * EDGE * EDGE);
  const plane = EDGE * EDGE;
  for (let i = 0; i < plane; i++) {
    out[i] = data[i * 4] / 255;
    out[plane + i] = data[i * 4 + 1] / 255;
    out[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  return out;
}

/** The unit-length image embedding of a picture (a decrypted thumbnail is plenty). */
export async function embedImage(m: { ort: Ort; session: Session }, blob: Blob): Promise<Float32Array> {
  const bitmap = await createImageBitmap(blob);
  try {
    const input = new m.ort.Tensor('float32', pixelValues(bitmap, bitmap.width, bitmap.height), [1, 3, EDGE, EDGE]);
    const out = await m.session.run({ pixel_values: input });
    const e = out.image_embeds.data as Float32Array;
    let n = 0; for (const v of e) n += v * v;
    n = Math.sqrt(n) || 1;
    return e.map((v) => v / n);
  } finally { bitmap.close(); }
}
