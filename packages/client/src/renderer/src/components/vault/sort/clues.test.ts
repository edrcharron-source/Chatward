import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryOf, clueScores, decide, modelProbs } from './clues';

const img = (over: Record<string, unknown> = {}) => ({ name: 'x.jpg', mime: 'image/jpeg', kind: 'image' as const, width: 3000, height: 2000, ...over });

test('camera details point to a photo', () => {
  const r = decide(clueScores(img({ camera: 'Apple iPhone 15 Pro', takenAtSource: 'exif', name: 'IMG_4412.jpg' })), null);
  assert.equal(r.category, 'photo');
});

test('screenshot names and screen sizes point to a screenshot', () => {
  assert.equal(decide(clueScores(img({ name: 'Screenshot_20261108-221455.png', mime: 'image/png', width: 1080, height: 2400 })), null).category, 'screenshot');
  assert.equal(decide(clueScores(img({ name: 'IMG_0042.PNG', mime: 'image/png', width: 1179, height: 2556 })), null).category, 'screenshot', 'an iPhone screen size in PNG');
});

test('meme names and GIFs point to a meme', () => {
  assert.equal(decide(clueScores(img({ name: 'ifunny_skibidi.jpg', width: 640, height: 640 })), null).category, 'meme');
  assert.equal(decide(clueScores(img({ name: 'reaction.gif', mime: 'image/gif', width: 480, height: 270 })), null).category, 'meme');
});

test('without a model, weak clues leave the item unsorted', () => {
  assert.equal(decide(clueScores(img({ name: 'download.jpg', width: 1200, height: 900 })), null).category, null);
});

test('the model decides when clues are quiet, and clues nudge it', () => {
  const quiet = clueScores(img({ name: 'download.jpg', width: 1600, height: 1600 }));
  assert.equal(decide(quiet, { photo: 0.1, meme: 0.8, screenshot: 0.1 }).category, 'meme');
  assert.equal(decide(quiet, { photo: 0.45, meme: 0.4, screenshot: 0.15 }).category, null, 'a split model is unsure');
  const camera = clueScores(img({ camera: 'Google Pixel 8', name: 'PXL_20261101_101010.jpg' }));
  assert.equal(decide(camera, { photo: 0.4, meme: 0.55, screenshot: 0.05 }).category, 'photo', 'camera details outweigh a mild meme score');
});

test('model probabilities add up per category', () => {
  const p = modelProbs([1, 0], [{ group: 'photo', embed: [1, 0] }, { group: 'meme', embed: [0, 1] }, { group: 'meme', embed: [0, 1] }]);
  assert.ok(p.photo > 0.99);
  assert.ok(Math.abs(p.photo + p.meme + p.screenshot - 1) < 1e-9);
});

test('a manual tag wins over automatic sorts, and the surest automatic sort wins otherwise', () => {
  assert.deepEqual(categoryOf([{ tags: [], auto: { category: 'meme', score: 0.9 } }, { tags: ['photo'] }]), { category: 'photo', manual: true, sorted: true });
  assert.equal(categoryOf([{ tags: ['brainrot'] }]).category, 'meme');
  assert.equal(categoryOf([{ tags: [], auto: { category: null, score: 0.5 } }, { tags: [], auto: { category: 'screenshot', score: 0.7 } }]).category, 'screenshot');
  assert.deepEqual(categoryOf([{ tags: ['beach'] }]), { category: null, manual: false, sorted: false });
});
