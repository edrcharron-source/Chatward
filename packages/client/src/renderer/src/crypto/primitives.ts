// WebCrypto wrappers only. No hand-rolled primitives: every operation below is a
// standard algorithm (AES-256-GCM, ECDH P-256, ECDSA P-256, HKDF-SHA-256, SHA-256).

export type Bytes = Uint8Array<ArrayBuffer>;

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

export const IV_BYTES = 12;
export const KEY_BYTES = 32;

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export function randomBytes(n: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function utf8(s: string): Bytes {
  return encoder.encode(s);
}

export function toB64(bytes: Bytes): string {
  // Chunked: spreading the whole array into fromCharCode overflows the call stack on large payloads (images, files).
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

export function fromB64(s: string): Bytes {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.digest('SHA-256', data));
}

// ---------- AES-256-GCM ----------

export function generateAesKeyBytes(): Bytes {
  return randomBytes(KEY_BYTES);
}

export function importAesKey(raw: Bytes, extractable = false): Promise<CryptoKey> {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

/** Ciphertext+tag under an explicit IV. */
export async function aesEncryptWith(key: CryptoKey, iv: Bytes, plaintext: Bytes, aad?: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext));
}

/** Throws if authentication fails. */
export async function aesDecryptWith(key: CryptoKey, iv: Bytes, ciphertext: Bytes, aad?: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext));
}

/** Returns iv || ciphertext+tag with a fresh random IV. */
export async function aesSeal(key: CryptoKey, plaintext: Bytes, aad?: Bytes): Promise<Bytes> {
  const iv = randomBytes(IV_BYTES);
  return concat(iv, await aesEncryptWith(key, iv, plaintext, aad));
}

/** Expects iv || ciphertext+tag. Throws if authentication fails. */
export async function aesOpen(key: CryptoKey, sealed: Bytes, aad?: Bytes): Promise<Bytes> {
  return aesDecryptWith(key, sealed.slice(0, IV_BYTES), sealed.slice(IV_BYTES), aad);
}

// ---------- ECDH P-256 (key wrapping) ----------

export function generateEcdh(): Promise<CryptoKeyPair> {
  return subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']) as Promise<CryptoKeyPair>;
}

export async function exportRawPublic(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await subtle.exportKey('raw', key));
}

export function importEcdhPublic(raw: Bytes): Promise<CryptoKey> {
  return subtle.importKey('raw', raw, ECDH_PARAMS, false, []);
}

/** Derives an AES-256-GCM wrapping key from an ECDH shared secret through HKDF-SHA-256. */
export async function deriveWrapKey(priv: CryptoKey, peerPub: CryptoKey, salt: Bytes, info: Bytes): Promise<CryptoKey> {
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peerPub }, priv, 256);
  const hkdfKey = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** HKDF-SHA-256 over a symmetric key, producing `length` bytes. */
export async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, base, length * 8));
}

// ---------- ECDSA P-256 (envelope signatures, device identity) ----------

export function generateSigning(): Promise<CryptoKeyPair> {
  return subtle.generateKey(ECDSA_PARAMS, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

export function importSignPublic(raw: Bytes): Promise<CryptoKey> {
  return subtle.importKey('raw', raw, ECDSA_PARAMS, false, ['verify']);
}

export async function sign(priv: CryptoKey, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, data));
}

export async function verify(pub: CryptoKey, signature: Bytes, data: Bytes): Promise<boolean> {
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, signature, data);
}

// ---------- private key persistence (JWK, re-imported non-extractable) ----------

export async function exportJwk(key: CryptoKey): Promise<JsonWebKey> {
  return subtle.exportKey('jwk', key);
}

export function importEcdhPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle.importKey('jwk', jwk, ECDH_PARAMS, false, ['deriveBits']);
}

export function importSignPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle.importKey('jwk', jwk, ECDSA_PARAMS, false, ['sign']);
}
