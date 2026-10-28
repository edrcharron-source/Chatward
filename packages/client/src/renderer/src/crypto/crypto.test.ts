// Run with: npm run test:crypto -w @chatward/client
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DeviceKeys, KeyEnvelope } from '@chatward/shared';
import { openEnvelope, sealEnvelope } from './envelope';
import {
  aesDecryptWith, aesEncryptWith, aesOpen, aesSeal, Bytes, concat, exportRawPublic, fromB64, generateAesKeyBytes,
  generateEcdh, generateSigning, hkdf, importAesKey, importSignPublic, randomBytes, toB64, utf8, IV_BYTES,
} from './primitives';
import { safetyNumber } from './safety';

interface TestDevice extends DeviceKeys {
  ecdhPrivate: CryptoKey;
  signPrivate: CryptoKey;
}

async function makeDevice(): Promise<TestDevice> {
  const ecdh = await generateEcdh();
  const sign = await generateSigning();
  return {
    deviceId: crypto.randomUUID(),
    ecdhPublic: toB64(await exportRawPublic(ecdh.publicKey)),
    signPublic: toB64(await exportRawPublic(sign.publicKey)),
    ecdhPrivate: ecdh.privateKey,
    signPrivate: sign.privateKey,
  };
}

async function sealFor(from: TestDevice, to: TestDevice, channelKey: Bytes, channelId = 'chan-1', keyVersion = 1): Promise<KeyEnvelope> {
  return sealEnvelope({ channelId, keyVersion, channelKey, from: { deviceId: from.deviceId, signPrivate: from.signPrivate }, to });
}

async function openFor(env: KeyEnvelope, sender: TestDevice, recipient: TestDevice): Promise<Uint8Array | null> {
  return openEnvelope({
    env,
    senderSignPublic: await importSignPublic(fromB64(sender.signPublic)),
    recipientPriv: recipient.ecdhPrivate,
    recipientPublic: recipient.ecdhPublic,
  });
}

describe('AES-256-GCM', () => {
  it('round-trips and rejects a different AAD', async () => {
    const key = await importAesKey(generateAesKeyBytes());
    const sealed = await aesSeal(key, utf8('hello'), utf8('chan|1|alice'));
    assert.equal(new TextDecoder().decode(await aesOpen(key, sealed, utf8('chan|1|alice'))), 'hello');
    await assert.rejects(aesOpen(key, sealed, utf8('chan|1|mallory')));
    await assert.rejects(aesOpen(key, sealed, utf8('chan|2|alice')));
  });

  it('detects ciphertext tampering', async () => {
    const key = await importAesKey(generateAesKeyBytes());
    const sealed = await aesSeal(key, utf8('payload'));
    sealed[sealed.length - 1] ^= 1;
    await assert.rejects(aesOpen(key, sealed));
  });

  it('uses a fresh IV per seal', async () => {
    const key = await importAesKey(generateAesKeyBytes());
    const a = await aesSeal(key, utf8('same'));
    const b = await aesSeal(key, utf8('same'));
    assert.notDeepEqual(a.slice(0, IV_BYTES), b.slice(0, IV_BYTES));
    assert.notDeepEqual(a, b);
  });

  it('blob-style explicit-IV round-trip and tamper detection', async () => {
    const raw = generateAesKeyBytes();
    const iv = randomBytes(IV_BYTES);
    const key = await importAesKey(raw);
    const data = randomBytes(4096);
    const blob = await aesEncryptWith(key, iv, data);
    assert.deepEqual(await aesDecryptWith(key, iv, blob), data);
    blob[10] ^= 0xff;
    await assert.rejects(aesDecryptWith(key, iv, blob));
  });
});

describe('channel key envelopes', () => {
  it('a recipient opens an envelope from a known sender and recovers the channel key', async () => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    const key = generateAesKeyBytes();
    const env = await sealFor(alice, bob, key);
    assert.deepEqual(await openFor(env, alice, bob), key);
  });

  it('is not openable by a device it was not addressed to', async () => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    const eve = await makeDevice();
    const env = await sealFor(alice, bob, generateAesKeyBytes());
    assert.equal(await openFor({ ...env, toDeviceId: eve.deviceId }, alice, eve), null);
    assert.equal(await openFor(env, alice, eve), null);
  });

  it('rejects an envelope signed by someone other than the claimed sender', async () => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    const mallory = await makeDevice();
    const env = await sealFor(mallory, bob, generateAesKeyBytes());
    assert.equal(await openFor({ ...env, fromDeviceId: alice.deviceId }, alice, bob), null);
    assert.equal(await openFor(env, alice, bob), null);
  });

  it('rejects tampering with any signed field', async () => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    const env = await sealFor(alice, bob, generateAesKeyBytes(), 'chan-1', 3);
    assert.equal(await openFor({ ...env, channelId: 'chan-2' }, alice, bob), null);
    assert.equal(await openFor({ ...env, keyVersion: 2 }, alice, bob), null);
    const bytes = fromB64(env.wrapped);
    bytes[bytes.length - 1] ^= 1;
    assert.equal(await openFor({ ...env, wrapped: toB64(bytes) }, alice, bob), null);
  });

  it('key rotation: a removed device cannot open the new version and the new key cannot read old messages', async () => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    const removed = await makeDevice();
    const v1 = generateAesKeyBytes();
    const v2 = generateAesKeyBytes();
    // v2 is only wrapped for the devices that remain
    const envV2ForBob = await sealFor(alice, bob, v2, 'chan-1', 2);
    assert.equal(await openFor(envV2ForBob, alice, removed), null);

    const oldMessage = await aesSeal(await importAesKey(v1), utf8('before kick'), utf8('chan-1|1|alice'));
    await assert.rejects(aesOpen(await importAesKey(v2), oldMessage, utf8('chan-1|1|alice')));
    // Removed device still holds v1 (cannot be revoked from history), so it can read old messages only.
    assert.equal(new TextDecoder().decode(await aesOpen(await importAesKey(v1), oldMessage, utf8('chan-1|1|alice'))), 'before kick');
  });
});

describe('HKDF voice key', () => {
  it('is deterministic per channel and separated by channel id', async () => {
    const key = generateAesKeyBytes();
    const a = await hkdf(key, utf8('chan-1'), utf8('chatward-voice'), 32);
    const b = await hkdf(key, utf8('chan-1'), utf8('chatward-voice'), 32);
    const c = await hkdf(key, utf8('chan-2'), utf8('chatward-voice'), 32);
    assert.equal(a.length, 32);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });
});

describe('safety number', () => {
  it('is six groups of five digits and independent of device order', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    const forward = await safetyNumber([a, b]);
    assert.match(forward, /^\d{5} \d{5} \d{5} \d{5} \d{5} \d{5}$/);
    assert.equal(await safetyNumber([b, a]), forward);
  });

  it('changes when a device is added', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    const c = await makeDevice();
    assert.notEqual(await safetyNumber([a, b]), await safetyNumber([a, b, c]));
  });
});

describe('concat', () => {
  it('joins parts in order', () => {
    assert.deepEqual(concat(utf8('ab'), utf8('c')), utf8('abc'));
  });
});

describe('large payloads', () => {
  const big = () => { const b = new Uint8Array(10 * 1024 * 1024); for (let i = 0; i < b.length; i += 65536) globalThis.crypto.getRandomValues(b.subarray(i, i + 65536)); return b as Bytes; };

  it('base64 round-trips a 10 MB buffer without overflowing the stack', () => {
    const data = big();
    assert.deepEqual(fromB64(toB64(data)), data);
  });

  it('seals and opens a 10 MB attachment', async () => {
    const data = big();
    const key = await importAesKey(generateAesKeyBytes());
    const sealed = await aesSeal(key, data);
    assert.deepEqual(await aesOpen(key, sealed), data);
  });
});
