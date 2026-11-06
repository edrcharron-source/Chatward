import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { isSignedBy, signedUpdateBytes } from './updateSignature';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const installer = Buffer.from('pretend this is Chatward-Setup.exe');
const signature = sign(null, signedUpdateBytes(installer, '1.1.0'), privateKey);

test('accepts an installer signed with the matching key for this version', () => {
  assert.equal(isSignedBy(installer, '1.1.0', signature, publicPem), true);
});

test('rejects an installer that was changed after signing', () => {
  assert.equal(isSignedBy(Buffer.from('pretend this is a virus'), '1.1.0', signature, publicPem), false);
});

test('rejects an older signed installer offered as a newer version', () => {
  assert.equal(isSignedBy(installer, '9.9.9', signature, publicPem), false);
});

test('rejects a signature made with a different key', () => {
  const other = generateKeyPairSync('ed25519').privateKey;
  assert.equal(isSignedBy(installer, '1.1.0', sign(null, signedUpdateBytes(installer, '1.1.0'), other), publicPem), false);
});

test('rejects everything when no public key is built in', () => {
  assert.equal(isSignedBy(installer, '1.1.0', signature, ''), false);
});

test('rejects a garbage signature or key without throwing', () => {
  assert.equal(isSignedBy(installer, '1.1.0', Buffer.from('nope'), publicPem), false);
  assert.equal(isSignedBy(installer, '1.1.0', signature, 'not a key'), false);
});
