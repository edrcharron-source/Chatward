import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWindow, roundedShape } from './windowBounds';

const want = { width: 1280, height: 800, minWidth: 900, minHeight: 600 };

test('a window that fits the work area keeps its size and is centred on it', () => {
  const r = fitWindow({ x: 0, y: 0, width: 1920, height: 1040 }, want);
  assert.deepEqual(r, { x: 320, y: 120, width: 1280, height: 800, minWidth: 900, minHeight: 600 });
});

test('the work area offset moves the window (a taskbar on the left or top)', () => {
  const r = fitWindow({ x: 0, y: 40, width: 1920, height: 1040 }, want);
  assert.equal(r.y, 160);
});

test('a window taller than the work area shrinks to it and stays on screen', () => {
  const r = fitWindow({ x: 0, y: 0, width: 1366, height: 680 }, want);
  assert.equal(r.height, 680);
  assert.equal(r.y, 0);
  assert.equal(r.minHeight, 600);
});

test('a window wider than the work area shrinks to it and the minimum width follows', () => {
  const r = fitWindow({ x: 0, y: 0, width: 800, height: 1000 }, want);
  assert.equal(r.width, 800);
  assert.equal(r.minWidth, 800);
});

test('the minimum size is kept when the work area is large enough for it', () => {
  const r = fitWindow({ x: 0, y: 0, width: 1024, height: 700 }, want);
  assert.equal(r.minWidth, 900);
  assert.equal(r.minHeight, 600);
});

test('a square window shape is one rectangle', () => {
  assert.deepEqual(roundedShape(300, 200, { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 }), [{ x: 0, y: 0, width: 300, height: 200 }]);
});

test('round corners step in at the corner rows and the middle stays one block', () => {
  const rects = roundedShape(400, 300, { topLeft: 60, topRight: 15, bottomLeft: 60, bottomRight: 20 });
  // The top row starts well in from the left (the big sweep) and a little in from the right (the close cap).
  assert.ok(rects[0].x > 30 && rects[0].y === 0);
  assert.ok(400 - rects[0].x - rects[0].width > 5);
  // Rows past every curve reach both sides, as one rectangle.
  const middle = rects.find((r) => r.x === 0 && r.width === 400);
  assert.ok(middle && middle.y <= 60 && middle.y + middle.height >= 240);
  // The rectangles cover every row exactly once.
  let y = 0;
  for (const r of rects) { assert.equal(r.y, y); y += r.height; }
  assert.equal(y, 300);
});

test('a radius bigger than the window is capped and junk numbers count as square', () => {
  const rects = roundedShape(40, 40, { topLeft: 500, topRight: Number.NaN, bottomLeft: -3, bottomRight: 0 });
  assert.ok(rects[0].x > 10 && rects[0].x <= 20);
  assert.equal(rects[0].x + rects[0].width, 40);
  assert.equal(rects[rects.length - 1].x, 0);
});
