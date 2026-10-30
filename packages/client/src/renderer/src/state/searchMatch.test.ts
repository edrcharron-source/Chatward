// Run with: npm run test:search -w @chatward/client
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, MessagePayload } from '@chatward/shared';
import { searchEntries, snippet, type SearchEntry, type SearchFilters } from './searchMatch';

let n = 0;
function entry(authorId: string, payload: MessagePayload | null, createdAt = ++n): SearchEntry {
  const message: Message = { id: `m${createdAt}`, channelId: 'c', authorId, createdAt, editedAt: null, keyVersion: 1, ciphertext: '' };
  return { message, payload };
}
const EMPTY: SearchFilters = { text: '', authorId: '', kind: 'any' };
const f = (patch: Partial<SearchFilters>): SearchFilters => ({ ...EMPTY, ...patch });

const photo = { uploadId: 'u1', name: 'beach.jpg', mime: 'image/jpeg', size: 1, key: '', iv: '' };
const clip = { uploadId: 'u2', name: 'clip.mp4', mime: 'video/mp4', size: 1, key: '', iv: '' };
const doc = { uploadId: 'u3', name: 'notes.pdf', mime: 'application/pdf', size: 1, key: '', iv: '' };
const gif = { url: 'x', previewUrl: 'x', title: 'party cat', provider: 'klipy' as const };

const all = [
  entry('ava', { text: 'Game tonight?' }),
  entry('ben', { text: 'yes, the GAME starts at 8' }),
  entry('ava', { text: '', attachments: [photo] }),
  entry('ava', { text: 'look', attachments: [clip] }),
  entry('ben', { text: 'here', attachments: [doc] }),
  entry('ava', { text: 'lol', gif }),
  entry('ben', { text: 'see https://example.com ok' }),
  entry('ava', null),
];

test('lists nothing until a filter is set', () => {
  assert.deepEqual(searchEntries(all, EMPTY), []);
});

test('finds a word in any case, newest first', () => {
  const hits = searchEntries(all, f({ text: 'game' }));
  assert.deepEqual(hits.map((e) => e.payload?.text), ['yes, the GAME starts at 8', 'Game tonight?']);
});

test('every word must appear', () => {
  assert.equal(searchEntries(all, f({ text: 'game 8' })).length, 1);
});

test('matches file names and GIF titles', () => {
  assert.equal(searchEntries(all, f({ text: 'beach' })).length, 1);
  assert.equal(searchEntries(all, f({ text: 'cat' })).length, 1);
});

test('filters by person', () => {
  assert.equal(searchEntries(all, f({ authorId: 'ben' })).length, 3);
});

test('a person plus media lists their pictures, videos and GIFs only', () => {
  const hits = searchEntries(all, f({ authorId: 'ava', kind: 'media' }));
  assert.equal(hits.length, 3);
  assert.ok(hits.every((e) => e.message.authorId === 'ava'));
});

test('files and links', () => {
  assert.equal(searchEntries(all, f({ kind: 'files' })).length, 1);
  assert.equal(searchEntries(all, f({ kind: 'links' })).length, 1);
});

test('a message that could not be decrypted never matches', () => {
  assert.ok(searchEntries(all, f({ authorId: 'ava' })).every((e) => e.payload));
});

test('snippet marks the found words and trims long text around the first one', () => {
  assert.deepEqual(snippet('Game on', ['game']), ['', 'Game', ' on']);
  const long = `${'a '.repeat(200)}needle ${'b '.repeat(200)}`;
  const parts = snippet(long, ['needle']);
  assert.ok(parts[0].startsWith('…'));
  assert.ok(parts[parts.length - 1].endsWith('…'));
  assert.equal(parts[1], 'needle');
});
