// E2EE module — OWNER: crypto agent. Signatures below are the contract; do not change them.
// Threat model and key lifecycle: see ./README.md.
import type { DeviceKeys, KeyEnvelope, Message, MessagePayload } from '@chatward/shared';
import { api } from '../api/http';
import { useSession, type ServerBundle } from '../state/session';
import { openEnvelope, sealEnvelope } from './envelope';
import {
  aesDecryptWith, aesEncryptWith, aesOpen, aesSeal, Bytes, concat, exportJwk, exportRawPublic, fromB64,
  generateAesKeyBytes, generateEcdh, generateSigning, hkdf, importAesKey, importEcdhPrivate, importSignPrivate,
  importSignPublic, IV_BYTES, KEY_BYTES, randomBytes, toB64, utf8,
} from './primitives';

export { safetyNumber } from './safety';

// Local vault: every channel key we hold (plus the device list the latest version was wrapped for).
// Stored only through window.chatward.secureStore, which the main process encrypts with safeStorage.
interface StoredDevice extends DeviceKeys {
  ecdhPrivate: JsonWebKey;
  signPrivate: JsonWebKey;
}

interface Vault {
  /** channelId -> keyVersion -> base64 AES-256 key */
  channels: Record<string, Record<string, string>>;
  /** channelId -> recipients of the latest version we know about */
  recipients: Record<string, { version: number; deviceIds: string[] }>;
}

const DEVICE_STORE = 'crypto.device.v1';
const VAULT_STORE = 'crypto.vault.v1';

let device: DeviceKeys | null = null;
let privates: { ecdh: CryptoKey; sign: CryptoKey } | null = null;
let vault: Vault = { channels: {}, recipients: {} };
const aesCache = new Map<string, Promise<CryptoKey>>();
const listeners = new Set<() => void>();
// Every mutation of the vault goes through this queue so syncs and frames cannot interleave.
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

function secureStore() {
  if (!window.chatward) throw new Error('Secure storage is unavailable');
  return window.chatward.secureStore;
}

async function readStored<T>(key: string): Promise<T | null> {
  const raw = await secureStore().get(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

function persistVault(): Promise<void> {
  return secureStore().set(VAULT_STORE, JSON.stringify(vault));
}

async function createDevice(): Promise<StoredDevice> {
  const ecdh = await generateEcdh();
  const sign = await generateSigning();
  const stored: StoredDevice = {
    deviceId: crypto.randomUUID(),
    ecdhPublic: toB64(await exportRawPublic(ecdh.publicKey)),
    signPublic: toB64(await exportRawPublic(sign.publicKey)),
    ecdhPrivate: await exportJwk(ecdh.privateKey),
    signPrivate: await exportJwk(sign.privateKey),
  };
  await secureStore().set(DEVICE_STORE, JSON.stringify(stored));
  return stored;
}

/** Load or create this device's keypairs (stored via window.chatward.secureStore). Registers nothing on the server. */
export function initDevice(): Promise<DeviceKeys> {
  return serial(async () => {
    if (!device) {
      const stored = (await readStored<StoredDevice>(DEVICE_STORE)) ?? (await createDevice());
      privates = { ecdh: await importEcdhPrivate(stored.ecdhPrivate), sign: await importSignPrivate(stored.signPrivate) };
      device = { deviceId: stored.deviceId, ecdhPublic: stored.ecdhPublic, signPublic: stored.signPublic };
      vault = (await readStored<Vault>(VAULT_STORE)) ?? vault;
    }
    return device;
  });
}

/** Public keys of this device (valid after initDevice). Sent in register/login bodies. */
export function getDevice(): DeviceKeys {
  if (!device) throw new Error('Device keys are not initialised; call initDevice() first');
  return device;
}

/** Ensure every text channel has a key and this device has envelopes; create+wrap keys for all member devices when we hold/create the key. Idempotent; safe to call often. */
export function syncChannelKeys(servers: ServerBundle[]): Promise<void> {
  return serial(async () => {
    if (!device || !privates) return;
    let changed = false;
    for (const bundle of servers) {
      const devices = bundle.members.flatMap((m) => m.devices);
      for (const channel of bundle.channels) {
        changed = (await syncChannel(channel.id, devices)) || changed;
      }
    }
    if (changed) {
      await persistVault();
      notify();
    }
  });
}

async function syncChannel(channelId: string, devices: DeviceKeys[]): Promise<boolean> {
  const me = getDevice();
  let dirty = false;

  const mine = await api.get<{ envelopes: KeyEnvelope[] }>(`/api/channels/${channelId}/keys?deviceId=${encodeURIComponent(me.deviceId)}`);
  for (const env of mine.envelopes) dirty = (await acceptEnvelope(env)) || dirty;

  const status = await api.get<{ latestVersion: number; devicesMissing: string[] }>(`/api/channels/${channelId}/key-status`);
  const serverLatest = status.latestVersion;

  // First key for this channel: we create it and wrap it for every member device.
  if (serverLatest === 0) {
    if (localLatest(channelId) > 0) return dirty;
    const key = generateAesKeyBytes();
    putKey(channelId, 1, key);
    await publishKey(channelId, 1, key, devices);
    return true;
  }

  const key = localKey(channelId, serverLatest);
  if (!key) return dirty; // no envelope for us yet; a member who holds the key will wrap one

  const current = new Set(devices.map((d) => d.deviceId));
  const record = vault.recipients[channelId];

  // A device that received the latest key has left the server (kick): rotate to a new version for the remaining members.
  if (record?.version === serverLatest && record.deviceIds.some((id) => !current.has(id))) {
    const next = serverLatest + 1;
    const fresh = generateAesKeyBytes();
    putKey(channelId, next, fresh);
    await publishKey(channelId, next, fresh, devices);
    return true;
  }

  // We hold the latest key: wrap every version we hold for any member device the server reports as missing the latest.
  // A new device needs the full history, so older versions go to it too.
  const missing = devices.filter((d) => status.devicesMissing.includes(d.deviceId));
  if (missing.length > 0) {
    for (const version of localVersions(channelId)) {
      await wrapFor(channelId, version, localKey(channelId, version)!, missing);
    }
    vault.recipients[channelId] = {
      version: serverLatest,
      deviceIds: [...new Set([...(record?.version === serverLatest ? record.deviceIds : []), ...missing.map((d) => d.deviceId)])],
    };
    dirty = true;
  } else if (!record || record.version !== serverLatest) {
    // No record of who got this version (e.g. we received it over the socket): trust the current member list as the baseline.
    vault.recipients[channelId] = { version: serverLatest, deviceIds: [...current] };
    dirty = true;
  }
  return dirty;
}

async function publishKey(channelId: string, version: number, key: Bytes, targets: DeviceKeys[]): Promise<void> {
  await wrapFor(channelId, version, key, targets);
  vault.recipients[channelId] = { version, deviceIds: targets.map((d) => d.deviceId) };
}

async function wrapFor(channelId: string, version: number, key: Bytes, targets: DeviceKeys[]): Promise<void> {
  const me = getDevice();
  const signPrivate = privates!.sign;
  const envelopes = await Promise.all(targets.map((to) =>
    sealEnvelope({ channelId, keyVersion: version, channelKey: key, from: { deviceId: me.deviceId, signPrivate }, to })));
  await api.post(`/api/channels/${channelId}/keys`, { envelopes });
}

/** Process an incoming key.envelope frame. */
export function handleEnvelope(env: KeyEnvelope): Promise<void> {
  return serial(async () => {
    if (await acceptEnvelope(env)) {
      await persistVault();
      notify();
    }
  });
}

/**
 * Call on member.leave (after a kick). Rotates every channel of that server whose latest key we hold,
 * wrapping the new version only for the devices of members who remain. Does not depend on the caller's
 * member list being refreshed yet: the removed user's devices are filtered out here.
 */
export function handleMemberLeave(serverId: string, userId: string, servers: ServerBundle[]): Promise<void> {
  return serial(async () => {
    if (!device || !privates) return;
    const bundle = servers.find((b) => b.server.id === serverId);
    if (!bundle) return;
    const remaining = bundle.members.filter((m) => m.user.id !== userId).flatMap((m) => m.devices);
    let changed = false;
    for (const channel of bundle.channels) {
      changed = (await rotateIfHeld(channel.id, remaining)) || changed;
    }
    if (changed) {
      await persistVault();
      notify();
    }
  });
}

async function rotateIfHeld(channelId: string, devices: DeviceKeys[]): Promise<boolean> {
  const status = await api.get<{ latestVersion: number }>(`/api/channels/${channelId}/key-status`);
  if (status.latestVersion === 0 || !localKey(channelId, status.latestVersion)) return false;
  const next = status.latestVersion + 1;
  const fresh = generateAesKeyBytes();
  putKey(channelId, next, fresh);
  await publishKey(channelId, next, fresh, devices);
  return true;
}

/** Verifies the sender against the member directory, then unwraps into the vault. Caller persists. */
async function acceptEnvelope(env: KeyEnvelope): Promise<boolean> {
  const me = getDevice();
  if (env.toDeviceId !== me.deviceId || localKey(env.channelId, env.keyVersion)) return false;
  const sender = knownDevices().get(env.fromDeviceId);
  if (!sender) return false;
  const key = await openEnvelope({
    env,
    senderSignPublic: await importSignPublic(fromB64(sender.signPublic)),
    recipientPriv: privates!.ecdh,
    recipientPublic: me.ecdhPublic,
  });
  if (!key) return false;
  putKey(env.channelId, env.keyVersion, key);
  return true;
}

function knownDevices(): Map<string, DeviceKeys> {
  const map = new Map<string, DeviceKeys>();
  for (const bundle of useSession.getState().servers) {
    for (const member of bundle.members) for (const d of member.devices) map.set(d.deviceId, d);
  }
  return map;
}

function localVersions(channelId: string): number[] {
  return Object.keys(vault.channels[channelId] ?? {}).map(Number).sort((a, b) => a - b);
}

function localLatest(channelId: string): number {
  const versions = localVersions(channelId);
  return versions.length ? versions[versions.length - 1] : 0;
}

function localKey(channelId: string, version: number): Bytes | null {
  const encoded = vault.channels[channelId]?.[String(version)];
  return encoded ? fromB64(encoded) : null;
}

function putKey(channelId: string, version: number, key: Bytes): void {
  vault.channels[channelId] = { ...vault.channels[channelId], [String(version)]: toB64(key) };
}

function aesKeyFor(channelId: string, version: number): Promise<CryptoKey> | null {
  const id = `${channelId}#${version}`;
  let cached = aesCache.get(id);
  if (!cached) {
    const raw = localKey(channelId, version);
    if (!raw) return null;
    cached = importAesKey(raw);
    aesCache.set(id, cached);
  }
  return cached;
}

function messageAad(channelId: string, keyVersion: number, authorId: string): Bytes {
  return utf8(`${channelId}|${keyVersion}|${authorId}`);
}

function notify(): void {
  for (const cb of listeners) cb();
}

export async function encryptPayload(channelId: string, authorId: string, payload: MessagePayload): Promise<{ ciphertext: string; keyVersion: number }> {
  const keyVersion = localLatest(channelId);
  const key = keyVersion > 0 ? aesKeyFor(channelId, keyVersion) : null;
  if (!key) throw new Error('No channel key yet');
  const sealed = await aesSeal(await key, utf8(JSON.stringify(payload)), messageAad(channelId, keyVersion, authorId));
  return { ciphertext: toB64(sealed), keyVersion };
}

/** null if key not available (yet) or authentication fails */
export async function decryptMessage(msg: Message): Promise<MessagePayload | null> {
  try {
    const key = aesKeyFor(msg.channelId, msg.keyVersion);
    if (!key) return null;
    const plain = await aesOpen(await key, fromB64(msg.ciphertext), messageAad(msg.channelId, msg.keyVersion, msg.authorId));
    const payload = JSON.parse(new TextDecoder().decode(plain)) as MessagePayload;
    return typeof payload.text === 'string' ? payload : null;
  } catch {
    return null;
  }
}

/** Called whenever new channel keys become available so views can retry decrypting. Returns unsubscribe. */
export function onKeysChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export async function encryptBlob(bytes: Uint8Array): Promise<{ blob: Uint8Array; key: string; iv: string }> {
  const raw = generateAesKeyBytes();
  const iv = randomBytes(IV_BYTES);
  const blob = await aesEncryptWith(await importAesKey(raw), iv, new Uint8Array(bytes));
  return { blob, key: toB64(raw), iv: toB64(iv) };
}

export async function decryptBlob(blob: Uint8Array, key: string, iv: string): Promise<Uint8Array> {
  return aesDecryptWith(await importAesKey(fromB64(key)), fromB64(iv), new Uint8Array(blob));
}

/** 32-byte media key for LiveKit E2EE derived from the channel key; null if unavailable. */
export async function voiceKey(channelId: string): Promise<Uint8Array | null> {
  const version = localLatest(channelId);
  const raw = version > 0 ? localKey(channelId, version) : null;
  if (!raw) return null;
  return hkdf(raw, utf8(channelId), utf8('chatward-voice'), KEY_BYTES);
}
