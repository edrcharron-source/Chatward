/**
 * A stable random order per seed: the same seed always gives the same order, and two people (two seeds) get different
 * ones. The Scroll feed seeds it with the viewer's id and server, so each person sees their own shuffle.
 */

/** FNV-1a, 32 bits: a seed string becomes a number for the generator below. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a small, fast generator of floats in [0, 1). */
export function generator(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A new array with the same items in a seeded random order (Fisher-Yates). The input is not changed. */
export function shuffled<T>(items: readonly T[], seed: string): T[] {
  const rnd = generator(seedOf(seed));
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
