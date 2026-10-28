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
  sha256, toB64, utf8,
} from './primitives';

import { safetyNumber } from './safety';

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
  /** userId -> safety number we accepted for that person. Set the first time we see them, then changes need a check. */
  trusted: Record<string, string>;
  /** userId -> the contact's new safety number and name, while it differs from the one we trusted. */
  changed: Record<string, { name: string; number: string }>;
}

// Before accounts had their own keys, the PC's single device and vault lived under these two keys.
const LEGACY_DEVICE_STORE = 'crypto.device.v1';
const LEGACY_VAULT_STORE = 'crypto.vault.v2';
/** Refill the single-use KeyPackage pool when the server reports fewer than this. */
const KEYPACKAGE_LOW_WATER = 5;
const KEYPACKAGE_BATCH = 10;
/** Devices added per Commit. One Commit per device list grows past the server's body limit once a channel has ~8 devices. */
const ADD_BATCH_SIZE = 4;

let account: string | null = null;
let device: DeviceKeys | null = null;
let privates: { ecdh: CryptoKey; sign: CryptoKey } | null = null;
let vault: Vault = emptyVault();
const aesCache = new Map<string, Promise<CryptoKey>>();
const groupStates = new Map<string, ClientState>();
/** Devices that have been in one of our groups but may no longer be on any server we are in. From the server's group device list. */
const groupDevices = new Map<string, DeviceKeys>();
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
  return { channels: {}, groups: {}, shared: {}, pool: {}, trusted: {}, changed: {} };
}

/**
 * Each account on this PC has its own device keys and vault. The key is the server address plus the username.
 * The server treats usernames case-insensitively ("Ed" and "ed" are one account), so the username is lowercased here
 * no matter how it was typed or how the server returns it.
 */
export function accountKey(serverUrl: string, username: string): string {
  return `${serverUrl.replace(/\/$/, '')}|${username.toLowerCase()}`;
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

/** Loads this account's device and vault, creating an empty account on first use. Never reads the legacy device: that one is only adopted after the server confirms it belongs to this account. */
async function loadAccount(acct: string): Promise<{ stored: StoredDevice; vault: Vault }> {
  const own = await readStored<StoredDevice>(deviceStore(acct));
  if (own) return { stored: own, vault: (await readStored<Vault>(vaultStore(acct))) ?? emptyVault() };

  const stored = await newStoredDevice();
  const vault = emptyVault();
  await secureStore().set(deviceStore(acct), JSON.stringify(stored));
  await secureStore().set(vaultStore(acct), JSON.stringify(vault));
  return { stored, vault };
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

/** The device and vault from before per-account keys, if this PC still has them. Not used until the server accepts the device. */
export async function legacyDevice(): Promise<DeviceKeys | null> {
  const stored = await readStored<StoredDevice>(LEGACY_DEVICE_STORE);
  return stored ? { deviceId: stored.deviceId, ecdhPublic: stored.ecdhPublic, signPublic: stored.signPublic } : null;
}

/** Gives the current account the legacy device and vault. Call only after the server accepted the legacy device for this account. */
export function adoptLegacyDevice(): Promise<DeviceKeys> {
  return serial(async () => {
    const stored = await readStored<StoredDevice>(LEGACY_DEVICE_STORE);
    if (!stored) return getDevice();
    const legacyVault = (await readStored<Vault>(LEGACY_VAULT_STORE)) ?? emptyVault();
    await secureStore().set(deviceStore(currentAccount()), JSON.stringify(stored));
    await useDevice(stored);
    vault = legacyVault;
    groupStates.clear();
    aesCache.clear();
    await persistVault();
    await secureStore().set(LEGACY_DEVICE_STORE, '');
    await secureStore().set(LEGACY_VAULT_STORE, '');
    return getDevice();
  });
}

/** On app start: if the server says the legacy device belongs to the active account, adopt it. Any other answer, or no server, leaves the account's own device in place. */
export async function adoptLegacyIfOwned(): Promise<void> {
  const legacy = await legacyDevice();
  if (!legacy) return;
  try {
    const { owned } = await api.get<{ owned: boolean }>(`/api/me/devices/${legacy.deviceId}`);
    if (owned) await adoptLegacyDevice();
  } catch {
    // Offline or the check failed: keep the account's own device and try again next start.
  }
}

/** Public keys of this device (valid after initDevice). Sent in register/login bodies. */
export function getDevice(): DeviceKeys {
  if (!device) throw new Error('Device keys are not initialised; call initDevice() first');
  return device;
}

const SYNC_RETRY_MAX_MS = 60_000;
let lastServers: ServerBundle[] = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;

/** Bring every text channel of every server up to date: join or create its group, follow Commits, reconcile members, share history. Idempotent. */
export function syncChannelKeys(servers: ServerBundle[]): Promise<void> {
  return serial(async () => {
    if (isDemo() || !device || !privates) return;
    lastServers = servers;
    let changed = false;
    let failed = false;
    try {
      changed = await ensureKeyPool();
    } catch (err) {
      failed = true;
      console.error('Could not top up KeyPackages; will retry', err);
    }
    // One channel failing must not stop the others. Its partial progress is still saved below.
    for (const bundle of servers) {
      for (const channel of bundle.channels) {
        if (channel.kind !== 'text') continue;
        try {
          changed = (await syncChannel(channel.id, bundle.members)) || changed;
        } catch (err) {
          failed = true;
          changed = true;
          console.error(`Could not sync keys for channel ${channel.id}; will retry`, err);
        }
      }
    }
    changed = (await checkContactKeys(servers)) || changed;
    if (changed) {
      await persistVault();
      notify();
    }
    scheduleSyncRetry(failed);
  });
}

/** After a failed sync, run the whole sync again later with growing delays. A clean sync stops the retries. */
function scheduleSyncRetry(failed: boolean): void {
  if (!failed) {
    retryAttempts = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    return;
  }
  if (retryTimer) return;
  const delay = Math.min(SYNC_RETRY_MAX_MS, 2_000 * 2 ** retryAttempts);
  retryAttempts++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void syncChannelKeys(lastServers).catch((err) => console.error('Key sync retry failed', err));
  }, delay);
}

async function syncChannel(channelId: string, members: Member[]): Promise<boolean> {
  const me = getDevice();
  let dirty = false;
  const mine = await api.get<{ envelopes: KeyEnvelope[] }>(`/api/channels/${channelId}/keys?deviceId=${encodeURIComponent(me.deviceId)}`);
  for (const env of mine.envelopes) dirty = (await acceptEnvelope(env)) || dirty;
  await loadGroupDevices(channelId);
  dirty = (await ensureGroup(channelId, members)) || dirty;
  dirty = (await reconcile(channelId, members)) || dirty;
  dirty = (await shareHistory(channelId, members.flatMap((m) => m.devices))) || dirty;
  await reportEpoch(channelId);
  return dirty;
}

/** Pull the registered keys of every device that has ever been in this group, so old Commits still verify. */
async function loadGroupDevices(channelId: string): Promise<void> {
  const res = await api.get<{ devices: DeviceKeys[] }>(`/api/groups/${channelId}/devices`);
  for (const d of res.devices) groupDevices.set(d.deviceId, { deviceId: d.deviceId, ecdhPublic: d.ecdhPublic, signPublic: d.signPublic });
}

/**
 * Tell the server which epoch this device has reached, so a reset cannot drop Commits this device already built on.
 * Sent on every sync, so a report lost to the network is repeated on the next one.
 */
async function reportEpoch(channelId: string): Promise<void> {
  const stored = vault.groups[channelId];
  if (!stored) return;
  try {
    await api.post(`/api/groups/${channelId}/epoch`, { deviceId: getDevice().deviceId, epoch: stored.epoch });
  } catch (err) {
    console.warn(`Could not report the epoch for channel ${channelId}`, err);
  }
}

/** Same id the server reports for a KeyPackage: base64 SHA-256 of its wire string. */
async function keyPackageId(kp: string): Promise<string> {
  return toB64(await sha256(utf8(kp)));
}

/**
 * Compare each contact's safety number with the one we trusted. The first sighting is trusted silently. A later
 * change is kept in vault.changed until the user accepts it, so a swapped key cannot pass unnoticed.
 */
async function checkContactKeys(servers: ServerBundle[]): Promise<boolean> {
  const me = getDevice();
  const people = new Map<string, Member>();
  for (const bundle of servers) for (const m of bundle.members) people.set(m.user.id, m);
  let dirty = false;
  for (const member of people.values()) {
    if (member.devices.length === 0 || member.devices.some((d) => d.deviceId === me.deviceId)) continue;
    const id = member.user.id;
    const number = await safetyNumber(member.devices);
    const trusted = vault.trusted[id];
    if (!trusted) {
      vault.trusted[id] = number;
      dirty = true;
    } else if (number !== trusted && vault.changed[id]?.number !== number) {
      vault.changed[id] = { name: member.user.displayName, number };
      dirty = true;
    } else if (number === trusted && vault.changed[id]) {
      delete vault.changed[id];
      dirty = true;
    }
  }
  return dirty;
}

/** Contacts whose keys changed since we last accepted them. Shown in Settings > Security. */
export function changedContacts(): { userId: string; name: string; number: string }[] {
  return Object.entries(vault.changed).map(([userId, change]) => ({ userId, ...change }));
}

/** The user has checked the new safety number with this contact. Trust the new keys from now on. */
export function acceptContactKeys(userId: string): Promise<void> {
  return serial(async () => {
    const change = vault.changed[userId];
    if (!change) return;
    vault.trusted[userId] = change.number;
    delete vault.changed[userId];
    await persistVault();
    notify();
  });
}

/**
 * Keep a supply of single-use KeyPackages on the server, plus one last-resort package that the server agrees is current.
 * Peers can only claim what the server holds, so a local last-resort package the server no longer has is dropped.
 */
async function ensureKeyPool(): Promise<boolean> {
  const me = getDevice();
  const count = await api.get<{ available: number; lastResort: string | null }>(`/api/devices/${encodeURIComponent(me.deviceId)}/keypackages/count`);
  let pruned = false;
  let serverHasLastResort = false;
  for (const [kp, entry] of Object.entries(vault.pool)) {
    if (!entry.lastResort) continue;
    if ((await keyPackageId(kp)) === count.lastResort) {
      serverHasLastResort = true;
    } else {
      delete vault.pool[kp];
      pruned = true;
    }
  }
  const needLastResort = !serverHasLastResort;
  if (count.available >= KEYPACKAGE_LOW_WATER && !needLastResort) return pruned;
  const size = count.available >= KEYPACKAGE_LOW_WATER ? 0 : KEYPACKAGE_BATCH;
  const made: { kp: string; keys: mls.MemberKeys; lastResort: boolean }[] = [];
  for (let i = 0; i < size; i++) made.push(await newKeyPackage(false));
  if (needLastResort) made.push(await newKeyPackage(true));
  // Save the private parts before the server can hand these packages to a peer. If the upload reply is lost, the server
  // may still hold them, and a Welcome made for one of them must find its private part here.
  for (const m of made) vault.pool[m.kp] = mls.storeKeyPackage(m.keys, m.kp, m.lastResort);
  if (made.length > 0) await persistVault();
  await api.post('/api/devices/keypackages', {
    deviceId: me.deviceId,
    keyPackages: made.map((m) => ({ kp: m.kp, lastResort: m.lastResort })),
  });
  return pruned || made.length > 0;
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

/**
 * Save a new group state and derive the history key for its epoch. The vault is written here, not at the end of sync:
 * the server has already accepted the Commit that produced this state, and if the app closes before a later write we
 * would come back one epoch behind and could never apply our own Commit again.
 */
async function setGroup(channelId: string, state: ClientState, epoch: number): Promise<void> {
  groupStates.set(channelId, state);
  vault.groups[channelId] = { epoch, state: toB64(mls.encodeGroup(state) as Bytes as Uint8Array<ArrayBuffer>) };
  putKey(channelId, epoch + 1, await mls.historyKey(state));
  await persistVault();
}

async function ensureGroup(channelId: string, members: Member[]): Promise<boolean> {
  let changed = false;
  const me = getDevice();
  const welcomes = await api.get<{ welcomes: { epoch: number; toDeviceId: string; welcome: string }[] }>(`/api/groups/${channelId}/welcomes`);
  const latest = welcomes.welcomes.filter((w) => w.toDeviceId === me.deviceId).at(-1);
  // A Welcome newer than our state means this device was added again after the state we hold (for example after a
  // kick). Our old state cannot follow the Commits that led to it, so drop it and join from the Welcome. Never reset.
  const stored = vault.groups[channelId];
  if (latest && stored && latest.epoch > stored.epoch) {
    forgetGroup(channelId);
    changed = true;
  }
  if (groupOf(channelId)) {
    changed = (await catchUp(channelId)) || changed;
    // Still in the group: nothing more to do. Otherwise catchUp forgot it, and we rejoin below.
    if (groupOf(channelId)) return changed;
  }
  if (latest) {
    const state = await joinFromPool(latest.welcome);
    if (!state) return changed;
    await setGroup(channelId, state, latest.epoch);
    return true;
  }
  // No Welcome for us. Create the group only if nobody has committed yet; otherwise an existing member adds us.
  const info = await api.get<{ epoch: number }>(`/api/groups/${channelId}/commits?from=0`);
  if (info.epoch !== 0) return changed;
  return (await createGroup(channelId, members)) || changed;
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
  // Only the first batch goes in here. reconcile, run right after in the same sync, adds the rest batch by batch.
  const others = members.flatMap((m) => m.devices).map((d) => d.deviceId).filter((id) => id !== me.deviceId);
  const added = await claimFor(members, new Set(others.slice(0, ADD_BATCH_SIZE)));
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
  const res = await api.get<{ epoch: number; commits: { epoch: number; commit: string }[] }>(`/api/groups/${channelId}/commits?from=${epoch}`);
  if (res.epoch < stored.epoch) {
    // The server is behind us: it dropped Commits we had applied. Our state no longer matches the server, so forget
    // the group and rejoin from a Welcome on the next step. Keys we already hold are kept.
    forgetGroup(channelId);
    return true;
  }
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
    // A Commit removed this device. Nothing after it applies to us, so forget the group. A later add rejoins from a Welcome.
    if (state.groupActiveState.kind === 'removedFromGroup') {
      forgetGroup(channelId);
      return true;
    }
  }
  const moved = epoch !== stored.epoch;
  if (moved) await setGroup(channelId, state, epoch);
  if (stuck) await dropCommitsFrom(channelId, epoch);
  return moved;
}

function forgetGroup(channelId: string): void {
  delete vault.groups[channelId];
  groupStates.delete(channelId);
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

  const present = mls.memberLeaves(state).map((l) => l.deviceId);
  const wanted = [...live].filter((id) => !present.includes(id) && id !== me.deviceId);
  // One Commit per batch of devices. Each Commit lists every device in the group after it, as the server stores that list.
  for (let i = 0; i < wanted.length; i += ADD_BATCH_SIZE) {
    const added = await claimFor(members, new Set(wanted.slice(i, i + ADD_BATCH_SIZE)));
    if (added.length === 0) continue;
    const step = await mls.addMembers(state, added.map((a) => a.kp));
    present.push(...added.map((a) => a.deviceId));
    if ((await postCommit(channelId, epoch, step, present, added.map((a) => a.deviceId))) === 'conflict') return (await catchUp(channelId)) || changed;
    await setGroup(channelId, step.state, epoch + 1);
    state = step.state;
    epoch += 1;
    changed = true;
  }
  return changed;
}

/** Claim one KeyPackage per wanted device, one request per user who has any wanted device. */
async function claimFor(members: Member[], wanted: Set<string>): Promise<{ deviceId: string; kp: mls.KeyPackageLike }[]> {
  const out: { deviceId: string; kp: mls.KeyPackageLike }[] = [];
  for (const m of members) {
    if (!m.devices.some((d) => wanted.has(d.deviceId))) continue;
    const r = await api.get<{ keyPackages: { deviceId: string; kp: string }[] }>(`/api/users/${m.user.id}/keypackages`);
    for (const k of r.keyPackages) {
      if (!wanted.has(k.deviceId)) continue;
      // A KeyPackage the server swapped in does not carry this device's signature, so it is never added.
      const device = m.devices.find((d) => d.deviceId === k.deviceId);
      const kp = mls.decodeKeyPackage(k.kp);
      if (!device || !(await mls.verifyKeyPackage(kp, device))) {
        console.warn(`Skipping a KeyPackage that does not belong to device ${k.deviceId}`);
        continue;
      }
      out.push({ deviceId: k.deviceId, kp });
    }
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
    // A retry must not sync with the removed user still listed, so it gets the same member list.
    lastServers = servers.map((b) => (b.server.id === serverId ? { ...b, members: remaining } : b));
    let changed = false;
    let failed = false;
    // One channel failing must not stop the others. Its partial progress is still saved below.
    for (const channel of bundle.channels) {
      if (channel.kind !== 'text') continue;
      try {
        changed = (await syncChannel(channel.id, remaining)) || changed;
      } catch (err) {
        failed = true;
        changed = true;
        console.error(`Could not sync keys for channel ${channel.id} after a member left; will retry`, err);
      }
    }
    if (changed) {
      await persistVault();
      notify();
    }
    // Only a failure schedules a retry. A clean pass here must not cancel a retry owed to another server.
    if (failed) scheduleSyncRetry(true);
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
  return (deviceId) => (knownDevices().get(deviceId) ?? groupDevices.get(deviceId))?.signPublic;
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
  // A replaced key must not keep decrypting with the CryptoKey imported from the old one.
  aesCache.delete(`${channelId}#${version}`);
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
