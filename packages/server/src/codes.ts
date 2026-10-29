import crypto from 'node:crypto';

// No look-alike characters (0/O, 1/I), so a code read aloud or copied by hand is unambiguous.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 12 characters (60 bits) shown as XXXX-XXXX-XXXX. The 32-character alphabet divides 256 evenly, so no bias. */
export function newCode(): string {
  const chars = [...crypto.randomBytes(12)].map((b) => CODE_ALPHABET[b % 32]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Case, spaces and dashes don't matter when a code is typed. */
export const normalizeCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Codes are compared by hash, so the database never holds a usable code. */
export function codeHash(code: string): string {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

/** The last 4 characters, which is all a log or a listing ever shows of a code. */
export const codeLabel = (code: string): string => normalizeCode(code).slice(-4);
