import { createPublicKey, verify } from 'node:crypto';

/**
 * True only when `signature` is an Ed25519 signature of `installer` made with the private key that matches `publicKeyPem`.
 * An empty key (not set up yet) never verifies, so the app refuses every update until a real key is built in.
 */
export function isSignedBy(installer: Buffer, signature: Buffer, publicKeyPem: string): boolean {
  if (!publicKeyPem) return false;
  return verify(null, installer, createPublicKey(publicKeyPem), signature);
}
