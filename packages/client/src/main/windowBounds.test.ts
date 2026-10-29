import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWindow } from './windowBounds';

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
