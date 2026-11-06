import { createPublicKey, verify } from 'node:crypto';

/**
 * The bytes an update signature covers: a line naming the version, then the installer itself.
 * Naming the version stops a server from passing off an older signed installer as a newer one.
 * scripts/update-signing.mjs builds the same bytes when it signs.
 */
export function signedUpdateBytes(installer: Buffer, version: string): Buffer {
  return Buffer.concat([Buffer.from(`Chatward update ${version}\n`, 'utf8'), installer]);
}

/**
 * True only when `signature` is an Ed25519 signature, by the private key matching `publicKeyPem`, of this installer
 * as version `version`. An empty key (not set up in this build) never verifies, so such a build refuses every update.
 */
export function isSignedBy(installer: Buffer, version: string, signature: Buffer, publicKeyPem: string): boolean {
  if (!publicKeyPem) return false;
  try {
    return verify(null, signedUpdateBytes(installer, version), createPublicKey(publicKeyPem), signature);
  } catch {
    // A malformed key or signature is a failed check, never a crash.
    return false;
  }
}
