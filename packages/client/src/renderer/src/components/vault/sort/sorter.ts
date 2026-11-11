import type { VaultAutoSort, VaultDescriptor, VaultItem, VaultNotes } from '@chatward/shared';
import { fetchVaultUrl, saveNotes } from '../vault';
import { clueScores, decide, modelProbs, SORTER_VERSION } from './clues';
import { embedImage, loadSortModel, MODEL_NAME, PROMPTS } from './model';

/**
 * Sorts one Vault item on this device and saves the result inside my own sealed notes for it, keeping my tags.
 * Uses the image model when the server offers it, else the file's own clues.
 */
export async function sortItem(item: VaultItem, d: VaultDescriptor, me: string, mine: VaultNotes | undefined, onProgress?: (msg: string) => void): Promise<VaultAutoSort> {
  const clues = clueScores(d);
  let model = null as ReturnType<typeof modelProbs> | null;
  const m = await loadSortModel(onProgress).catch(() => null);
  if (m) {
    const url = await fetchVaultUrl(item, d, true);
    try {
      const blob = await (await fetch(url)).blob();
      model = modelProbs(await embedImage(m, blob), PROMPTS);
    } finally { URL.revokeObjectURL(url); }
  }
  const r = decide(clues, model);
  const auto: VaultAutoSort = { category: r.category, score: r.score, by: model ? MODEL_NAME : 'clues', v: SORTER_VERSION };
  await saveNotes(item, me, { ...(mine ?? { tags: [], people: [] }), auto });
  return auto;
}

/** Whether an item should be (re)sorted: never sorted, sorted by an older sorter, or only by clues when the model is now here. */
export function needsSort(autos: (VaultAutoSort | undefined)[], hasManualTag: boolean, modelAvailable: boolean): boolean {
  if (hasManualTag) return false;
  const done = autos.filter((a): a is VaultAutoSort => !!a && a.v >= SORTER_VERSION);
  if (!done.length) return true;
  return modelAvailable && done.every((a) => a.by === 'clues');
}
