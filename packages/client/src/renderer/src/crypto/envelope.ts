// Channel-key envelopes: the channel AES key wrapped for one recipient device.
// wrapped = base64(ephemeralPub[65] || iv[12] || AES-GCM(channelKey)[48])
// Signed by the sender's ECDSA key over the header and wrapped bytes.
import type { DeviceKeys, KeyEnvelope } from '@chatward/shared';
import {
  aesOpen, aesSeal, Bytes, concat, deriveWrapKey, exportRawPublic, fromB64, generateEcdh, importEcdhPublic,
  KEY_BYTES, sign, toB64, utf8, verify,
} from './primitives';

const HEADER = 'chatward-envelope-v1';
const EPHEMERAL_PUB_BYTES = 65; // uncompressed P-256 point

function header(channelId: string, keyVersion: number, fromDeviceId: string, toDeviceId: string): string {
  return `${HEADER}|${channelId}|${keyVersion}|${fromDeviceId}|${toDeviceId}`;
}

function signedBytes(env: Omit<KeyEnvelope, 'signature'>): Bytes {
  return utf8(`${header(env.channelId, env.keyVersion, env.fromDeviceId, env.toDeviceId)}|${env.wrapped}`);
}

export async function sealEnvelope(args: {
  channelId: string;
  keyVersion: number;
  channelKey: Bytes;
  from: { deviceId: string; signPrivate: CryptoKey };
  to: DeviceKeys;
}): Promise<KeyEnvelope> {
  const { channelId, keyVersion, channelKey, from, to } = args;
  const recipientRaw = fromB64(to.ecdhPublic);
  const recipientPub = await importEcdhPublic(recipientRaw);
  const ephemeral = await generateEcdh();
  const ephemeralRaw = await exportRawPublic(ephemeral.publicKey);
  const aad = utf8(header(channelId, keyVersion, from.deviceId, to.deviceId));
  const wrapKey = await deriveWrapKey(ephemeral.privateKey, recipientPub, concat(ephemeralRaw, recipientRaw), aad);
  const wrapped = toB64(concat(ephemeralRaw, await aesSeal(wrapKey, channelKey, aad)));
  const unsigned = { channelId, keyVersion, fromDeviceId: from.deviceId, toDeviceId: to.deviceId, wrapped };
  const signature = toB64(await sign(from.signPrivate, signedBytes(unsigned)));
  return { ...unsigned, signature };
}

/** Returns the channel key, or null if the signature is invalid or the envelope does not open. */
export async function openEnvelope(args: {
  env: KeyEnvelope;
  senderSignPublic: CryptoKey;
  recipientPriv: CryptoKey;
  recipientPublic: string;
}): Promise<Bytes | null> {
  const { env, senderSignPublic, recipientPriv, recipientPublic } = args;
  try {
    const signature = fromB64(env.signature);
    if (!(await verify(senderSignPublic, signature, signedBytes(env)))) return null;

    const raw = fromB64(env.wrapped);
    const ephemeralRaw = raw.slice(0, EPHEMERAL_PUB_BYTES);
    const ephemeralPub = await importEcdhPublic(ephemeralRaw);
    const aad = utf8(header(env.channelId, env.keyVersion, env.fromDeviceId, env.toDeviceId));
    const wrapKey = await deriveWrapKey(recipientPriv, ephemeralPub, concat(ephemeralRaw, fromB64(recipientPublic)), aad);
    const channelKey = await aesOpen(wrapKey, raw.slice(EPHEMERAL_PUB_BYTES), aad);
    return channelKey.length === KEY_BYTES ? channelKey : null;
  } catch {
    return null;
  }
}
