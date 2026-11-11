import type { VaultDescriptor, VaultItem } from '@chatward/shared';

export interface Album { key: string; label: string; ids: string[] }
export interface AlbumEntry { item: VaultItem; d: VaultDescriptor | undefined }

const EVENT_GAP_MS = 6 * 60 * 60 * 1000;
export const whenOf = (e: AlbumEntry) => e.d?.takenAt ?? e.item.createdAt;

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Groups into automatic albums: events (photos close in time), who uploaded, and photos vs videos. Albums of one item are left out. */
export function buildAlbums(entries: AlbumEntry[], nameOf: (userId: string) => string): { events: Album[]; people: Album[]; kinds: Album[] } {
  const sorted = [...entries].sort((a, b) => whenOf(a) - whenOf(b));
  const events: Album[] = [];
  let run: AlbumEntry[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const first = day(whenOf(run[0])); const last = day(whenOf(run[run.length - 1]));
      events.push({ key: `event:${run[0].item.id}`, label: first === last ? first : `${first} to ${last}`, ids: run.map((e) => e.item.id) });
    }
    run = [];
  };
  for (const e of sorted) {
    if (run.length && whenOf(e) - whenOf(run[run.length - 1]) > EVENT_GAP_MS) flush();
    run.push(e);
  }
  flush();
  events.reverse();

  const byOwner = new Map<string, string[]>();
  for (const e of entries) byOwner.set(e.item.ownerId, [...(byOwner.get(e.item.ownerId) ?? []), e.item.id]);
  const people = [...byOwner].filter(([, ids]) => ids.length >= 2).map(([id, ids]) => ({ key: `by:${id}`, label: `Added by ${nameOf(id)}`, ids }));

  const kinds: Album[] = [];
  for (const [kind, label] of [['image', 'Photos'], ['video', 'Videos']] as const) {
    const ids = entries.filter((e) => e.d?.kind === kind).map((e) => e.item.id);
    if (ids.length) kinds.push({ key: `kind:${kind}`, label, ids });
  }
  return { events, people, kinds };
}
