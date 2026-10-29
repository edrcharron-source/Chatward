import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { hash, verify } from '@node-rs/argon2';
import rateLimit from 'express-rate-limit';
import { LIMITS, type DeviceKeys } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';
import { codeHash, newCode } from '../codes.js';
import { PASSWORD_MAX, passwordProblem } from '../passwords.js';
import { logInvite, takeSignupCode } from '../signupCodes.js';
import { createMainServer, mainServerId } from '../singleServer.js';
import { endAccountCall, endCallOnDevice, endCallOnOtherDevices, forgetUserRemovals } from './voice.js';
import {
  ApiError,
  announceJoin,
  bad,
  bodyOf,
  cleanText,
  ISSUER_OWNS_SHARED_SERVER,
  peerIds,
  pruneResetCodes,
  removeMember,
  route,
  takeLegacyInvite,
  userIdOf,
} from './servers.js';

const USERNAME_RE = new RegExp(`^[A-Za-z0-9_.-]{${LIMITS.USERNAME_MIN},${LIMITS.USERNAME_MAX}}$`);
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const RESET_CODE_MS = 24 * 60 * 60_000;
const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A new password for the account called `name`. See passwords.ts for the rules. */
function validPassword(v: unknown, name: string): string {
  if (typeof v !== 'string') bad(`password must be at least ${LIMITS.PASSWORD_MIN} characters`);
  const problem = passwordProblem(v, name);
  if (problem) bad(problem);
  return v;
}

/** Uncompressed P-256 point (65 bytes, leading 0x04), base64. */
function isP256Point(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 120 || !BASE64_RE.test(v)) return false;
  const raw = Buffer.from(v, 'base64');
  return raw.length === 65 && raw[0] === 0x04;
}

function parseDevice(v: unknown): DeviceKeys {
  const d = (v ?? {}) as Record<string, unknown>;
  if (typeof d.deviceId !== 'string' || !DEVICE_ID_RE.test(d.deviceId)) bad('invalid device id');
  if (!isP256Point(d.ecdhPublic) || !isP256Point(d.signPublic)) bad('invalid device keys');
  return { deviceId: d.deviceId, ecdhPublic: d.ecdhPublic, signPublic: d.signPublic };
}

/** Upserts a device's keys. Returns true if anything changed. Must run inside a transaction. */
function upsertDevice(ctx: Ctx, userId: string, d: DeviceKeys): boolean {
  const row = ctx.db
    .prepare('SELECT user_id, ecdh_public, sign_public FROM devices WHERE device_id=?')
    .get(d.deviceId) as { user_id: string; ecdh_public: string; sign_public: string } | undefined;
  if (row && row.user_id !== userId) throw new ApiError(409, 'device id is already registered');
  if (row && row.ecdh_public === d.ecdhPublic && row.sign_public === d.signPublic) return false;
  ctx.db
    .prepare(`INSERT INTO devices (device_id, user_id, ecdh_public, sign_public, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET ecdh_public = excluded.ecdh_public, sign_public = excluded.sign_public`)
    .run(d.deviceId, userId, d.ecdhPublic, d.signPublic, Date.now());
  return true;
}

/** True if this device id is not yet registered to the user, so signing in with it adds a device. */
function isNewDevice(ctx: Ctx, userId: string, deviceId: string): boolean {
  return !ctx.db.prepare('SELECT 1 FROM devices WHERE device_id=? AND user_id=?').get(deviceId, userId);
}

/** Tells the account's signed-in devices that a new one was added, so the owner can spot a login they didn't make. */
function announceNewDevice(ctx: Ctx, userId: string, deviceId: string): void {
  const row = ctx.db.prepare('SELECT created_at FROM devices WHERE device_id=? AND user_id=?').get(deviceId, userId) as
    { created_at: number } | undefined;
  if (row) ctx.sendToUser(userId, { t: 'device.added', deviceId, createdAt: row.created_at });
}

function broadcastDevices(ctx: Ctx, userId: string): void {
  const devices = ctx.getDevices(userId);
  const serverIds = ctx.db.prepare('SELECT server_id FROM members WHERE user_id=?').all(userId) as { server_id: string }[];
  for (const { server_id } of serverIds) {
    ctx.broadcastToServer(server_id, { t: 'member.devices', serverId: server_id, userId, devices });
  }
}

function broadcastUser(ctx: Ctx, userId: string): void {
  const user = ctx.getUser(userId);
  if (!user) return;
  for (const id of new Set([userId, ...peerIds(ctx, userId)])) {
    ctx.sendToUser(id, { t: 'user.update', user });
  }
}

// Accounts made without a password sign in with a key stored on each PC. The server hands out a one-time nonce, and the
// PC signs it with its device key. A nonce lives for two minutes and can be used once, even if the signature is wrong.
const CHALLENGE_MS = 2 * 60_000;
const CHALLENGE_MAX = 5000;
const challenges = new Map<string, number>();

function newChallenge(): string {
  const now = Date.now();
  if (challenges.size > CHALLENGE_MAX) for (const [nonce, expires] of challenges) if (expires <= now) challenges.delete(nonce);
  const nonce = crypto.randomBytes(32).toString('base64');
  challenges.set(nonce, now + CHALLENGE_MS);
  return nonce;
}

/** Consumes a nonce. True only if it was issued by this server, is unused and has not expired. */
function takeChallenge(nonce: string): boolean {
  const expires = challenges.get(nonce);
  challenges.delete(nonce);
  return expires !== undefined && expires > Date.now();
}

/** The bytes a device signs. The prefix keeps a signature made for this server from meaning anything else. */
const proofMessage = (nonce: string) => Buffer.from(`chatward-proof:${nonce}`, 'utf8');
/** DER prefix that turns a raw P-256 point into a SubjectPublicKeyInfo, so Node can verify with it. */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

function signatureValid(signPublic: string, nonce: string, signature: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, Buffer.from(signPublic, 'base64')]), format: 'der', type: 'spki' });
    return crypto.verify('sha256', proofMessage(nonce), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** True if the body's proof is a fresh signature from a PC already registered to this account. */
function deviceProofOk(ctx: Ctx, userId: string, proof: unknown, deviceId?: string): boolean {
  const p = (proof ?? {}) as Record<string, unknown>;
  if (typeof p.deviceId !== 'string' || typeof p.nonce !== 'string' || typeof p.signature !== 'string') return false;
  if (p.signature.length > 200 || !BASE64_RE.test(p.signature)) return false;
  if (deviceId !== undefined && p.deviceId !== deviceId) return false;
  const row = ctx.db.prepare('SELECT sign_public FROM devices WHERE device_id=? AND user_id=?').get(p.deviceId, userId) as
    { sign_public: string } | undefined;
  if (!row) return false;
  return takeChallenge(p.nonce) && signatureValid(row.sign_public, p.nonce, p.signature);
}

/**
 * Confirms a sensitive action. Accounts with a password need it typed in; accounts without one need a fresh proof
 * from a registered PC. Wrong or missing is a 403, never a 401, so the client doesn't read it as signed out.
 */
async function requirePassword(ctx: Ctx, userId: string, body: Record<string, unknown>): Promise<void> {
  const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId) as { password_hash: string } | undefined;
  if (!row) throw new ApiError(401, 'unauthorized');
  if (row.password_hash === '') {
    if (!deviceProofOk(ctx, userId, body.proof)) throw new ApiError(403, 'this PC could not confirm the action');
    return;
  }
  const password = typeof body.password === 'string' && body.password.length <= PASSWORD_MAX ? body.password : '';
  if (!password || !(await verify(row.password_hash, password))) throw new ApiError(403, 'password is incorrect');
}

/** The device a password change should keep signed in. Tokens from before per-device sessions name none, so the client sends its device id. */
function callerDevice(ctx: Ctx, req: Request, body: Record<string, unknown>, userId: string): string {
  const deviceId = (req as AuthedRequest).deviceId ?? (typeof body.deviceId === 'string' ? body.deviceId : '');
  if (!ctx.db.prepare('SELECT 1 FROM devices WHERE device_id=? AND user_id=?').get(deviceId, userId)) {
    bad('this device is not registered to your account');
  }
  return deviceId;
}

/** Limits signed-in, password-checked actions per account, so a stolen token can't guess the password quickly. */
const sensitiveLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthedRequest).userId,
  message: { error: 'too many attempts, try again later' },
});

// Per-username sign-in guard. The per-IP limit alone lets one account be guessed from many addresses, so this counts
// failures per username. A lock is short and grows with each failure past the threshold, and it always expires,
// so a stranger who guesses a name can delay its owner for minutes at most.
const LOGIN_FAILS_BEFORE_LOCK = 10;
const LOGIN_FAIL_WINDOW_MS = 15 * 60_000;
const LOGIN_LOCK_BASE_MS = 30_000;
const LOGIN_LOCK_MAX_MS = 15 * 60_000;
const LOGIN_GUARD_PRUNE_AT = 5000;

type LoginGuard = { fails: number; windowStart: number; lockedUntil: number };
const loginGuards = new Map<string, LoginGuard>();

// Usernames are case-insensitive in the database (COLLATE NOCASE), so "Ed", "eD" and "ED" must share one guard.
const loginGuardKey = (username: string) => username.toLowerCase();

/** Throws 429 while the username is locked. Runs before the password check, so a locked name costs no hashing. */
function assertLoginAllowed(username: string): void {
  const guard = loginGuards.get(loginGuardKey(username));
  if (guard && guard.lockedUntil > Date.now()) {
    throw new ApiError(429, 'too many failed sign-ins for this account, try again in a few minutes');
  }
}

function recordLoginFailure(username: string): void {
  const now = Date.now();
  const key = loginGuardKey(username);
  if (loginGuards.size > LOGIN_GUARD_PRUNE_AT) {
    for (const [name, g] of loginGuards) if (g.lockedUntil <= now && now - g.windowStart > LOGIN_FAIL_WINDOW_MS) loginGuards.delete(name);
  }
  const guard = loginGuards.get(key) ?? { fails: 0, windowStart: now, lockedUntil: 0 };
  if (now - guard.windowStart > LOGIN_FAIL_WINDOW_MS) {
    guard.fails = 0;
    guard.windowStart = now;
  }
  guard.fails += 1;
  if (guard.fails >= LOGIN_FAILS_BEFORE_LOCK) {
    const steps = guard.fails - LOGIN_FAILS_BEFORE_LOCK;
    guard.lockedUntil = now + Math.min(LOGIN_LOCK_BASE_MS * 2 ** steps, LOGIN_LOCK_MAX_MS);
  }
  loginGuards.set(key, guard);
}

/**
 * Makes a one-time password reset code for `userId`, replacing any earlier one. `issuerId` must own the server, or
 * the code stops working. Shown once; only its hash is kept, and it expires after 24 hours.
 */
export function issueResetCode(ctx: Ctx, userId: string, issuerId: string): { code: string; expiresAt: number } {
  const code = newCode();
  const expiresAt = Date.now() + RESET_CODE_MS;
  ctx.db
    .prepare(`INSERT INTO password_resets (user_id, issued_by, code_hash, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET issued_by = excluded.issued_by, code_hash = excluded.code_hash, expires_at = excluded.expires_at`)
    .run(userId, issuerId, codeHash(code), expiresAt);
  return { code, expiresAt };
}

/** The account as its owner sees it. Only the owner's own responses carry hasPassword, so the client knows which confirmation to ask for. */
function mustUser(ctx: Ctx, userId: string) {
  const user = ctx.getUser(userId);
  if (!user) throw new ApiError(401, 'unauthorized');
  const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId) as { password_hash: string } | undefined;
  return { ...user, hasPassword: !!row && row.password_hash !== '' };
}

/** Profile pictures are visible to the account itself and to anyone who shares a server with it. */
function canSeeProfileImage(ctx: Ctx, viewerId: string, ownerId: string): boolean {
  if (viewerId === ownerId) return true;
  return !!ctx.db.prepare(
    'SELECT 1 FROM members a JOIN members b ON b.server_id=a.server_id WHERE a.user_id=? AND b.user_id=? LIMIT 1',
  ).get(viewerId, ownerId);
}

/** Free text that may be empty. Bios may contain line breaks; other fields may not. */
function freeText(v: unknown, max: number, label: string, multiline: boolean): string {
  if (typeof v !== 'string') bad(`${label} must be text`);
  const s = v.trim();
  const control = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (s.length > max || control.test(s)) bad(`${label} must be at most ${max} printable characters`);
  return s;
}

/** A #rrggbb color, stored lowercase, or null to clear it. */
function colorOrNull(v: unknown, label: string): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) bad(`${label} must be a #rrggbb color`);
  return v.toLowerCase();
}

/** Magic-byte sniff; returns the real image MIME type or null. */
function sniffImage(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** express.raw for one route; an oversize body gets a JSON 413 instead of the global 500 handler. */
function rawBody(limit: number) {
  const parse = express.raw({ type: '*/*', limit });
  return (req: Request, res: Response, next: NextFunction) =>
    parse(req, res, (err?: Error & { status?: number }) => {
      if (!err) next();
      else if (err.status === 413) res.status(413).json({ error: 'file too large' });
      else res.status(400).json({ error: 'bad request' });
    });
}

export function register(app: Express, ctx: Ctx): void {
  const avatarDir = path.join(ctx.config.dataDir, 'avatars');
  const bannerDir = path.join(ctx.config.dataDir, 'banners');
  // Timing equaliser: unknown usernames still pay one argon2 verify.
  const dummyHash = hash(crypto.randomBytes(16).toString('hex'));

  // Creates an account with a one-time sign-up code from `chatward invite`. The account gets one name, used to sign in
  // and shown to everyone, and joins the server. The first account ever made owns it.
  app.post('/api/auth/register', route(async (req, res) => {
    const body = bodyOf(req);
    // Older apps send the name as `username` and a separate display name, which is ignored now.
    const raw = typeof body.name === 'string' ? body.name : body.username;
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!USERNAME_RE.test(name)) {
      bad(`name must be ${LIMITS.USERNAME_MIN}-${LIMITS.USERNAME_MAX} letters, digits, dots, dashes or underscores`);
    }
    // A password is optional. Without one, the account signs in with the key on each linked PC.
    const password = typeof body.password === 'string' && body.password !== '' ? validPassword(body.password, name) : '';
    const device = parseDevice(body.device);
    const given = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
    if (!given) throw new ApiError(403, 'a sign-up code is required');
    const id = newId();
    const passwordHash = password ? await hash(password) : '';

    const result = ctx.db.transaction(() => {
      let serverId = mainServerId(ctx.db);
      // The code is deleted here, in the same transaction as the account. A failed sign-up rolls the delete back.
      const code = takeSignupCode(ctx.db, given);
      if (!code && !(serverId && takeLegacyInvite(ctx, given, serverId))) {
        throw new ApiError(403, 'sign-up code is invalid, used or expired');
      }
      try {
        ctx.db
          .prepare(`INSERT INTO users (id, username, display_name, password_hash, created_at, invited_by, invite_label)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, name, name, passwordHash, Date.now(), code?.createdBy ?? null, code?.label ?? null);
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ApiError(409, 'that name is taken');
        throw err;
      }
      upsertDevice(ctx, id, device);
      if (serverId) {
        ctx.db.prepare("INSERT INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
          .run(serverId, id, Date.now());
      } else {
        serverId = createMainServer(ctx.db, id);
      }
      return { serverId, code };
    })();

    if (result.code) {
      logInvite(ctx.config.dataDir, 'used', result.code.label, { by: result.code.createdBy, account: name, id, from: req.ip ?? 'unknown' });
    }
    announceJoin(ctx, result.serverId, id);
    res.json({ token: ctx.signToken(id, device.deviceId), user: mustUser(ctx, id) });
  }));

  // A nonce for the PC to sign when it signs in without a password. Issued for any name, so it reveals nothing.
  app.get('/api/auth/challenge', route((_req, res) => {
    res.json({ nonce: newChallenge() });
  }));

  // Signs in with a password, or, for accounts without one, with a proof from this PC's device key. A proof never adds
  // a device: the PC must already be registered to the account, which is what stops a stranger typing a name and in.
  app.post('/api/auth/login', route(async (req, res) => {
    const body = bodyOf(req);
    const raw = typeof body.name === 'string' ? body.name : body.username;
    const username = typeof raw === 'string' ? raw.trim() : '';
    const password = typeof body.password === 'string' && body.password.length <= PASSWORD_MAX ? body.password : '';
    const device = parseDevice(body.device);
    if (username) assertLoginAllowed(username);
    const row = username
      ? (ctx.db.prepare('SELECT id, password_hash, disabled_at FROM users WHERE username=? AND deleted_at IS NULL').get(username) as
          { id: string; password_hash: string; disabled_at: number | null } | undefined)
      : undefined;
    const hasPassword = !!row && row.password_hash !== '';
    const passwordOk = password !== '' && (await verify(hasPassword ? row!.password_hash : await dummyHash, password)) && hasPassword;
    const proofOk = !!row && password === '' && !hasPassword && deviceProofOk(ctx, row.id, body.proof, device.deviceId);
    if (!row || !(passwordOk || proofOk)) {
      if (username) recordLoginFailure(username);
      throw new ApiError(401, 'invalid name or password, or this PC is not linked to the account');
    }
    loginGuards.delete(loginGuardKey(username));
    // Only said after the right sign-in, so it does not tell strangers which names exist.
    if (row.disabled_at !== null) throw new ApiError(403, 'this account has been turned off, ask the server owner');
    if (passwordOk) {
      // A proof never changes the device list. Only a password sign-in can add a device.
      const newDevice = isNewDevice(ctx, row.id, device.deviceId);
      if (ctx.db.transaction(() => upsertDevice(ctx, row.id, device))()) broadcastDevices(ctx, row.id);
      if (newDevice) announceNewDevice(ctx, row.id, device.deviceId);
    }
    res.json({ token: ctx.signToken(row.id, device.deviceId), user: mustUser(ctx, row.id) });
  }));

  // Signed-in password change. Needs the current password, and signs out every other session.
  // A wrong current password gets 403, not 401: the client treats 401 as "logged out".
  app.post('/api/me/password', ctx.requireAuth, sensitiveLimit, route(async (req, res) => {
    const uid = userIdOf(req);
    const body = bodyOf(req);
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id=?').get(uid) as { password_hash: string } | undefined;
    if (!row) throw new ApiError(401, 'unauthorized');
    const current = typeof body.currentPassword === 'string' && body.currentPassword.length <= PASSWORD_MAX ? body.currentPassword : '';
    // An account without a password is setting its first one, so a proof from this PC stands in for the current password.
    if (row.password_hash === '') {
      if (!deviceProofOk(ctx, uid, body.proof)) throw new ApiError(403, 'this PC could not confirm the change');
    } else if (current === '' || !(await verify(row.password_hash, current))) {
      throw new ApiError(403, 'current password is wrong');
    }
    const newPassword = validPassword(body.newPassword, mustUser(ctx, uid).username);
    if (newPassword === current) bad('the new password must be different from the current one');
    const deviceId = callerDevice(ctx, req, body, uid);
    const passwordHash = await hash(newPassword);
    ctx.db
      .prepare('UPDATE users SET password_hash=?, session_version=session_version+1 WHERE id=?')
      .run(passwordHash, uid);
    // A reset code issued before this change would let someone overwrite the password just set.
    ctx.db.prepare('DELETE FROM password_resets WHERE user_id=?').run(uid);
    res.json({ token: ctx.signToken(uid, deviceId), user: mustUser(ctx, uid) });
    // The other devices are signed out, so a call running on one of them must end too. Its socket closing alone would
    // leave the LiveKit session running.
    endCallOnOtherDevices(ctx, uid, deviceId);
    ctx.revokeSockets(uid);
  }));

  // Owner only: issue a one-time reset code for a member of one of the owner's servers.
  // The owner gives the code to the member out of band; it is shown once and expires after 24 hours.
  app.post('/api/servers/:id/members/:userId/reset-code', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    const targetId = String(req.params.userId);
    const uid = userIdOf(req);
    const actorRole = ctx.roleIn(serverId, uid);
    if (!actorRole) throw new ApiError(404, 'server not found');
    if (actorRole !== 'owner') throw new ApiError(403, 'only the owner can issue reset codes');
    if (targetId === uid) bad('use Change password to change your own password');
    if (!ctx.roleIn(serverId, targetId)) throw new ApiError(404, 'member not found');
    res.json(issueResetCode(ctx, targetId, uid));
  }));

  // Redeems an owner-issued code and sets a new password. The code is single-use: the DELETE below
  // only succeeds once, and the whole change rolls back if the device cannot be registered.
  app.post('/api/auth/reset', route(async (req, res) => {
    const body = bodyOf(req);
    const raw = typeof body.name === 'string' ? body.name : body.username;
    const username = typeof raw === 'string' ? raw.trim() : '';
    const code = typeof body.code === 'string' ? body.code : '';
    const newPassword = validPassword(body.newPassword, username);
    const device = parseDevice(body.device);
    const user = username
      ? (ctx.db.prepare('SELECT id FROM users WHERE username=? AND deleted_at IS NULL AND disabled_at IS NULL').get(username) as
          { id: string } | undefined)
      : undefined;
    const passwordHash = await hash(newPassword);
    const newDevice = user ? isNewDevice(ctx, user.id, device.deviceId) : false;
    const devicesChanged = ctx.db.transaction(() => {
      const used = user
        ? ctx.db.prepare(`DELETE FROM password_resets WHERE user_id=? AND code_hash=? AND expires_at>? AND ${ISSUER_OWNS_SHARED_SERVER}`)
          .run(user.id, codeHash(code), Date.now())
        : { changes: 0 };
      if (!user || used.changes !== 1) throw new ApiError(403, 'reset code is invalid or expired');
      ctx.db
        .prepare('UPDATE users SET password_hash=?, session_version=session_version+1 WHERE id=?')
        .run(passwordHash, user.id);
      return upsertDevice(ctx, user.id, device);
    })();
    if (devicesChanged) broadcastDevices(ctx, user!.id);
    if (newDevice) announceNewDevice(ctx, user!.id, device.deviceId);
    res.json({ token: ctx.signToken(user!.id, device.deviceId), user: mustUser(ctx, user!.id) });
    endCallOnOtherDevices(ctx, user!.id, device.deviceId);
    ctx.revokeSockets(user!.id);
  }));

  app.get('/api/me', ctx.requireAuth, route((req, res) => {
    res.json({ user: mustUser(ctx, userIdOf(req)) });
  }));

  // Swaps a still-valid token for a new 30-day one. requireAuth rejects a revoked session, so it cannot renew.
  app.post('/api/auth/refresh', ctx.requireAuth, route((req, res) => {
    const deviceId = (req as AuthedRequest).deviceId;
    // A token from before logins were tied to a device cannot be renewed; that user signs in again.
    if (!deviceId) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.json({ token: ctx.signToken(userIdOf(req), deviceId) });
  }));

  // Whether a device id is registered to the caller. Lets a PC confirm an old device before using it.
  app.get('/api/me/devices/:deviceId', ctx.requireAuth, route((req, res) => {
    const row = ctx.db.prepare('SELECT user_id FROM devices WHERE device_id=?').get(String(req.params.deviceId)) as
      { user_id: string } | undefined;
    res.json({ owned: row !== undefined && row.user_id === userIdOf(req) });
  }));

  // The caller's own devices, oldest first, so Settings can list them and offer Remove.
  app.get('/api/me/devices', ctx.requireAuth, route((req, res) => {
    const rows = ctx.db.prepare('SELECT device_id, created_at FROM devices WHERE user_id=? ORDER BY created_at')
      .all(userIdOf(req)) as { device_id: string; created_at: number }[];
    res.json({ devices: rows.map((r) => ({ deviceId: r.device_id, createdAt: r.created_at })) });
  }));

  // Removes one of the caller's devices. Needs the account password. The device's token stops working at once,
  // and its open sockets close. Its pending KeyPackages, Welcomes and acks go with it, so it can no longer
  // join groups or hold up a reset. Peers see the new device list and drop it from their groups with a Remove Commit.
  app.delete('/api/me/devices/:deviceId', ctx.requireAuth, sensitiveLimit, route(async (req, res) => {
    const uid = userIdOf(req);
    const deviceId = String(req.params.deviceId);
    await requirePassword(ctx, uid, bodyOf(req));
    const row = ctx.db.prepare('SELECT user_id FROM devices WHERE device_id=?').get(deviceId) as
      { user_id: string } | undefined;
    if (!row || row.user_id !== uid) throw new ApiError(404, 'device not found');
    ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM mls_keypackages WHERE device_id=?').run(deviceId);
      ctx.db.prepare('DELETE FROM mls_welcomes WHERE to_device_id=?').run(deviceId);
      ctx.db.prepare('DELETE FROM mls_group_acks WHERE device_id=?').run(deviceId);
      ctx.db.prepare('DELETE FROM devices WHERE device_id=?').run(deviceId);
    })();
    broadcastDevices(ctx, uid);
    res.status(204).end();
    // Ends the call if this device is in one. Its socket closing alone would leave the LiveKit session running.
    endCallOnDevice(ctx, uid, deviceId);
    ctx.revokeSockets(uid, deviceId);
  }));

  // Each field is optional; a missing field keeps its current value. The name is not one of them: it is what the
  // app's stored keys are filed under, so it stays fixed. Older apps may still send displayName; it is ignored.
  app.patch('/api/me', ctx.requireAuth, route((req, res) => {
    const uid = userIdOf(req);
    const body = bodyOf(req);
    const cur = mustUser(ctx, uid);
    const bio = body.bio === undefined ? cur.profile.bio : freeText(body.bio, LIMITS.BIO_MAX, 'bio', true);
    const pronouns = body.pronouns === undefined
      ? cur.profile.pronouns
      : freeText(body.pronouns, LIMITS.PRONOUNS_MAX, 'pronouns', false);
    const accentColor = body.accentColor === undefined ? cur.profile.accentColor : colorOrNull(body.accentColor, 'accent color');
    const bannerColor = body.bannerColor === undefined ? cur.profile.bannerColor : colorOrNull(body.bannerColor, 'banner color');
    ctx.db
      .prepare('UPDATE users SET bio=?, pronouns=?, accent_color=?, banner_color=? WHERE id=?')
      .run(bio, pronouns, accentColor, bannerColor, uid);
    broadcastUser(ctx, uid);
    res.json({ user: mustUser(ctx, uid) });
  }));

  // Deletes the caller's account. The owner's account cannot be deleted. The row stays as a
  // tombstone so old messages still point at a user; everything personal is wiped.
  app.post('/api/me/delete', ctx.requireAuth, sensitiveLimit, route(async (req, res) => {
    const uid = userIdOf(req);
    await requirePassword(ctx, uid, bodyOf(req));

    if (ctx.db.prepare('SELECT 1 FROM servers WHERE owner_id=?').get(uid)) {
      throw new ApiError(409, 'the owner account cannot be deleted');
    }

    // Read before the wipe: the broadcasts below still need the servers the user is in.
    const serverIds = (ctx.db.prepare('SELECT server_id FROM members WHERE user_id=?').all(uid) as
      { server_id: string }[]).map((r) => r.server_id);
    const files = ctx.db.prepare('SELECT avatar_path, banner_path FROM users WHERE id=?').get(uid) as
      { avatar_path: string | null; banner_path: string | null };

    ctx.db.transaction(() => {
      // The same per-device cleanup as removing one device, for every device of the account.
      ctx.db.prepare('DELETE FROM mls_keypackages WHERE device_id IN (SELECT device_id FROM devices WHERE user_id=?)').run(uid);
      ctx.db.prepare('DELETE FROM mls_welcomes WHERE to_device_id IN (SELECT device_id FROM devices WHERE user_id=?)').run(uid);
      ctx.db.prepare('DELETE FROM mls_group_acks WHERE device_id IN (SELECT device_id FROM devices WHERE user_id=?)').run(uid);
      ctx.db.prepare('DELETE FROM devices WHERE user_id=?').run(uid);
      ctx.db.prepare('DELETE FROM password_resets WHERE user_id=?').run(uid);
      ctx.db.prepare(`UPDATE users SET username=?, display_name='Deleted user', password_hash='', avatar_path=NULL,
          banner_path=NULL, bio='', pronouns='', accent_color=NULL, banner_color=NULL, deleted_at=? WHERE id=?`)
        .run(`deleted-${uid}`, Date.now(), uid);
    })();
    forgetUserRemovals(ctx, uid);
    // Peers still share a server with the user at this point, so they hear about the wipe before the removal.
    broadcastDevices(ctx, uid);
    broadcastUser(ctx, uid);
    for (const serverId of serverIds) removeMember(ctx, serverId, uid);
    // Every device is signed out, so a call on any of them must end and each open socket must close.
    endAccountCall(ctx, uid);
    ctx.revokeSockets(uid);

    if (files.avatar_path) fs.rmSync(path.join(avatarDir, path.basename(files.avatar_path)), { force: true });
    if (files.banner_path) fs.rmSync(path.join(bannerDir, path.basename(files.banner_path)), { force: true });
    res.json({ ok: true });
  }));

  app.put('/api/me/banner', ctx.requireAuth, rawBody(LIMITS.BANNER_MAX_BYTES), route((req, res) => {
    const uid = userIdOf(req);
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) bad('image body required');
    const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const actual = sniffImage(body);
    if (!actual || actual !== declared) bad('banner must be PNG, JPEG or WebP matching its Content-Type');

    const file = `${uid}.${EXT_BY_MIME[actual]}`;
    const prev = (ctx.db.prepare('SELECT banner_path FROM users WHERE id=?').get(uid) as
      { banner_path: string | null }).banner_path;
    fs.mkdirSync(bannerDir, { recursive: true });
    const tmp = path.join(bannerDir, `${file}.tmp`);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, path.join(bannerDir, file));
    if (prev && prev !== file) fs.rmSync(path.join(bannerDir, prev), { force: true });
    ctx.db.prepare('UPDATE users SET banner_path=? WHERE id=?').run(file, uid);
    broadcastUser(ctx, uid);
    res.json({ user: mustUser(ctx, uid) });
  }));

  app.delete('/api/me/banner', ctx.requireAuth, route((req, res) => {
    const uid = userIdOf(req);
    const prev = (ctx.db.prepare('SELECT banner_path FROM users WHERE id=?').get(uid) as
      { banner_path: string | null }).banner_path;
    if (prev) fs.rmSync(path.join(bannerDir, prev), { force: true });
    ctx.db.prepare('UPDATE users SET banner_path=NULL WHERE id=?').run(uid);
    broadcastUser(ctx, uid);
    res.json({ user: mustUser(ctx, uid) });
  }));

  app.get('/api/banners/:userId', ctx.requireAuth, route((req, res) => {
    const ownerId = String(req.params.userId);
    const row = ctx.db.prepare('SELECT banner_path FROM users WHERE id=?').get(ownerId) as
      { banner_path: string | null } | undefined;
    if (!row?.banner_path || !canSeeProfileImage(ctx, userIdOf(req), ownerId)) throw new ApiError(404, 'no banner');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.sendFile(path.join(bannerDir, path.basename(row.banner_path)), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'no banner' });
    });
  }));

  app.put('/api/me/avatar', ctx.requireAuth, rawBody(LIMITS.AVATAR_MAX_BYTES), route((req, res) => {
    const uid = userIdOf(req);
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) bad('image body required');
    const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const actual = sniffImage(body);
    if (!actual || actual !== declared) bad('image must be PNG, JPEG or WebP matching its Content-Type');

    const file = `${uid}.${EXT_BY_MIME[actual]}`;
    const prev = (ctx.db.prepare('SELECT avatar_path FROM users WHERE id=?').get(uid) as
      { avatar_path: string | null }).avatar_path;
    fs.mkdirSync(avatarDir, { recursive: true });
    const tmp = path.join(avatarDir, `${file}.tmp`);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, path.join(avatarDir, file));
    if (prev && prev !== file) fs.rmSync(path.join(avatarDir, prev), { force: true });
    ctx.db.prepare('UPDATE users SET avatar_path=? WHERE id=?').run(file, uid);
    broadcastUser(ctx, uid);
    res.json({ user: mustUser(ctx, uid) });
  }));

  app.delete('/api/me/avatar', ctx.requireAuth, route((req, res) => {
    const uid = userIdOf(req);
    const prev = (ctx.db.prepare('SELECT avatar_path FROM users WHERE id=?').get(uid) as
      { avatar_path: string | null }).avatar_path;
    if (prev) fs.rmSync(path.join(avatarDir, path.basename(prev)), { force: true });
    ctx.db.prepare('UPDATE users SET avatar_path=NULL WHERE id=?').run(uid);
    broadcastUser(ctx, uid);
    res.json({ user: mustUser(ctx, uid) });
  }));

  app.get('/api/avatars/:userId', ctx.requireAuth, route((req, res) => {
    const ownerId = String(req.params.userId);
    const row = ctx.db.prepare('SELECT avatar_path FROM users WHERE id=?').get(ownerId) as
      { avatar_path: string | null } | undefined;
    if (!row?.avatar_path || !canSeeProfileImage(ctx, userIdOf(req), ownerId)) throw new ApiError(404, 'no avatar');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.sendFile(path.join(avatarDir, path.basename(row.avatar_path)), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'no avatar' });
    });
  }));
}
