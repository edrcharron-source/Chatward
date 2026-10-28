// E2EE module — OWNER: crypto agent. Signatures below are the contract; do not change them.
import type { DeviceKeys, KeyEnvelope, Message, MessagePayload } from '@chatward/shared';
import type { ServerBundle } from '../state/session';

/** Load or create this device's keypairs (stored via window.chatward.secureStore). Registers nothing on the server. */
export async function initDevice(): Promise<DeviceKeys> { throw new Error('stub'); }
/** Public keys of this device (valid after initDevice). Sent in register/login bodies. */
export function getDevice(): DeviceKeys { throw new Error('stub'); }
/** Ensure every text channel has a key and this device has envelopes; create+wrap keys for all member devices when we hold/create the key. Idempotent; safe to call often. */
export async function syncChannelKeys(servers: ServerBundle[]): Promise<void> {}
/** Process an incoming key.envelope frame. */
export async function handleEnvelope(env: KeyEnvelope): Promise<void> {}
export async function encryptPayload(channelId: string, authorId: string, payload: MessagePayload): Promise<{ ciphertext: string; keyVersion: number }> { throw new Error('stub'); }
/** null if key not available (yet) or authentication fails */
export async function decryptMessage(msg: Message): Promise<MessagePayload | null> { return null; }
/** Called whenever new channel keys become available so views can retry decrypting. Returns unsubscribe. */
export function onKeysChanged(cb: () => void): () => void { return () => {}; }
export async function encryptBlob(bytes: Uint8Array): Promise<{ blob: Uint8Array; key: string; iv: string }> { throw new Error('stub'); }
export async function decryptBlob(blob: Uint8Array, key: string, iv: string): Promise<Uint8Array> { throw new Error('stub'); }
/** 32-byte media key for LiveKit E2EE derived from the channel key; null if unavailable. */
export async function voiceKey(channelId: string): Promise<Uint8Array | null> { return null; }
/** e.g. "12345 67890 ..." 6 groups of 5 digits over sorted signPublic keys */
export async function safetyNumber(devices: DeviceKeys[]): Promise<string> { return ''; }
