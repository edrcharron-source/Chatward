import fs from 'node:fs';
import { LIMITS } from '@chatward/shared';

export const PASSWORD_MAX = 1024;

// The most common passwords of 8 or more characters, lowercased, from the NCSC list of the 100,000 passwords seen most
// in breaches (via SecLists, MIT licence). Shorter ones are refused by length anyway.
const COMMON = new Set(
  fs.readFileSync(new URL('../assets/common-passwords.txt', import.meta.url), 'utf8').split('\n').filter(Boolean),
);

/**
 * Why a new password is not allowed, or null when it is fine. Any characters count, and there are no rules about
 * mixing digits or symbols: length and not being a well-known password are what make it hard to guess.
 */
export function passwordProblem(password: string, name: string): string | null {
  if (password.length < LIMITS.PASSWORD_MIN) return `password must be at least ${LIMITS.PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  const lower = password.toLowerCase();
  if (name && lower === name.toLowerCase()) return 'password cannot be the same as your name';
  if (COMMON.has(lower)) return 'that password is one of the most common ones, pick something less guessable';
  return null;
}
