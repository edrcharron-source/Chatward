// Run with: npm run test:watch -w @chatward/client
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeState, encodeState, mediaKey, moveQueueItem, QUEUE_MAX, stateForItem, type QueueItem } from './sync';

const JF = 'a'.repeat(32);

test('round-trips a Jellyfin item with a mixed queue', () => {
  const s = stateForItem({ kind: 'jellyfin', ref: JF, title: 'Alien' }, [
    { kind: 'youtube', ref: 'dQw4w9WgXcQ' },
    { kind: 'url', ref: 'https://example.com/a.mp4', title: 'Clip' },
    { kind: 'jellyfin', ref: JF },
  ], 3);
  const back = decodeState(encodeState(s));
  assert.ok(back);
  assert.equal(back.jellyfinId, JF);
  assert.equal(back.title, 'Alien');
  assert.equal(back.queue?.length, 3);
  assert.equal(back.n, 3);
  assert.equal(mediaKey(back), JF);
});

test('old states without a queue still decode', () => {
  const back = decodeState({ text: JSON.stringify({ v: 1, videoId: 'dQw4w9WgXcQ', playing: true, position: 5, rate: 1 }) });
  assert.ok(back);
  assert.deepEqual(back.queue, []);
  assert.equal(back.jellyfinId, null);
});

test('rejects hostile or malformed states', () => {
  const base = { videoId: null, playing: true, position: 0, rate: 1 };
  const bad = [
    { ...base, jellyfinId: '../../etc/passwd' },
    { ...base, videoId: 'dQw4w9WgXcQ', jellyfinId: JF },
    { ...base, queue: [{ kind: 'url', ref: 'http://insecure.example/a.mp4' }] },
    { ...base, queue: [{ kind: 'jellyfin', ref: 'nope' }] },
    { ...base, queue: Array.from({ length: QUEUE_MAX + 1 }, () => ({ kind: 'youtube', ref: 'dQw4w9WgXcQ' })) },
    { ...base, queue: 'x' },
  ];
  for (const b of bad) assert.equal(decodeState({ text: JSON.stringify(b) }), null);
});

test('moves a queue item up or down, and ignores a stale or empty move', () => {
  const q: QueueItem[] = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'].map((ref) => ({ kind: 'youtube', ref }));
  assert.deepEqual(moveQueueItem(q, 0, 2, 'aaaaaaaaaaa')?.map((i) => i.ref), ['bbbbbbbbbbb', 'ccccccccccc', 'aaaaaaaaaaa']);
  assert.deepEqual(moveQueueItem(q, 2, 0, 'ccccccccccc')?.map((i) => i.ref), ['ccccccccccc', 'aaaaaaaaaaa', 'bbbbbbbbbbb']);
  assert.equal(moveQueueItem(q, 1, 1, 'bbbbbbbbbbb'), null);
  assert.equal(moveQueueItem(q, 0, 1, 'ccccccccccc'), null);
  assert.equal(moveQueueItem(q, 0, 3, 'aaaaaaaaaaa'), null);
  assert.deepEqual(q.map((i) => i.ref), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
});
