import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReplyRef } from '@chatward/shared';
import { SNIPPET_MAX, snippetOf, withReplyPing } from './replies';

const ref = (authorId: string): ReplyRef => ({ messageId: 'm1', authorId, createdAt: 1, snippet: 'hi' });

test('snippet is the text on one line, cut when long', () => {
  assert.equal(snippetOf({ text: 'hello\n\n  there' }), 'hello there');
  const long = snippetOf({ text: 'x'.repeat(500) });
  assert.equal(long.length, SNIPPET_MAX);
  assert.ok(long.endsWith('…'));
});

test('snippet says what a message without words holds', () => {
  assert.equal(snippetOf({ text: '', gif: { url: '', previewUrl: '', title: 'cat', provider: 'klipy' } }), 'GIF');
  const pic = { uploadId: 'u', name: 'a.png', mime: 'image/png', size: 1, key: '', iv: '' };
  assert.equal(snippetOf({ text: '', attachments: [pic] }), 'Picture');
  assert.equal(snippetOf({ text: '', attachments: [pic, pic] }), '2 pictures');
  assert.equal(snippetOf({ text: '', attachments: [{ ...pic, name: 'notes.pdf', mime: 'application/pdf' }] }), 'notes.pdf');
  assert.equal(snippetOf(null), 'Original message');
});

test('a reply pings the original author', () => {
  assert.deepEqual(withReplyPing(undefined, ref('bob'), 'me'), { userIds: ['bob'] });
  assert.deepEqual(withReplyPing({ everyone: true, userIds: ['amy'] }, ref('bob'), 'me'), { everyone: true, userIds: ['amy', 'bob'] });
});

test('no double ping, and no ping for replying to yourself', () => {
  assert.deepEqual(withReplyPing({ userIds: ['bob'] }, ref('bob'), 'me'), { userIds: ['bob'] });
  assert.equal(withReplyPing(undefined, ref('me'), 'me'), undefined);
  assert.equal(withReplyPing(undefined, undefined, 'me'), undefined);
});
