import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { hash, verify } from '@node-rs/argon2';
import { LIMITS, type DeviceKeys } from '@chatward/shared';
import type { Ctx } from '../ctx.js';
import { newId } from '../db.js';
import {
  ApiError,
  announceJoin,
  bad,
  bodyOf,
  cleanText,
  ISSUER_OWNS_SHARED_SERVER,
  peerIds,
  pruneResetCodes,
  redeemInvite,
  removeMember,
  route,
  userIdOf,
} from './servers.js';

const USERNAME_RE = new RegExp(`^[A-Za-z0-9_.-]{${LIMITS.USERNAME_MIN},${LIMITS.USERNAME_MAX}}$`);
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PASSWORD_MAX = 1024;
const RESET_CODE_MS = 24 * 60 * 60_000;
// No look-alike characters (0/O, 1/I), so a code read aloud or copied by hand is unambiguous.
const RESET_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DISPLAY_NAME_MAX = 32;
const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function validPassword(v: unknown): string {
  if (typeof v !== 'string' || v.length < LIMITS.PASSWORD_MIN || v.length > PASSWORD_MAX) {
    bad(`password must be ${LIMITS.PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  }
  return v;
}

/** 12 characters (60 bits) shown as XXXX-XXXX-XXXX. The 32-character alphabet divides 256 evenly, so no bias. */
function newResetCode(): string {
  const chars = [...crypto.randomBytes(12)].map((b) => RESET_CODE_ALPHABET[b % 32]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Codes are compared by hash, so the database never holds a usable code. */
function codeHash(code: string): string {
  return crypto.createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
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

function mustUser(ctx: Ctx, userId: string) {
  const user = ctx.getUser(userId);
  if (!user) throw new ApiError(401, 'unauthorized');
  return user;
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

  app.post('/api/auth/register', route(async (req, res) => {
    const body = bodyOf(req);
    const username = typeof body.username === 'string' ? body.username : '';
    if (!USERNAME_RE.test(username)) {
      bad(`username must be ${LIMITS.USERNAME_MIN}-${LIMITS.USERNAME_MAX} letters, digits, dots, dashes or underscores`);
    }
    const displayName = cleanText(body.displayName, DISPLAY_NAME_MAX, 'display name');
    const password = validPassword(body.password);
    const device = parseDevice(body.device);
    const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode : null;
    const id = newId();
    const passwordHash = await hash(password);

    const joinedServerId = ctx.db.transaction((): string | null => {
      const { n } = ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
      const first = n === 0;
      if (!first && !inviteCode) throw new ApiError(403, 'an invite code is required');
      try {
        ctx.db
          .prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, username, displayName, passwordHash, Date.now());
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ApiError(409, 'username is taken');
        throw err;
      }
      upsertDevice(ctx, id, device);
      if (first || !inviteCode) return null;
      const joined = redeemInvite(ctx, inviteCode, id);
      if (!joined) throw new ApiError(403, 'invite is invalid or expired');
      return joined.serverId;
    })();

    if (joinedServerId) announceJoin(ctx, joinedServerId, id);
    res.json({ token: ctx.signToken(id), user: mustUser(ctx, id) });
  }));

  app.post('/api/auth/login', route(async (req, res) => {
    const body = bodyOf(req);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' && body.password.length <= PASSWORD_MAX ? body.password : '';
    const device = parseDevice(body.device);
    const row = username
      ? (ctx.db.prepare('SELECT id, password_hash FROM users WHERE username=? AND deleted_at IS NULL').get(username) as
          { id: string; password_hash: string } | undefined)
      : undefined;
    const ok = password !== '' && (await verify(row?.password_hash ?? (await dummyHash), password));
    if (!row || !ok) throw new ApiError(401, 'invalid username or password');
    if (ctx.db.transaction(() => upsertDevice(ctx, row.id, device))()) broadcastDevices(ctx, row.id);
    res.json({ token: ctx.signToken(row.id), user: mustUser(ctx, row.id) });
  }));

  // Signed-in password change. Needs the current password, and signs out every other session.
  // A wrong current password gets 403, not 401: the client treats 401 as "logged out".
  app.post('/api/me/password', ctx.requireAuth, route(async (req, res) => {
    const uid = userIdOf(req);
    const body = bodyOf(req);
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id=?').get(uid) as { password_hash: string } | undefined;
    if (!row) throw new ApiError(401, 'unauthorized');
    const current = typeof body.currentPassword === 'string' && body.currentPassword.length <= PASSWORD_MAX ? body.currentPassword : '';
    if (current === '' || !(await verify(row.password_hash, current))) throw new ApiError(403, 'current password is wrong');
    const newPassword = validPassword(body.newPassword);
    if (newPassword === current) bad('the new password must be different from the current one');
    const passwordHash = await hash(newPassword);
    ctx.db
      .prepare('UPDATE users SET password_hash=?, session_version=session_version+1 WHERE id=?')
      .run(passwordHash, uid);
    // A reset code issued before this change would let someone overwrite the password just set.
    ctx.db.prepare('DELETE FROM password_resets WHERE user_id=?').run(uid);
    res.json({ token: ctx.signToken(uid), user: mustUser(ctx, uid) });
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
    const code = newResetCode();
    const expiresAt = Date.now() + RESET_CODE_MS;
    ctx.db
      .prepare(`INSERT INTO password_resets (user_id, issued_by, code_hash, expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET issued_by = excluded.issued_by, code_hash = excluded.code_hash, expires_at = excluded.expires_at`)
      .run(targetId, uid, codeHash(code), expiresAt);
    res.json({ code, expiresAt });
  }));

  // Redeems an owner-issued code and sets a new password. The code is single-use: the DELETE below
  // only succeeds once, and the whole change rolls back if the device cannot be registered.
  app.post('/api/auth/reset', route(async (req, res) => {
    const body = bodyOf(req);
    const username = typeof body.username === 'string' ? body.username : '';
    const code = typeof body.code === 'string' ? body.code : '';
    const newPassword = validPassword(body.newPassword);
    const device = parseDevice(body.device);
    const user = username
      ? (ctx.db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: string } | undefined)
      : undefined;
    const passwordHash = await hash(newPassword);
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
    res.json({ token: ctx.signToken(user!.id), user: mustUser(ctx, user!.id) });
    ctx.revokeSockets(user!.id);
  }));

  app.get('/api/me', ctx.requireAuth, route((req, res) => {
    res.json({ user: mustUser(ctx, userIdOf(req)) });
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

  // Removes one of the caller's devices. Its pending KeyPackages, Welcomes and acks go with it, so it can no longer
  // join groups or hold up a reset. Peers see the new device list and drop it from their groups with a Remove Commit.
  app.delete('/api/me/devices/:deviceId', ctx.requireAuth, route((req, res) => {
    const uid = userIdOf(req);
    const deviceId = String(req.params.deviceId);
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
  }));

  // Each field is optional; a missing field keeps its current value.
  app.patch('/api/me', ctx.requireAuth, route((req, res) => {
    const uid = userIdOf(req);
    const body = bodyOf(req);
    const cur = mustUser(ctx, uid);
    const displayName = body.displayName === undefined
      ? cur.displayName
      : cleanText(body.displayName, DISPLAY_NAME_MAX, 'display name');
    const bio = body.bio === undefined ? cur.profile.bio : freeText(body.bio, LIMITS.BIO_MAX, 'bio', true);
    const pronouns = body.pronouns === undefined
      ? cur.profile.pronouns
      : freeText(body.pronouns, LIMITS.PRONOUNS_MAX, 'pronouns', false);
    const accentColor = body.accentColor === undefined ? cur.profile.accentColor : colorOrNull(body.accentColor, 'accent color');
    const bannerColor = body.bannerColor === undefined ? cur.profile.bannerColor : colorOrNull(body.bannerColor, 'banner color');
    ctx.db
      .prepare('UPDATE users SET display_name=?, bio=?, pronouns=?, accent_color=?, banner_color=? WHERE id=?')
      .run(displayName, bio, pronouns, accentColor, bannerColor, uid);
    broadcastUser(ctx, uid);
    res.json({ user: mustUser(ctx, uid) });
  }));

  // Deletes the caller's account. Owners must hand off or delete their servers first. The row stays as a
  // tombstone so old messages still point at a user; everything personal is wiped.
  app.post('/api/me/delete', ctx.requireAuth, route(async (req, res) => {
    const uid = userIdOf(req);
    const body = bodyOf(req);
    const password = typeof body.password === 'string' && body.password.length <= PASSWORD_MAX ? body.password : '';
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id=?').get(uid) as
      { password_hash: string } | undefined;
    if (!row) throw new ApiError(401, 'unauthorized');
    if (!password || !(await verify(row.password_hash, password))) throw new ApiError(403, 'password is incorrect');

    const owned = ctx.db.prepare('SELECT name FROM servers WHERE owner_id=?').all(uid) as { name: string }[];
    if (owned.length > 0) {
      throw new ApiError(409, `transfer or delete your servers first: ${owned.map((s) => s.name).join(', ')}`);
    }

    // Read before the wipe: the broadcasts below still need the servers the user is in.
    const serverIds = (ctx.db.prepare('SELECT server_id FROM members WHERE user_id=?').all(uid) as
      { server_id: string }[]).map((r) => r.server_id);
    const files = ctx.db.prepare('SELECT avatar_path, banner_path FROM users WHERE id=?').get(uid) as
      { avatar_path: string | null; banner_path: string | null };

    ctx.db.transaction(() => {
      ctx.db.prepare('DELETE FROM mls_keypackages WHERE device_id IN (SELECT device_id FROM devices WHERE user_id=?)').run(uid);
      ctx.db.prepare('DELETE FROM devices WHERE user_id=?').run(uid);
      ctx.db.prepare('DELETE FROM password_resets WHERE user_id=?').run(uid);
      ctx.db.prepare(`UPDATE users SET username=?, display_name='Deleted user', password_hash='', avatar_path=NULL,
          banner_path=NULL, bio='', pronouns='', accent_color=NULL, banner_color=NULL, deleted_at=? WHERE id=?`)
        .run(`deleted-${uid}`, Date.now(), uid);
    })();
    // Peers still share a server with the user at this point, so they hear about the wipe before the removal.
    broadcastDevices(ctx, uid);
    broadcastUser(ctx, uid);
    for (const serverId of serverIds) removeMember(ctx, serverId, uid);

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
    const row = ctx.db.prepare('SELECT banner_path FROM users WHERE id=?').get(String(req.params.userId)) as
      { banner_path: string | null } | undefined;
    if (!row?.banner_path) throw new ApiError(404, 'no banner');
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

  app.get('/api/avatars/:userId', ctx.requireAuth, route((req, res) => {
    const row = ctx.db.prepare('SELECT avatar_path FROM users WHERE id=?').get(String(req.params.userId)) as
      { avatar_path: string | null } | undefined;
    if (!row?.avatar_path) throw new ApiError(404, 'no avatar');
    res.setHeader('Cache-Control', 'private, no-cache');
    res.sendFile(path.join(avatarDir, path.basename(row.avatar_path)), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'no avatar' });
    });
  }));
}
