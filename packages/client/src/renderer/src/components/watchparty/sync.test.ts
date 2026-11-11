// Run with: npm run test:watch -w @chatward/client
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctDrift, decodeState, encodeState, isJump, mediaKey, moveQueueItem, QUEUE_MAX, stateForItem, vaultItem, type QueueItem } from './sync';

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

test('round-trips a Vault video and a queued Vault item', () => {
  const f = { id: 'mhs0abcde1234567890', key: 'a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U=', iv: 'aXZpdml2aXZpdml2', mime: 'video/mp4' };
  const s = stateForItem(vaultItem(f, 'Beach day.mp4'), [vaultItem({ ...f, id: 'mhs0abcde0000000000' })], 1);
  const back = decodeState(encodeState(s));
  assert.ok(back);
  assert.deepEqual(back.vault, f);
  assert.equal(back.title, 'Beach day.mp4');
  assert.equal(mediaKey(back), f.id);
  assert.equal(back.queue?.[0].kind, 'vault');
  assert.equal(back.queue?.[0].vault?.key, f.key);
});

test('rejects a Vault item that is not a video or has a bad id', () => {
  const f = { id: 'mhs0abcde1234567890', key: 'a2V5', iv: 'aXY=', mime: 'video/mp4' };
  const bad = (v: object) => decodeState({ text: JSON.stringify({ v: 1, videoId: null, vault: { ...f, ...v }, playing: true, position: 0, rate: 1 }) });
  assert.equal(bad({ mime: 'image/png' }), null);
  assert.equal(bad({ id: '../etc' }), null);
  assert.equal(bad({ key: 'x'.repeat(200) }), null);
  assert.ok(bad({}));
});

test('small drift nudges the rate, large drift seeks, and a nudge runs until close again', () => {
  assert.equal(correctDrift(0.1, 1, false), 1);
  assert.equal(correctDrift(0.25, 1, false), 1);
  assert.equal(correctDrift(-0.5, 1, false), 1.05);
  assert.equal(correctDrift(0.5, 1, false), 0.95);
  assert.equal(correctDrift(-0.25, 1, true), 1.05);
  assert.equal(correctDrift(-0.15, 1, true), 1);
  assert.equal(correctDrift(1, 1.5, false), 1.5 * 0.95);
  assert.equal(correctDrift(-1.9, 1, false), 1.05);
  assert.equal(correctDrift(2.5, 1, true), 'seek');
  assert.equal(correctDrift(-3, 1, false), 'seek');
});

test('tells a seek or a new video from a play, pause or speed change', () => {
  const s = { ...stateForItem({ kind: 'jellyfin', ref: JF }, [], 1), position: 100, ts: 10_000 };
  assert.equal(isJump(null, s), true);
  // paused 5 s later at where playback had got to
  assert.equal(isJump(s, { ...s, playing: false, position: 105.2, ts: 15_000 }), false);
  assert.equal(isJump(s, { ...s, rate: 1.5, position: 104.8, ts: 15_000 }), false);
  assert.equal(isJump(s, { ...s, position: 300, ts: 15_000 }), true);
  assert.equal(isJump(s, { ...s, jellyfinId: 'b'.repeat(32), position: 105, ts: 15_000 }), true);
});
