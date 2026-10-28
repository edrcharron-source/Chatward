// Run with: npm run test:fit -w @chatward/client
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, type MessagePayload } from '@chatward/shared';
import { MESSAGE_TOO_LONG, fitPayload } from './fitPayload';

// Stand-in for encryptPayload: ciphertext length tracks the JSON size, which is what the real cap sees.
const encrypt = async (p: MessagePayload) => ({ ciphertext: 'x'.repeat(JSON.stringify(p).length), keyVersion: 1 });
const noShrink = async () => undefined;
const bigImage = 'data:image/jpeg;base64,' + 'A'.repeat(300 * 1024);

test('keeps the payload as-is when it already fits', async () => {
  const payload: MessagePayload = { text: 'hello' };
  const fitted = await fitPayload(payload, encrypt, async () => assert.fail('should not shrink'));
  assert.deepEqual(fitted.payload, payload);
});

test('replaces an oversize preview image with a thumbnail that fits', async () => {
  const payload: MessagePayload = {
    text: 'https://example.com',
    linkPreviews: [{ url: 'https://example.com', title: 'Example', image: bigImage }],
  };
  const thumb = 'data:image/jpeg;base64,' + 'B'.repeat(2 * 1024);
  const fitted = await fitPayload(payload, encrypt, async () => thumb);
  assert.equal(fitted.payload.linkPreviews?.[0].image, thumb);
  assert.equal(fitted.payload.linkPreviews?.[0].title, 'Example');
  assert.ok(fitted.ciphertext.length <= LIMITS.MESSAGE_CIPHERTEXT_MAX);
});

test('drops the image when no thumbnail can be made, but keeps the preview text', async () => {
  const payload: MessagePayload = {
    text: 'https://example.com',
    linkPreviews: [{ url: 'https://example.com', title: 'Example', image: bigImage }],
  };
  const fitted = await fitPayload(payload, encrypt, noShrink);
  assert.equal(fitted.payload.linkPreviews?.[0].image, undefined);
  assert.equal(fitted.payload.linkPreviews?.[0].title, 'Example');
});

test('drops the preview entirely when even the text plus preview is too big', async () => {
  const payload: MessagePayload = {
    text: 'short',
    linkPreviews: [{ url: 'https://example.com', description: 'y'.repeat(LIMITS.MESSAGE_CIPHERTEXT_MAX) }],
  };
  const fitted = await fitPayload(payload, encrypt, noShrink);
  assert.equal(fitted.payload.linkPreviews, undefined);
  assert.equal(fitted.payload.text, 'short');
});

test('throws a readable error when the message text alone is too long', async () => {
  const payload: MessagePayload = { text: 'z'.repeat(LIMITS.MESSAGE_CIPHERTEXT_MAX) };
  await assert.rejects(fitPayload(payload, encrypt, noShrink), { message: MESSAGE_TOO_LONG });
});
