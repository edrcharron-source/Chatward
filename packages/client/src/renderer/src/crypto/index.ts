// E2EE module. The exported API is the one the app uses; internals run on MLS (RFC 9420) via ./mls.
// Membership and epoch changes come from Commits. Message keys are per-epoch history keys derived from each epoch's
// MLS exporter, so they are never sent on the wire. A device that joins gets the current key from its Welcome and
// older keys from existing members as v1 envelopes. Threat model and tradeoffs: see ./README.md.
import type { DeviceKeys, KeyEnvelope, Member, Message, MessagePayload } from '@chatward/shared';
import type { ClientState } from 'ts-mls';
import { api, ApiError } from '../api/http';
import { isDemo } from '../demo';
import { demoDecode, demoEncode } from '../demo/codec';
import { useSession, type ServerBundle } from '../state/session';
import { openEnvelope, sealEnvelope } from './envelope';
import * as mls from './mls';
import {
  aesDecryptWith, aesEncryptWith, aesOpen, aesSeal, Bytes, exportJwk, exportRawPublic, fromB64, generateAesKeyBytes,
  generateEcdh, generateSigning, importAesKey, importEcdhPrivate, importSignPrivate, importSignPublic, IV_BYTES, randomBytes,
  toB64, utf8,
} from './primitives';

export { safetyNumber } from './safety';

// Local vault. Stored only through window.chatward.secureStore, which the main process encrypts with safeStorage.
interface StoredDevice extends DeviceKeys {
  ecdhPrivate: JsonWebKey;
  signPrivate: JsonWebKey;
}

interface Vault {
  /** channelId -> keyVersion -> base64 AES-256 history key. keyVersion = MLS epoch + 1. */
  channels: Record<string, Record<string, string>>;
  /** channelId -> serialized MLS group state at `epoch` */
  groups: Record<string, { epoch: number; state: string }>;
  /** channelId -> devices that already received every history key we hold */
  shared: Record<string, string[]>;
  /** KeyPackage wire string -> private parts. Single-use entries are removed once a Welcome consumes them. */
  pool: Record<string, mls.StoredKeyPackage>;
}

// Before accounts had their own keys, the PC's single device and vault lived under these two keys.
const LEGACY_DEVICE_STORE = 'crypto.device.v1';
const LEGACY_VAULT_STORE = 'crypto.vault.v2';
/** Refill the single-use KeyPackage pool when the server reports fewer than this. */
const KEYPACKAGE_LOW_WATER = 5;
const KEYPACKAGE_BATCH = 10;

let account: string | null = null;
let device: DeviceKeys | null = null;
let privates: { ecdh: CryptoKey; sign: CryptoKey } | null = null;
let vault: Vault = emptyVault();
const aesCache = new Map<string, Promise<CryptoKey>>();
const groupStates = new Map<string, ClientState>();
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

function emptyVault(): Vault {
  return { channels: {}, groups: {}, shared: {}, pool: {} };
}

/** Each account on this PC has its own device keys and vault. The key is the server address plus the username. */
export function accountKey(serverUrl: string, username: string): string {
  return `${serverUrl.replace(/\/$/, '')}|${username}`;
}

const deviceStore = (acct: string) => `crypto.device.v2|${acct}`;
const vaultStore = (acct: string) => `crypto.vault.v2|${acct}`;

function currentAccount(): string {
  if (account === null) throw new Error('No account is active; call initDevice() first');
  return account;
}

function persistVault(): Promise<void> {
  return secureStore().set(vaultStore(currentAccount()), JSON.stringify(vault));
}

async function newStoredDevice(): Promise<StoredDevice> {
  const ecdh = await generateEcdh();
  const sign = await generateSigning();
  return {
    deviceId: crypto.randomUUID(),
    ecdhPublic: toB64(await exportRawPublic(ecdh.publicKey)),
    signPublic: toB64(await exportRawPublic(sign.publicKey)),
    ecdhPrivate: await exportJwk(ecdh.privateKey),
    signPrivate: await exportJwk(sign.privateKey),
  };
}

async function useDevice(stored: StoredDevice): Promise<void> {
  privates = { ecdh: await importEcdhPrivate(stored.ecdhPrivate), sign: await importSignPrivate(stored.signPrivate) };
  device = { deviceId: stored.deviceId, ecdhPublic: stored.ecdhPublic, signPublic: stored.signPublic };
}

/** Loads this account's device and vault, creating them on first use. The first account to start after an update takes over the legacy device and vault. */
async function loadAccount(acct: string): Promise<{ stored: StoredDevice; vault: Vault }> {
  const own = await readStored<StoredDevice>(deviceStore(acct));
  if (own) return { stored: own, vault: (await readStored<Vault>(vaultStore(acct))) ?? emptyVault() };

  const legacy = await readStored<StoredDevice>(LEGACY_DEVICE_STORE);
  const stored = legacy ?? (await newStoredDevice());
  const legacyVault = legacy ? await readStored<Vault>(LEGACY_VAULT_STORE) : null;
  const loaded = { stored, vault: legacyVault ?? emptyVault() };
  await secureStore().set(deviceStore(acct), JSON.stringify(stored));
  await secureStore().set(vaultStore(acct), JSON.stringify(loaded.vault));
  if (legacy) {
    await secureStore().set(LEGACY_DEVICE_STORE, '');
    await secureStore().set(LEGACY_VAULT_STORE, '');
  }
  return loaded;
}

/** Load or create this account's device keypairs (stored via window.chatward.secureStore). Registers nothing on the server. */
export function initDevice(acct: string): Promise<DeviceKeys> {
  return serial(async () => {
    if (acct !== account || !device) {
      const loaded = await loadAccount(acct);
      await useDevice(loaded.stored);
      vault = loaded.vault;
      account = acct;
      groupStates.clear();
      aesCache.clear();
    }
    return getDevice();
  });
}

/** Give the current account a brand-new device and an empty vault. Used when the server says this device id belongs to another account. */
export function renewDevice(): Promise<DeviceKeys> {
  return serial(async () => {
    const stored = await newStoredDevice();
    await secureStore().set(deviceStore(currentAccount()), JSON.stringify(stored));
    await useDevice(stored);
    vault = emptyVault();
    groupStates.clear();
    aesCache.clear();
    await persistVault();
    return getDevice();
  });
}

/** Public keys of this device (valid after initDevice). Sent in register/login bodies. */
export function getDevice(): DeviceKeys {
  if (!device) throw new Error('Device keys are not initialised; call initDevice() first');
  return device;
}

/** Bring every text channel of every server up to date: join or create its group, follow Commits, reconcile members, share history. Idempotent. */
export function syncChannelKeys(servers: ServerBundle[]): Promise<void> {
  return serial(async () => {
    if (isDemo() || !device || !privates) return;
    let changed = await ensureKeyPool();
    for (const bundle of servers) {
      for (const channel of bundle.channels) {
        if (channel.kind !== 'text') continue;
        changed = (await syncChannel(channel.id, bundle.members)) || changed;
      }
    }
    if (changed) {
      await persistVault();
      notify();
    }
  });
}

async function syncChannel(channelId: string, members: Member[]): Promise<boolean> {
  const me = getDevice();
  let dirty = false;
  const mine = await api.get<{ envelopes: KeyEnvelope[] }>(`/api/channels/${channelId}/keys?deviceId=${encodeURIComponent(me.deviceId)}`);
  for (const env of mine.envelopes) dirty = (await acceptEnvelope(env)) || dirty;
  dirty = (await ensureGroup(channelId, members)) || dirty;
  dirty = (await reconcile(channelId, members)) || dirty;
  dirty = (await shareHistory(channelId, members.flatMap((m) => m.devices))) || dirty;
  return dirty;
}

/** Keep a supply of single-use KeyPackages on the server, plus one last-resort package. */
async function ensureKeyPool(): Promise<boolean> {
  const me = getDevice();
  const count = await api.get<{ available: number }>(`/api/devices/${encodeURIComponent(me.deviceId)}/keypackages/count`);
  const needLastResort = !Object.values(vault.pool).some((entry) => entry.lastResort);
  if (count.available >= KEYPACKAGE_LOW_WATER && !needLastResort) return false;
  const size = count.available >= KEYPACKAGE_LOW_WATER ? 0 : KEYPACKAGE_BATCH;
  const made: { kp: string; keys: mls.MemberKeys; lastResort: boolean }[] = [];
  for (let i = 0; i < size; i++) made.push(await newKeyPackage(false));
  if (needLastResort) made.push(await newKeyPackage(true));
  await api.post('/api/devices/keypackages', {
    deviceId: me.deviceId,
    keyPackages: made.map((m) => ({ kp: m.kp, lastResort: m.lastResort })),
  });
  for (const m of made) vault.pool[m.kp] = mls.storeKeyPackage(m.keys, m.kp, m.lastResort);
  return made.length > 0;
}

async function newKeyPackage(lastResort: boolean) {
  const keys = await mls.newMemberKeys({ deviceId: getDevice().deviceId, signPrivate: privates!.sign });
  return { kp: await mls.encodeKeyPackage(keys), keys, lastResort };
}

/** Group state for a channel, or null if we are not in it. */
function groupOf(channelId: string): ClientState | null {
  const cached = groupStates.get(channelId);
  if (cached) return cached;
  const stored = vault.groups[channelId];
  if (!stored) return null;
  const state = mls.decodeGroup(fromB64(stored.state), deviceDirectory());
  groupStates.set(channelId, state);
  return state;
}

/** Save a new group state and derive the history key for its epoch. */
async function setGroup(channelId: string, state: ClientState, epoch: number): Promise<void> {
  groupStates.set(channelId, state);
  vault.groups[channelId] = { epoch, state: toB64(mls.encodeGroup(state) as Bytes as Uint8Array<ArrayBuffer>) };
  putKey(channelId, epoch + 1, await mls.historyKey(state));
}

async function ensureGroup(channelId: string, members: Member[]): Promise<boolean> {
  if (groupOf(channelId)) return catchUp(channelId);
  const me = getDevice();
  const welcomes = await api.get<{ welcomes: { epoch: number; toDeviceId: string; welcome: string }[] }>(`/api/groups/${channelId}/welcomes`);
  const latest = welcomes.welcomes.filter((w) => w.toDeviceId === me.deviceId).at(-1);
  if (latest) {
    const state = await joinFromPool(latest.welcome);
    if (!state) return false;
    await setGroup(channelId, state, latest.epoch);
    return true;
  }
  // No Welcome for us. Create the group only if nobody has committed yet; otherwise an existing member adds us.
  const info = await api.get<{ epoch: number }>(`/api/groups/${channelId}/commits?from=0`);
  if (info.epoch !== 0) return false;
  return createGroup(channelId, members);
}

async function joinFromPool(welcome: string): Promise<ClientState | null> {
  for (const [kp, entry] of Object.entries(vault.pool)) {
    try {
      const state = await mls.joinFromWelcome(fromB64(welcome), mls.restoreKeyPackage(entry), deviceDirectory());
      if (!entry.lastResort) delete vault.pool[kp];
      return state;
    } catch {
      // Not the KeyPackage this Welcome was made for.
    }
  }
  return null;
}

async function createGroup(channelId: string, members: Member[]): Promise<boolean> {
  const me = getDevice();
  const solo = await mls.createMlsGroup(
    channelId, await mls.newMemberKeys({ deviceId: me.deviceId, signPrivate: privates!.sign }), deviceDirectory(),
  );
  const added = await claimFor(members, new Set(members.flatMap((m) => m.devices).map((d) => d.deviceId).filter((id) => id !== me.deviceId)));
  const step = added.length ? await mls.addMembers(solo, added.map((a) => a.kp)) : await mls.selfUpdate(solo);
  // Publishing the commit is what makes this the group. A 409 means another device created it first; we join by Welcome.
  const outcome = await postCommit(channelId, 0, step, [me.deviceId, ...added.map((a) => a.deviceId)], added.map((a) => a.deviceId));
  if (outcome === 'conflict') return false;
  await setGroup(channelId, step.state, 1);
  return true;
}

/**
 * Apply Commits we have not seen. A Commit that will not apply is not ours to trust, and any member can post one, so we
 * keep the last state we could apply and ask the server to drop that Commit. The group then moves on from its epoch.
 */
async function catchUp(channelId: string): Promise<boolean> {
  const stored = vault.groups[channelId];
  let state = groupOf(channelId)!;
  let epoch = stored.epoch;
  const res = await api.get<{ commits: { epoch: number; commit: string }[] }>(`/api/groups/${channelId}/commits?from=${epoch}`);
  if (res.commits.length === 0) return false;
  let stuck = false;
  for (const c of res.commits) {
    if (c.epoch !== epoch) break;
    try {
      state = (await mls.receive(state, fromB64(c.commit))).state;
    } catch {
      stuck = true;
      break;
    }
    epoch += 1;
  }
  const moved = epoch !== stored.epoch;
  if (moved) await setGroup(channelId, state, epoch);
  if (stuck) await dropCommitsFrom(channelId, epoch);
  return moved;
}

/** Ask the server to drop the Commit at `epoch` and everything after it. A failure here is logged, not fatal to sync. */
async function dropCommitsFrom(channelId: string, epoch: number): Promise<void> {
  const me = getDevice();
  try {
    await api.post(`/api/groups/${channelId}/reset`, { deviceId: me.deviceId, epoch });
  } catch (err) {
    console.warn(`Could not drop an unreadable commit in channel ${channelId}`, err);
  }
}

/** Remove devices that left the server, then add devices that joined it. Each step is one Commit. */
async function reconcile(channelId: string, members: Member[]): Promise<boolean> {
  const me = getDevice();
  let state = groupOf(channelId);
  if (!state) return false;
  let epoch = vault.groups[channelId].epoch;
  const live = new Set(members.flatMap((m) => m.devices).map((d) => d.deviceId));
  let changed = false;

  const gone = mls.memberLeaves(state).filter((l) => !live.has(l.deviceId));
  if (gone.length) {
    const step = await mls.removeMembers(state, gone.map((l) => l.leafIndex));
    const remaining = mls.memberLeaves(step.state).map((l) => l.deviceId);
    if ((await postCommit(channelId, epoch, step, remaining, [])) === 'conflict') return (await catchUp(channelId)) || changed;
    await setGroup(channelId, step.state, epoch + 1);
    state = step.state;
    epoch += 1;
    changed = true;
  }

  const inGroup = new Set(mls.memberLeaves(state).map((l) => l.deviceId));
  const wanted = new Set([...live].filter((id) => !inGroup.has(id) && id !== me.deviceId));
  if (wanted.size === 0) return changed;
  const added = await claimFor(members, wanted);
  if (added.length === 0) return changed;
  const step = await mls.addMembers(state, added.map((a) => a.kp));
  const after = [...inGroup, ...added.map((a) => a.deviceId)];
  if ((await postCommit(channelId, epoch, step, after, added.map((a) => a.deviceId))) === 'conflict') return (await catchUp(channelId)) || changed;
  await setGroup(channelId, step.state, epoch + 1);
  return true;
}

/** Claim one KeyPackage per wanted device, one request per user who has any wanted device. */
async function claimFor(members: Member[], wanted: Set<string>): Promise<{ deviceId: string; kp: mls.KeyPackageLike }[]> {
  const out: { deviceId: string; kp: mls.KeyPackageLike }[] = [];
  for (const m of members) {
    if (!m.devices.some((d) => wanted.has(d.deviceId))) continue;
    const r = await api.get<{ keyPackages: { deviceId: string; kp: string }[] }>(`/api/users/${m.user.id}/keypackages`);
    for (const k of r.keyPackages) if (wanted.has(k.deviceId)) out.push({ deviceId: k.deviceId, kp: mls.decodeKeyPackage(k.kp) });
  }
  return out;
}

async function postCommit(channelId: string, epoch: number, step: mls.GroupStep, members: string[], welcomeTo: string[]): Promise<'ok' | 'conflict'> {
  const me = getDevice();
  const welcome = step.welcome ? toB64(step.welcome as Uint8Array<ArrayBuffer>) : null;
  try {
    await api.post(`/api/groups/${channelId}/commits`, {
      deviceId: me.deviceId,
      epoch,
      commit: toB64(step.commit as Uint8Array<ArrayBuffer>),
      members,
      welcomes: welcomeTo.map((toDeviceId) => ({ toDeviceId, welcome })),
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) return 'conflict';
    throw err;
  }
  mls.settle(step);
  return 'ok';
}

/** Send every history key we hold to devices that do not have them yet. Drops devices that left the server. */
async function shareHistory(channelId: string, devices: DeviceKeys[]): Promise<boolean> {
  const me = getDevice();
  const live = new Set(devices.map((d) => d.deviceId));
  const before = vault.shared[channelId] ?? [];
  const done = before.filter((id) => live.has(id));
  const targets = devices.filter((d) => d.deviceId !== me.deviceId && !done.includes(d.deviceId));
  const versions = localVersions(channelId);
  if (targets.length && versions.length) {
    for (const version of versions) await wrapFor(channelId, version, localKey(channelId, version)!, targets);
    vault.shared[channelId] = [...done, ...targets.map((d) => d.deviceId)];
    return true;
  }
  if (done.length !== before.length) vault.shared[channelId] = done;
  return done.length !== before.length;
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
    if (isDemo()) return;
    if (await acceptEnvelope(env)) {
      await persistVault();
      notify();
    }
  });
}

/**
 * Call on member.leave (after a kick). Runs the channel sync for the server without the removed user, so the
 * remaining members commit the Remove. Keys the removed user already held are not erased.
 */
export function handleMemberLeave(serverId: string, userId: string, servers: ServerBundle[]): Promise<void> {
  return serial(async () => {
    if (isDemo() || !device || !privates) return;
    const bundle = servers.find((b) => b.server.id === serverId);
    if (!bundle) return;
    const remaining = bundle.members.filter((m) => m.user.id !== userId);
    let changed = false;
    for (const channel of bundle.channels) {
      if (channel.kind !== 'text') continue;
      changed = (await syncChannel(channel.id, remaining)) || changed;
    }
    if (changed) {
      await persistVault();
      notify();
    }
  });
}

/** Verifies the sender against the member directory, then stores the history key. Caller persists. */
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

/** MLS credentials are accepted only if they name a device from this list and are signed by that device's key. */
function deviceDirectory(): mls.DeviceDirectory {
  return (deviceId) => knownDevices().get(deviceId)?.signPublic;
}

function localVersions(channelId: string): number[] {
  return Object.keys(vault.channels[channelId] ?? {}).map(Number).sort((a, b) => a - b);
}

function localKey(channelId: string, version: number): Bytes | null {
  const encoded = vault.channels[channelId]?.[String(version)];
  return encoded ? fromB64(encoded) : null;
}

function putKey(channelId: string, version: number, key: Bytes): void {
  vault.channels[channelId] = { ...vault.channels[channelId], [String(version)]: toB64(key as Uint8Array<ArrayBuffer>) };
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
  if (isDemo()) return { ciphertext: demoEncode(payload), keyVersion: 1 };
  const stored = vault.groups[channelId];
  if (!stored) throw new Error('No channel key yet');
  const keyVersion = stored.epoch + 1;
  const key = aesKeyFor(channelId, keyVersion);
  if (!key) throw new Error('No channel key yet');
  const sealed = await aesSeal(await key, utf8(JSON.stringify(payload)), messageAad(channelId, keyVersion, authorId));
  return { ciphertext: toB64(sealed as Uint8Array<ArrayBuffer>), keyVersion };
}

/** null if key not available (yet) or authentication fails */
export async function decryptMessage(msg: Message): Promise<MessagePayload | null> {
  if (isDemo()) return demoDecode(msg.ciphertext);
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
  if (isDemo()) return { blob: bytes, key: '', iv: '' };
  const raw = generateAesKeyBytes();
  const iv = randomBytes(IV_BYTES);
  const blob = await aesEncryptWith(await importAesKey(raw), iv, new Uint8Array(bytes));
  return { blob, key: toB64(raw), iv: toB64(iv) };
}

export async function decryptBlob(blob: Uint8Array, key: string, iv: string): Promise<Uint8Array> {
  if (isDemo()) return blob;
  return aesDecryptWith(await importAesKey(fromB64(key)), fromB64(iv), new Uint8Array(blob));
}

/**
 * LiveKit E2EE key for a voice channel. Voice has no group of its own: it uses the MLS exporter of the first text
 * channel of the same server, so everyone in the server's current epoch derives the same key. null if unavailable.
 */
export async function voiceKey(channelId: string): Promise<Uint8Array | null> {
  const textChannel = textChannelOf(channelId) ?? channelId;
  const state = groupOf(textChannel);
  return state ? mls.voiceKey(state) : null;
}

function textChannelOf(channelId: string): string | null {
  for (const bundle of useSession.getState().servers) {
    if (!bundle.channels.some((c) => c.id === channelId)) continue;
    return bundle.channels.find((c) => c.kind === 'text')?.id ?? null;
  }
  return null;
}
