import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResizePacer } from './resizePacing';

test('a fresh drag may apply a size straight away', () => {
  assert.equal(new ResizePacer().ready(0), true);
});

test('after a size is sent, the next waits until the page confirms it', () => {
  const p = new ResizePacer(100);
  p.sent(1000);
  assert.equal(p.ready(1016), false);
  p.acked();
  assert.equal(p.ready(1016), true);
});

test('a page that never confirms does not stall the drag past the patience limit', () => {
  const p = new ResizePacer(100);
  p.sent(1000);
  assert.equal(p.ready(1099), false);
  assert.equal(p.ready(1100), true);
});
