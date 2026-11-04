import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VaultDescriptor, VaultItem } from '@chatward/shared';
import { buildAlbums } from './albums';

const H = 60 * 60 * 1000;
const base = Date.UTC(2026, 5, 1, 12);
const entry = (id: string, owner: string, at: number, kind: 'image' | 'video' = 'image') => ({
  item: { id, ownerId: owner, createdAt: at } as VaultItem,
  d: { kind, takenAt: at } as VaultDescriptor,
});

test('photos within six hours form one event, a long gap starts another', () => {
  const { events } = buildAlbums([entry('a', 'u1', base), entry('b', 'u1', base + 2 * H), entry('c', 'u2', base + 30 * H), entry('d', 'u2', base + 31 * H)], (u) => u);
  assert.deepEqual(events.map((e) => e.ids), [['c', 'd'], ['a', 'b']]);
});

test('single items make no event or uploader album', () => {
  const { events, people } = buildAlbums([entry('a', 'u1', base), entry('b', 'u2', base + 50 * H)], (u) => u);
  assert.equal(events.length, 0);
  assert.equal(people.length, 0);
});

test('groups by uploader and by photo or video', () => {
  const { people, kinds } = buildAlbums([entry('a', 'u1', base), entry('b', 'u1', base + 1), entry('c', 'u2', base + 2, 'video')], (u) => `Name ${u}`);
  assert.deepEqual(people, [{ key: 'by:u1', label: 'Added by Name u1', ids: ['a', 'b'] }]);
  assert.deepEqual(kinds.map((k) => [k.label, k.ids]), [['Photos', ['a', 'b']], ['Videos', ['c']]]);
});
