import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { isSignedBy } from './updateSignature';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const installer = Buffer.from('pretend this is Chatward-Setup.exe');
const signature = sign(null, installer, privateKey);

test('accepts an installer signed with the matching key', () => {
  assert.equal(isSignedBy(installer, signature, publicPem), true);
});

test('rejects an installer that was changed after signing', () => {
  const tampered = Buffer.from('pretend this is a virus');
  assert.equal(isSignedBy(tampered, signature, publicPem), false);
});

test('rejects a signature made with a different key', () => {
  const other = generateKeyPairSync('ed25519').privateKey;
  assert.equal(isSignedBy(installer, sign(null, installer, other), publicPem), false);
});

test('rejects everything when no public key is built in', () => {
  assert.equal(isSignedBy(installer, signature, ''), false);
});
