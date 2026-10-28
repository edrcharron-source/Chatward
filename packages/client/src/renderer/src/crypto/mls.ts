// MLS (RFC 9420) group layer on ts-mls. Pure functions over ClientState: no storage, no network.
// The server only relays the encoded bytes returned here (KeyPackages, Commits, Welcomes, application messages).
import {
  acceptAll, createApplicationMessage, createCommit, createGroup, decodeGroupState, decodeMlsMessage, defaultCapabilities,
  defaultKeyPackageEqualityConfig, defaultKeyRetentionConfig, defaultLifetime, defaultLifetimeConfig, defaultPaddingConfig,
  emptyPskIndex, encodeGroupState, encodeMlsMessage, generateKeyPackageWithKey, getCiphersuiteFromName, getCiphersuiteImpl,
  joinGroup, mlsExporter, processMessage, zeroOutUint8Array, type AuthenticationService, type CiphersuiteImpl, type ClientConfig,
  type ClientState, type Credential, type KeyPackage, type PrivateKeyPackage, type Proposal,
} from 'ts-mls';
import { concat, fromB64, importSignPublic, sign, toB64, utf8, verify } from './primitives';

// DHKEM-X25519 / AES-128-GCM / Ed25519 is the only suite ts-mls supports without extra crypto packages.
const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const WIRE_VERSION = 'mls10' as const;
const BINDING_LABEL = 'chatward-mls-binding|';

export type Bytes = Uint8Array;

export interface MemberKeys {
  publicPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
}

/** This device's identity: its server-registered id and the ECDSA private key that signs for it. */
export interface Device {
  deviceId: string;
  signPrivate: CryptoKey;
}

/** Base64 ECDSA signing key the server registered for a device, or undefined if the device is not known. */
export type DeviceDirectory = (deviceId: string) => string | undefined;

/** Identity inside a basic MLS credential: the device id, plus the device's signature over this leaf's MLS key. */
interface CredentialIdentity {
  deviceId: string;
  binding: string;
}

export interface GroupStep {
  state: ClientState;
  /** Encoded handshake message for existing members (absent for application messages). */
  commit?: Bytes;
  /** Encoded Welcome for the members added in this commit. */
  welcome?: Bytes;
  /** Keys consumed while creating the Commit. Pass to settle() once the server accepts it. */
  consumed: Bytes[];
}

export interface Received {
  state: ClientState;
  /** Decrypted application payload; absent when the message was a Commit. */
  plaintext?: Bytes;
}

let suite: Promise<CiphersuiteImpl> | null = null;

export function cipherSuite(): Promise<CiphersuiteImpl> {
  suite ??= getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
  return suite;
}

/** What the device signs to tie one MLS signature key to its device id. The label keeps it from meaning anything else. */
function bindingMessage(deviceId: string, mlsPublicKey: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(utf8(`${BINDING_LABEL}${deviceId}|`), mlsPublicKey as Uint8Array<ArrayBuffer>);
}

/**
 * Fresh KeyPackage for one device. The MLS signature key is generated here and signed by the device's
 * ECDSA key, so the credential proves "this MLS key belongs to that device". Only the real device can make it.
 */
export async function newMemberKeys(device: Device): Promise<MemberKeys> {
  const cs = await cipherSuite();
  const signatureKeyPair = await cs.signature.keygen();
  const binding = await sign(device.signPrivate, bindingMessage(device.deviceId, signatureKeyPair.publicKey));
  const identity: CredentialIdentity = { deviceId: device.deviceId, binding: toB64(binding) };
  const credential: Credential = { credentialType: 'basic', identity: utf8(JSON.stringify(identity)) };
  const { publicPackage, privatePackage } = await generateKeyPackageWithKey(
    credential, defaultCapabilities(), defaultLifetime, [], signatureKeyPair, cs,
  );
  return { publicPackage, privatePackage };
}

/** Reads a leaf's credential and checks it against the device the server registered for that id. */
function credentialAuthService(devices: DeviceDirectory): AuthenticationService {
  return {
    async validateCredential(credential, signaturePublicKey) {
      if (credential.credentialType !== 'basic') return false;
      const identity = parseIdentity(credential.identity);
      const registered = identity && devices(identity.deviceId);
      if (!identity || !registered) return false;
      return verify(
        await importSignPublic(fromB64(registered)),
        fromB64(identity.binding),
        bindingMessage(identity.deviceId, signaturePublicKey),
      );
    },
  };
}

function parseIdentity(identity: Uint8Array): CredentialIdentity | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(identity)) as Partial<CredentialIdentity>;
    return typeof parsed.deviceId === 'string' && typeof parsed.binding === 'string' ? (parsed as CredentialIdentity) : null;
  } catch {
    return null;
  }
}

/** Client config whose every Add, Commit and Welcome is checked against the server's device list. */
function clientConfigFor(devices: DeviceDirectory): ClientConfig {
  return {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: credentialAuthService(devices),
  };
}

/** Start a one-member group. The creator is leaf 0 at epoch 0. */
export async function createMlsGroup(groupId: string, creator: MemberKeys, devices: DeviceDirectory): Promise<ClientState> {
  return createGroup(utf8(groupId), creator.publicPackage, creator.privatePackage, [], await cipherSuite(), clientConfigFor(devices));
}

/** Add members in one Commit. The Welcome carries the ratchet tree, so joiners need nothing else. */
export async function addMembers(state: ClientState, keyPackages: KeyPackage[]): Promise<GroupStep> {
  const extraProposals: Proposal[] = keyPackages.map((keyPackage) => ({ proposalType: 'add', add: { keyPackage } }));
  return commit(state, { extraProposals });
}

/** Remove members by leaf index in one Commit. Removed members cannot decrypt anything from this epoch on. */
export async function removeMembers(state: ClientState, leafIndexes: number[]): Promise<GroupStep> {
  const extraProposals: Proposal[] = leafIndexes.map((removed) => ({ proposalType: 'remove', remove: { removed } }));
  return commit(state, { extraProposals });
}

/** Rotate our own leaf key (post-compromise security) without changing membership. */
export async function selfUpdate(state: ClientState): Promise<GroupStep> {
  return commit(state, {});
}

async function commit(state: ClientState, options: { extraProposals?: Proposal[] }): Promise<GroupStep> {
  const cs = await cipherSuite();
  const result = await createCommit({ state, cipherSuite: cs }, { ...options, ratchetTreeExtension: true });
  return {
    state: result.newState,
    commit: encodeMlsMessage(result.commit),
    welcome: result.welcome && encodeMlsMessage({ welcome: result.welcome, wireformat: 'mls_welcome', version: WIRE_VERSION }),
    consumed: result.consumed,
  };
}

/**
 * Erase the key material a step used up. Call only after the server accepted the Commit: ts-mls's consumed
 * keys can alias the input state, so zeroing them while a 409 might still discard that input would corrupt it.
 */
export function settle(step: GroupStep): void {
  step.consumed.forEach(zeroOutUint8Array);
}

/** Join from a Welcome that an existing member produced for our KeyPackage. */
export async function joinFromWelcome(welcome: Bytes, keys: MemberKeys, devices: DeviceDirectory): Promise<ClientState> {
  const [decoded] = decodeMlsMessage(welcome, 0)!;
  if (decoded.wireformat !== 'mls_welcome') throw new Error('Expected a Welcome message');
  return joinGroup(
    decoded.welcome, keys.publicPackage, keys.privatePackage, emptyPskIndex, await cipherSuite(),
    undefined, undefined, clientConfigFor(devices),
  );
}

/** Encrypt one application message under the current epoch. */
export async function encryptMessage(state: ClientState, plaintext: Bytes): Promise<{ state: ClientState; ciphertext: Bytes }> {
  const result = await createApplicationMessage(state, plaintext, await cipherSuite());
  result.consumed.forEach(zeroOutUint8Array);
  return {
    state: result.newState,
    ciphertext: encodeMlsMessage({ privateMessage: result.privateMessage, wireformat: 'mls_private_message', version: WIRE_VERSION }),
  };
}

/** Apply a Commit from another member, or decrypt an application message. Throws if the message is not for this epoch or we were removed. */
export async function receive(state: ClientState, bytes: Bytes): Promise<Received> {
  const [decoded] = decodeMlsMessage(bytes, 0)!;
  if (decoded.wireformat !== 'mls_private_message' && decoded.wireformat !== 'mls_public_message') {
    throw new Error(`Unexpected MLS wireformat: ${decoded.wireformat}`);
  }
  const message = decoded.wireformat === 'mls_private_message'
    ? { wireformat: 'mls_private_message' as const, privateMessage: decoded.privateMessage, version: WIRE_VERSION }
    : { wireformat: 'mls_public_message' as const, publicMessage: decoded.publicMessage, version: WIRE_VERSION };
  const result = await processMessage(message, state, emptyPskIndex, acceptAll, await cipherSuite());
  result.consumed.forEach(zeroOutUint8Array);
  if (result.kind === 'applicationMessage') return { state: result.newState, plaintext: result.message };
  return { state: result.newState };
}

/** Per-epoch 32-byte secret for LiveKit E2EE. Changes on every Commit, so removed members lose voice keys too. */
export async function voiceKey(state: ClientState): Promise<Bytes> {
  return mlsExporter(state.keySchedule.exporterSecret, 'chatward-voice', utf8(''), 32, await cipherSuite()) as Promise<Bytes>;
}

/** Wire form of a KeyPackage (what a device uploads and others claim). */
export async function encodeKeyPackage(keys: MemberKeys): Promise<string> {
  return toB64(encodeMlsMessage({ keyPackage: keys.publicPackage, wireformat: 'mls_key_package', version: WIRE_VERSION }) as Uint8Array<ArrayBuffer>);
}

export function decodeKeyPackage(encoded: string): KeyPackage {
  const [decoded] = decodeMlsMessage(fromB64(encoded), 0)!;
  if (decoded.wireformat !== 'mls_key_package') throw new Error('Expected a KeyPackage message');
  return decoded.keyPackage;
}

/** True only if the KeyPackage's credential names this device and carries its signature over the KeyPackage's MLS key. */
export function verifyKeyPackage(kp: KeyPackage, device: { deviceId: string; signPublic: string }): Promise<boolean> {
  const single: DeviceDirectory = (deviceId) => (deviceId === device.deviceId ? device.signPublic : undefined);
  return credentialAuthService(single).validateCredential(kp.leafNode.credential, kp.leafNode.signaturePublicKey);
}

/** Leaf index and identity (deviceId) of every current member. */
export function memberLeaves(state: ClientState): { leafIndex: number; deviceId: string }[] {
  const out: { leafIndex: number; deviceId: string }[] = [];
  state.ratchetTree.forEach((node, nodeIndex) => {
    if (node?.nodeType !== 'leaf' || node.leaf.credential.credentialType !== 'basic') return;
    const identity = parseIdentity(node.leaf.credential.identity);
    // Leaves sit at even node indices; leaf index = nodeIndex / 2. Unparseable leaves are skipped, never trusted.
    if (identity) out.push({ leafIndex: nodeIndex / 2, deviceId: identity.deviceId });
  });
  return out;
}

/** Per-epoch AES-256 key for message content and history. Each epoch derives a new one, so a removed member never gets the next. */
export async function historyKey(state: ClientState): Promise<Uint8Array<ArrayBuffer>> {
  return mlsExporter(state.keySchedule.exporterSecret, 'chatward-history', utf8(''), 32, await cipherSuite()) as Promise<Uint8Array<ArrayBuffer>>;
}

/** Serialized group state for the local vault. Holds the epoch secrets, so it is stored only via secureStore. */
export function encodeGroup(state: ClientState): Bytes {
  return encodeGroupState(state) as Bytes;
}

export type KeyPackageLike = KeyPackage;

export function decodeGroup(bytes: Bytes, devices: DeviceDirectory): ClientState {
  const [group] = decodeGroupState(bytes, 0)!;
  return { ...group, clientConfig: clientConfigFor(devices) };
}

/** A KeyPackage we uploaded, with the private parts needed to join from a Welcome that names it. */
export interface StoredKeyPackage {
  kp: string;
  init: string;
  hpke: string;
  sig: string;
  lastResort: boolean;
}

export function storeKeyPackage(keys: MemberKeys, kp: string, lastResort: boolean): StoredKeyPackage {
  return {
    kp,
    init: toB64(keys.privatePackage.initPrivateKey as Uint8Array<ArrayBuffer>),
    hpke: toB64(keys.privatePackage.hpkePrivateKey as Uint8Array<ArrayBuffer>),
    sig: toB64(keys.privatePackage.signaturePrivateKey as Uint8Array<ArrayBuffer>),
    lastResort,
  };
}

export function restoreKeyPackage(stored: StoredKeyPackage): MemberKeys {
  return {
    publicPackage: decodeKeyPackage(stored.kp),
    privatePackage: {
      initPrivateKey: fromB64(stored.init),
      hpkePrivateKey: fromB64(stored.hpke),
      signaturePrivateKey: fromB64(stored.sig),
    },
  };
}
