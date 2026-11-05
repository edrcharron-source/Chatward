// Run with: npm run test:float -w @chatward/client
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAR_HEIGHT, EDGE, MAX_WIDTH, MIN_WIDTH, boxHeight, clampBox, defaultBox, moveBox, parseBox, resizeBox } from './floatingBox';

const VW = 1280;
const VH = 720;

test('the default box sits in the bottom-right corner at 320 wide', () => {
  const b = defaultBox(VW, VH);
  assert.equal(b.w, 320);
  assert.equal(b.x, VW - 320 - 16);
  assert.equal(b.y, VH - boxHeight(320) - 16);
});

test('the height is the 16:9 video plus the drag strip', () => {
  assert.equal(boxHeight(320), 320 * 9 / 16 + BAR_HEIGHT);
});

test('a box dragged past an edge stays inside the window', () => {
  const start = defaultBox(VW, VH);
  const left = moveBox(start, -5000, 0, VW, VH);
  assert.equal(left.x, EDGE);
  const down = moveBox(start, 0, 5000, VW, VH);
  assert.equal(down.y, VH - boxHeight(down.w) - EDGE);
  const right = moveBox(start, 5000, 0, VW, VH);
  assert.equal(right.x, VW - right.w - EDGE);
});

test('resizing grows and shrinks the width, within the limits', () => {
  const start = { x: 100, y: 100, w: 320 };
  assert.equal(resizeBox(start, 80, VW, VH).w, 400);
  assert.equal(resizeBox(start, -1000, VW, VH).w, MIN_WIDTH);
  assert.equal(resizeBox(start, 5000, VW, VH).w, MAX_WIDTH);
  // the top-left corner stays put when resizing
  const grown = resizeBox(start, 80, VW, VH);
  assert.equal(grown.x, 100);
  assert.equal(grown.y, 100);
});

test('a box that would run off the bottom or right after growing is pulled back in', () => {
  const b = resizeBox({ x: 900, y: 500, w: 320 }, 300, VW, VH);
  assert.ok(b.x + b.w <= VW - EDGE);
  assert.ok(b.y + boxHeight(b.w) <= VH - EDGE);
});

test('a saved box is clamped when the window has become smaller', () => {
  const small = clampBox({ x: 1000, y: 600, w: 600 }, 640, 360);
  assert.ok(small.w <= 640 - EDGE * 2);
  assert.ok(small.x + small.w <= 640 - EDGE);
  assert.ok(small.y + boxHeight(small.w) <= 360 - EDGE);
});

test('parseBox accepts a saved box and rejects anything else', () => {
  assert.deepEqual(parseBox({ x: 1, y: 2, w: 3 }), { x: 1, y: 2, w: 3 });
  assert.equal(parseBox(null), null);
  assert.equal(parseBox({ x: 1, y: 2 }), null);
  assert.equal(parseBox({ x: '1', y: 2, w: 3 }), null);
  assert.equal(parseBox({ x: Number.NaN, y: 2, w: 3 }), null);
});
