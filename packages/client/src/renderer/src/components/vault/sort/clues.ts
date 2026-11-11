import type { VaultCategory, VaultDescriptor } from '@chatward/shared';

/**
 * Pure logic for the Vault's photo / meme / screenshot sorter: hints read from a file's own details, and how those
 * hints are combined with the image model's opinion. No network, no model: everything here is unit tested.
 */

export const CATEGORIES: VaultCategory[] = ['photo', 'meme', 'screenshot'];
export type Scores = Record<VaultCategory, number>;

/** Bumped when the sorter changes enough that earlier results should be redone. */
export const SORTER_VERSION = 1;
/** Below this the item stays unsorted instead of landing in the wrong album. */
export const SURE_ENOUGH = 0.6;

const zero = (): Scores => ({ photo: 0, meme: 0, screenshot: 0 });

// Exact screen sizes (either orientation) that screenshots come out at.
const SCREENS = new Set([
  // phones
  '750x1334', '828x1792', '1080x1920', '1080x2340', '1080x2400', '1080x2280', '1125x2436', '1170x2532', '1179x2556',
  '1242x2208', '1242x2688', '1284x2778', '1290x2796', '1440x3088', '1440x3200', '1440x2960', '720x1600', '720x1520', '1080x2408', '1206x2622', '1320x2868',
  // tablets
  '1536x2048', '1620x2160', '1640x2360', '1668x2388', '2048x2732', '1600x2560',
  // desktops and laptops
  '1280x720', '1366x768', '1440x900', '1536x864', '1600x900', '1680x1050', '1920x1080', '1920x1200', '2560x1080', '2560x1440',
  '2560x1600', '2880x1800', '3024x1964', '3456x2234', '3440x1440', '3840x2160', '2736x1824', '2256x1504',
]);
const isScreenSize = (w?: number, h?: number) => !!w && !!h && (SCREENS.has(`${w}x${h}`) || SCREENS.has(`${h}x${w}`));

const SCREENSHOT_NAME = /^(screenshot|screen[ _-]?shot|screen[ _-]?recording|scrnli|capture|snip|clipboard|image[ _-]?\d+\.png$)/i;
// Names that downloaded or forwarded pictures get from apps and meme sites.
const MEME_NAME = /(meme|brainrot|reddit|i\.redd\.it|ifunny|imgflip|9gag|tenor|giphy|tiktok|ssstik|snaptik|twitter|tweet|x_com|instagram|insta_|fb_img|received_|caption)/i;
const FORWARDED_NAME = /^(IMG-\d{8}-WA\d+|\d{13,}|[0-9a-f]{16,}|[a-z0-9]{8,}_[a-z0-9]{3,})\.(jpe?g|png|webp|gif|mp4)$/i;
const CAMERA_NAME = /^(IMG_\d{3,}|DSC[_F]?\d{3,}|PXL_\d{8}|DCIM|P\d{7}|GOPR\d+|MVIMG_|VID_\d{8}|\d{8}_\d{6})/i;

/** Hints from the file itself, as additive log-odds per category. 0 everywhere means "no idea". */
export function clueScores(d: Pick<VaultDescriptor, 'name' | 'mime' | 'kind' | 'width' | 'height' | 'camera' | 'takenAtSource'>): Scores {
  const s = zero();
  const name = d.name ?? '';
  if (d.camera) { s.photo += 3; s.meme -= 1; s.screenshot -= 2; }
  if (d.takenAtSource === 'exif' && !d.camera) s.photo += 1;
  if (CAMERA_NAME.test(name)) { s.photo += 1.5; }
  if (SCREENSHOT_NAME.test(name)) s.screenshot += 4;
  if (MEME_NAME.test(name)) s.meme += 2.5;
  else if (FORWARDED_NAME.test(name) && !d.camera) s.meme += 0.75;
  if (isScreenSize(d.width, d.height) && !d.camera) s.screenshot += d.mime === 'image/png' ? 2.5 : 1;
  if (d.mime === 'image/gif') s.meme += 2;
  if (d.mime === 'image/png' && !d.camera && !isScreenSize(d.width, d.height)) s.meme += 0.25;
  // Small pictures without camera details have usually been saved from somewhere.
  const edge = Math.max(d.width ?? 0, d.height ?? 0);
  if (d.kind === 'image' && !d.camera && edge > 0 && edge <= 1280 && d.mime !== 'image/png') { s.meme += 0.75; s.photo -= 0.5; }
  return s;
}

const softmax = (x: Scores): Scores => {
  const m = Math.max(...CATEGORIES.map((c) => x[c]));
  const e = CATEGORIES.map((c) => Math.exp(x[c] - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return { photo: e[0] / sum, meme: e[1] / sum, screenshot: e[2] / sum };
};

/** The image model's per-category probabilities from an image embedding and the prompt embeddings (both unit length). */
export function modelProbs(image: ArrayLike<number>, prompts: { group: string; embed: number[] }[], scale = 100): Scores {
  const logits = prompts.map((p) => { let dot = 0; for (let i = 0; i < p.embed.length; i++) dot += p.embed[i] * image[i]; return dot * scale; });
  const m = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - m));
  const sum = e.reduce((a, b) => a + b, 0);
  const out = zero();
  prompts.forEach((p, i) => { if (p.group in out) out[p.group as VaultCategory] += e[i] / sum; });
  return out;
}

/**
 * Combines the model (when it ran) with the clues and picks a category, or null when no category is sure enough.
 * Clues count fully without a model, and nudge the model's opinion when there is one.
 */
export function decide(clues: Scores, model: Scores | null): { category: VaultCategory | null; score: number; probs: Scores } {
  const strongest = Math.max(...CATEGORIES.map((c) => Math.abs(clues[c])));
  const logits = zero();
  for (const c of CATEGORIES) logits[c] = (model ? Math.log(Math.max(model[c], 1e-6)) : 0) + clues[c] * (model ? 0.6 : 1);
  const probs = softmax(logits);
  const best = CATEGORIES.reduce((a, b) => (probs[b] > probs[a] ? b : a));
  // Without a model, only a clear clue counts.
  const sure = probs[best] >= SURE_ENOUGH && (model !== null || strongest >= 2);
  return { category: sure ? best : null, score: Math.round(probs[best] * 100) / 100, probs };
}

/** Manual tags that settle an item's category, whoever added them. */
const MANUAL: Record<string, VaultCategory> = { photo: 'photo', 'not-meme': 'photo', 'real-photo': 'photo', meme: 'meme', memes: 'meme', brainrot: 'meme', screenshot: 'screenshot' };
export const CATEGORY_TAG: Record<VaultCategory, string> = { photo: 'photo', meme: 'meme', screenshot: 'screenshot' };

/** An item's category from everyone's notes: a manual tag first, else the surest automatic sort. */
export function categoryOf(notes: { tags: string[]; auto?: { category: VaultCategory | null; score: number } }[]): { category: VaultCategory | null; manual: boolean; score?: number; sorted: boolean } {
  for (const n of notes) for (const t of n.tags) if (MANUAL[t]) return { category: MANUAL[t], manual: true, sorted: true };
  const autos = notes.map((n) => n.auto).filter((a): a is NonNullable<typeof a> => !!a);
  if (!autos.length) return { category: null, manual: false, sorted: false };
  const best = autos.reduce((a, b) => ((b.category && !a.category) || (!!b.category === !!a.category && b.score > a.score) ? b : a));
  return { category: best.category, manual: false, score: best.score, sorted: true };
}
