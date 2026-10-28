// Run with: npm run test:demo -w @chatward/client
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessagePayload } from '@chatward/shared';
import { demoDecode, demoEncode } from './codec';

test('round-trips a plain text payload', () => {
  const payload: MessagePayload = { text: 'hello 👋' };
  assert.deepEqual(demoDecode(demoEncode(payload)), payload);
});

test('round-trips a link preview carrying a large embedded image', () => {
  // A YouTube preview's og:image is embedded as a data URL of up to ~300KB. The old encoder overflowed the stack at this size.
  const image = 'data:image/jpeg;base64,' + 'A'.repeat(300 * 1024);
  const payload: MessagePayload = {
    text: 'https://www.youtube.com/watch?v=S7xGyxkWQoo&t=214s',
    linkPreviews: [{ url: 'https://www.youtube.com/watch?v=S7xGyxkWQoo&t=214s', title: 'Video', image }],
  };
  assert.deepEqual(demoDecode(demoEncode(payload)), payload);
});
