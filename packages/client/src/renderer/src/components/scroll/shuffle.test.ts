import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shuffled } from './shuffle';

const ITEMS = Array.from({ length: 40 }, (_, i) => `item-${i}`);

test('shuffled keeps every item exactly once', () => {
  assert.deepEqual([...shuffled(ITEMS, 'me|server')].sort(), [...ITEMS].sort());
});

test('shuffled gives the same order for the same seed', () => {
  assert.deepEqual(shuffled(ITEMS, 'me|server'), shuffled(ITEMS, 'me|server'));
});

test('shuffled gives different people different orders', () => {
  assert.notDeepEqual(shuffled(ITEMS, 'alice|server'), shuffled(ITEMS, 'bob|server'));
});

test('shuffled does not change its input', () => {
  const copy = ITEMS.slice();
  shuffled(ITEMS, 'x');
  assert.deepEqual(ITEMS, copy);
});
