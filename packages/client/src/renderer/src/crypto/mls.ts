// MLS (RFC 9420) group layer on ts-mls. Pure functions over ClientState: no storage, no network.
// The server only relays the encoded bytes returned here (KeyPackages, Commits, Welcomes, application messages).
import {
  acceptAll, createApplicationMessage, createCommit, createGroup, decodeGroupState, decodeMlsMessage, defaultAuthenticationService,
  defaultCapabilities, defaultKeyPackageEqualityConfig, defaultKeyRetentionConfig, defaultLifetime, defaultLifetimeConfig,
  defaultPaddingConfig, emptyPskIndex, encodeGroupState, encodeMlsMessage, generateKeyPackage, getCiphersuiteFromName,
  getCiphersuiteImpl, joinGroup, mlsExporter, processMessage, zeroOutUint8Array, type CiphersuiteImpl, type ClientConfig,
  type ClientState, type Credential, type KeyPackage, type PrivateKeyPackage, type Proposal,
} from 'ts-mls';
import { fromB64, toB64, utf8 } from './primitives';

// DHKEM-X25519 / AES-128-GCM / Ed25519 is the only suite ts-mls supports without extra crypto packages.
const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const WIRE_VERSION = 'mls10' as const;

export type Bytes = Uint8Array;

export interface MemberKeys {
  publicPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
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

/** Fresh KeyPackage for one device. The identity is the device id, so membership is per device. */
export async function newMemberKeys(deviceId: string): Promise<MemberKeys> {
  const credential: Credential = { credentialType: 'basic', identity: utf8(deviceId) };
  const { publicPackage, privatePackage } = await generateKeyPackage(
    credential, defaultCapabilities(), defaultLifetime, [], await cipherSuite(),
  );
  return { publicPackage, privatePackage };
}

/** Start a one-member group. The creator is leaf 0 at epoch 0. */
export async function createMlsGroup(groupId: string, creator: MemberKeys): Promise<ClientState> {
  return createGroup(utf8(groupId), creator.publicPackage, creator.privatePackage, [], await cipherSuite());
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
export async function joinFromWelcome(welcome: Bytes, keys: MemberKeys): Promise<ClientState> {
  const [decoded] = decodeMlsMessage(welcome, 0)!;
  if (decoded.wireformat !== 'mls_welcome') throw new Error('Expected a Welcome message');
  return joinGroup(decoded.welcome, keys.publicPackage, keys.privatePackage, emptyPskIndex, await cipherSuite());
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

/** Leaf index and identity (deviceId) of every current member. */
export function memberLeaves(state: ClientState): { leafIndex: number; deviceId: string }[] {
  const out: { leafIndex: number; deviceId: string }[] = [];
  state.ratchetTree.forEach((node, nodeIndex) => {
    if (node?.nodeType !== 'leaf' || node.leaf.credential.credentialType !== 'basic') return;
    // Leaves sit at even node indices; leaf index = nodeIndex / 2.
    out.push({ leafIndex: nodeIndex / 2, deviceId: new TextDecoder().decode(node.leaf.credential.identity) });
  });
  return out;
}

/** Per-epoch AES-256 key for message content and history. Each epoch derives a new one, so a removed member never gets the next. */
export async function historyKey(state: ClientState): Promise<Uint8Array<ArrayBuffer>> {
  return mlsExporter(state.keySchedule.exporterSecret, 'chatward-history', utf8(''), 32, await cipherSuite()) as Promise<Uint8Array<ArrayBuffer>>;
}

const clientConfig: ClientConfig = {
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
  authService: defaultAuthenticationService,
};

/** Serialized group state for the local vault. Holds the epoch secrets, so it is stored only via secureStore. */
export function encodeGroup(state: ClientState): Bytes {
  return encodeGroupState(state) as Bytes;
}

export type KeyPackageLike = KeyPackage;

export function decodeGroup(bytes: Bytes): ClientState {
  const [group] = decodeGroupState(bytes, 0)!;
  return { ...group, clientConfig };
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
