// Run with: npm run test:media -w @chatward/client
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeEmbed, isSafeGifUrl, isSafeImageUrl } from './safeUrls';

test('link-preview images: only inline data images pass', () => {
  assert.equal(isSafeImageUrl('data:image/jpeg;base64,AAAA'), true);
  assert.equal(isSafeImageUrl('https://evil.example/pixel.png'), false);
  assert.equal(isSafeImageUrl('http://evil.example/pixel.png'), false);
  assert.equal(isSafeImageUrl('data:text/html,<script>'), false);
  assert.equal(isSafeImageUrl(undefined), false);
});

test('GIFs: inline images and Klipy hosts pass, other hosts do not', () => {
  assert.equal(isSafeGifUrl('data:image/svg+xml;charset=utf-8,%3Csvg%3E'), true);
  assert.equal(isSafeGifUrl('https://static.klipy.com/a/b.gif'), true);
  assert.equal(isSafeGifUrl('https://klipy.com/a.gif'), true);
  assert.equal(isSafeGifUrl('https://evil.example/track.gif'), false);
  assert.equal(isSafeGifUrl('https://klipy.com.evil.example/a.gif'), false);
  assert.equal(isSafeGifUrl('https://evilklipy.com/a.gif'), false);
  assert.equal(isSafeGifUrl('http://static.klipy.com/a.gif'), false);
  assert.equal(isSafeGifUrl('not a url'), false);
});

test('embed ids: YouTube needs 11 id characters, X needs digits', () => {
  assert.equal(isSafeEmbed({ kind: 'youtube', id: 'dQw4w9WgXcQ' }), true);
  assert.equal(isSafeEmbed({ kind: 'youtube', id: 'x"onload=1' }), false);
  assert.equal(isSafeEmbed({ kind: 'youtube', id: 'short' }), false);
  assert.equal(isSafeEmbed({ kind: 'twitter', id: '1234567890' }), true);
  assert.equal(isSafeEmbed({ kind: 'twitter', id: '123/../x' }), false);
  assert.equal(isSafeEmbed({ kind: 'twitter', id: '' }), false);
  assert.equal(isSafeEmbed({ kind: 'vimeo', id: '123' }), false);
});
