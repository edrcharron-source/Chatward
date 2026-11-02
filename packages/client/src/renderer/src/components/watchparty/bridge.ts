// Lets other parts of the app (the Jellyfin browser) add to the watch party queue without owning its state.
import type { QueueItem } from './sync';

let handler: ((item: QueueItem) => void) | null = null;

/** The watch party panel registers while it is mounted (you are in a call). Returns an unregister function. */
export function registerQueueHandler(fn: (item: QueueItem) => void): () => void {
  handler = fn;
  return () => { if (handler === fn) handler = null; };
}

/** True while a watch party panel is open, so the UI can show "Add to watch party". */
export const canQueueToWatchParty = (): boolean => handler !== null;

/** Adds `item` to the call's queue (or starts it when nothing is playing). Returns false when no call is open. */
export function queueToWatchParty(item: QueueItem): boolean {
  if (!handler) return false;
  handler(item);
  return true;
}
