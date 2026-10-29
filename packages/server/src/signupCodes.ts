// One-time sign-up codes, made on the server with `chatward invite`. A code creates exactly one account: its row is
// deleted in the same transaction that inserts the account. Every code's life is written to invites.log in the data
// folder, which is only ever appended to. Neither the database nor the log holds a usable code.
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { codeHash, codeLabel, newCode } from './codes.js';

export const SIGNUP_CODE_DEFAULT_HOURS = 48;
export const SIGNUP_CODE_MAX_HOURS = 30 * 24;

export const inviteLogPath = (dataDir: string): string => path.join(dataDir, 'invites.log');

type LogEvent = 'created' | 'used' | 'revoked' | 'expired';

/** Appends one line: time, event, the code's last 4 characters, then details as key=value pairs. */
export function logInvite(dataDir: string, event: LogEvent, label: string, details: Record<string, string>): void {
  const fields = Object.entries(details).map(([k, v]) => `${k}=${v.replace(/\s+/g, '_')}`).join('  ');
  const line = `${new Date().toISOString()}  ${event.padEnd(7)}  code …${label}  ${fields}\n`;
  try {
    fs.appendFileSync(inviteLogPath(dataDir), line, { mode: 0o600 });
  } catch (err) {
    console.error('could not write invites.log', err);
  }
}

export interface SignupCodeRow { label: string; createdBy: string; createdAt: number; expiresAt: number }

export function createSignupCode(db: DB, dataDir: string, hours: number, issuer: string): { code: string } & SignupCodeRow {
  const code = newCode();
  const now = Date.now();
  const row: SignupCodeRow = { label: codeLabel(code), createdBy: issuer, createdAt: now, expiresAt: now + hours * 3_600_000 };
  db.prepare('INSERT INTO signup_codes (code_hash, label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(codeHash(code), row.label, row.createdBy, row.createdAt, row.expiresAt);
  logInvite(dataDir, 'created', row.label, { by: issuer, expires: new Date(row.expiresAt).toISOString() });
  return { code, ...row };
}

export function listSignupCodes(db: DB): SignupCodeRow[] {
  return (db.prepare('SELECT label, created_by, created_at, expires_at FROM signup_codes WHERE expires_at>? ORDER BY created_at')
    .all(Date.now()) as { label: string; created_by: string; created_at: number; expires_at: number }[])
    .map((r) => ({ label: r.label, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at }));
}

/**
 * Deletes and returns the code if it is valid. Run inside the transaction that creates the account, so a failed
 * sign-up puts the code back and a successful one can never be repeated.
 */
export function takeSignupCode(db: DB, code: string): { label: string; createdBy: string } | null {
  const row = db.prepare('DELETE FROM signup_codes WHERE code_hash=? AND expires_at>? RETURNING label, created_by')
    .get(codeHash(code), Date.now()) as { label: string; created_by: string } | undefined;
  return row ? { label: row.label, createdBy: row.created_by } : null;
}

/**
 * Cancels an unused code, given in full or by the last 4 characters `chatward invites` shows.
 * Returns the label, or an error when nothing or more than one code matches.
 */
export function revokeSignupCode(db: DB, dataDir: string, given: string, issuer: string): { label: string } | { error: string } {
  const clean = given.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const rows = clean.length === 4
    ? db.prepare('SELECT code_hash, label FROM signup_codes WHERE label=?').all(clean) as { code_hash: string; label: string }[]
    : db.prepare('SELECT code_hash, label FROM signup_codes WHERE code_hash=?').all(codeHash(clean)) as { code_hash: string; label: string }[];
  if (rows.length === 0) return { error: 'no unused code matches that' };
  if (rows.length > 1) return { error: 'more than one code ends with that, give the whole code' };
  db.prepare('DELETE FROM signup_codes WHERE code_hash=?').run(rows[0].code_hash);
  logInvite(dataDir, 'revoked', rows[0].label, { by: issuer });
  return { label: rows[0].label };
}

/** Deletes expired codes, logging each one. */
export function sweepExpiredSignupCodes(db: DB, dataDir: string): void {
  const rows = db.prepare('DELETE FROM signup_codes WHERE expires_at<=? RETURNING label, created_by').all(Date.now()) as
    { label: string; created_by: string }[];
  for (const r of rows) logInvite(dataDir, 'expired', r.label, { by: r.created_by, result: 'unused' });
}
