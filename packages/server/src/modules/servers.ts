import crypto from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  DEFAULT_VOICE_BITRATE_KBPS,
  VOICE_BITRATES_KBPS,
  type Channel,
  type Member,
  type Server,
  type ServerFrame,
} from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';
import { kickFromCall } from './voice.js';

const SERVER_NAME_MAX = 64;
const CHANNEL_NAME_MAX = 32;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_MAX_USES = 100;

type ServerRow = { id: string; name: string; owner_id: string };
type ChannelRow = {
  id: string;
  server_id: string;
  name: string;
  kind: Channel['kind'];
  bitrate_kbps: number;
};
type InviteRow = { server_id: string; expires_at: number; max_uses: number; uses: number };

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function bad(message: string): never {
  throw new ApiError(400, message);
}

/** Runs a handler, turning ApiError into a JSON response with its status. */
export function route(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err: unknown) => {
        if (err instanceof ApiError) res.status(err.status).json({ error: err.message });
        else next(err);
      });
  };
}

export const userIdOf = (req: Request): string => (req as AuthedRequest).userId;

export const bodyOf = (req: Request): Record<string, unknown> =>
  (req.body ?? {}) as Record<string, unknown>;

export function cleanText(v: unknown, max: number, label: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < 1 || s.length > max || /[\u0000-\u001f\u007f]/.test(s)) {
    bad(`${label} must be 1-${max} printable characters`);
  }
  return s;
}

export function serverOf(ctx: Ctx, id: string): Server {
  const r = ctx.db.prepare('SELECT id, name, owner_id FROM servers WHERE id=?').get(id) as ServerRow;
  return { id: r.id, name: r.name, ownerId: r.owner_id };
}

const CHANNEL_COLUMNS = 'id, server_id, name, kind, bitrate_kbps';

/** bitrateKbps is only meaningful for voice channels, so text channels omit it. */
function toChannel(r: ChannelRow): Channel {
  return {
    id: r.id,
    serverId: r.server_id,
    name: r.name,
    kind: r.kind,
    ...(r.kind === 'voice' ? { bitrateKbps: r.bitrate_kbps } : {}),
  };
}

export function channelsOf(ctx: Ctx, serverId: string): Channel[] {
  return (ctx.db
    .prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE server_id=? ORDER BY rowid`)
    .all(serverId) as ChannelRow[])
    .map(toChannel);
}

function channelOf(ctx: Ctx, channelId: string): Channel {
  return toChannel(ctx.db.prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id=?`).get(channelId) as ChannelRow);
}

function insertChannel(ctx: Ctx, serverId: string, name: string, kind: Channel['kind']): Channel {
  const id = newId();
  ctx.db
    .prepare('INSERT INTO channels (id, server_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, serverId, name, kind, Date.now());
  return channelOf(ctx, id);
}

/** Owner or admin only. 404 for non-members so existence is not leaked. */
function requireAdmin(ctx: Ctx, serverId: string, userId: string): 'owner' | 'admin' {
  const role = ctx.roleIn(serverId, userId);
  if (!role) throw new ApiError(404, 'server not found');
  if (role === 'member') throw new ApiError(403, 'admins only');
  return role;
}

/** Users who share at least one server with `userId` (includes `userId` if they are in any server). */
export function peerIds(ctx: Ctx, userId: string): string[] {
  return (ctx.db
    .prepare(
      'SELECT DISTINCT m2.user_id AS id FROM members m1 JOIN members m2 ON m2.server_id = m1.server_id WHERE m1.user_id = ?',
    )
    .all(userId) as { id: string }[]).map((r) => r.id);
}

export function isBanned(ctx: Ctx, serverId: string, userId: string): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM bans WHERE server_id=? AND user_id=?').get(serverId, userId);
}

/**
 * Adds `userId` to the invite's server, consuming one use. Must run inside the caller's
 * transaction. Returns null when the invite is unknown, expired or used up.
 */
export function redeemInvite(
  ctx: Ctx,
  code: string,
  userId: string,
): { serverId: string; joined: boolean } | null {
  const inv = ctx.db
    .prepare('SELECT server_id, expires_at, max_uses, uses FROM invites WHERE code=?')
    .get(code) as InviteRow | undefined;
  if (!inv) return null;
  if (ctx.roleIn(inv.server_id, userId)) return { serverId: inv.server_id, joined: false };
  if (isBanned(ctx, inv.server_id, userId)) throw new ApiError(403, 'you are banned from this server');
  if (inv.expires_at <= Date.now() || inv.uses >= inv.max_uses) return null;
  ctx.db.prepare('UPDATE invites SET uses = uses + 1 WHERE code=?').run(code);
  ctx.db
    .prepare('INSERT INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(inv.server_id, userId, 'member', Date.now());
  return { serverId: inv.server_id, joined: true };
}

export function announceJoin(ctx: Ctx, serverId: string, userId: string): void {
  const member: Member = {
    user: ctx.getUser(userId)!,
    role: ctx.roleIn(serverId, userId)!,
    devices: ctx.getDevices(userId),
  };
  ctx.broadcastToServer(serverId, { t: 'member.join', serverId, member });
}

export function register(app: Express, ctx: Ctx): void {
  // Databases created before per-channel bitrate lack the column; add it in place.
  const cols = ctx.db.prepare('PRAGMA table_info(channels)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'bitrate_kbps')) {
    ctx.db.exec(
      `ALTER TABLE channels ADD COLUMN bitrate_kbps INTEGER NOT NULL DEFAULT ${DEFAULT_VOICE_BITRATE_KBPS}`,
    );
  }

  app.post('/api/servers', ctx.requireAuth, route((req, res) => {
    const uid = userIdOf(req);
    const name = cleanText(bodyOf(req).name, SERVER_NAME_MAX, 'server name');
    const serverId = ctx.db.transaction(() => {
      const id = newId();
      const now = Date.now();
      ctx.db
        .prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)')
        .run(id, name, uid, now);
      ctx.db
        .prepare('INSERT INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
        .run(id, uid, 'owner', now);
      insertChannel(ctx, id, 'general', 'text');
      insertChannel(ctx, id, 'General', 'voice');
      return id;
    })();
    res.json({ server: serverOf(ctx, serverId), channels: channelsOf(ctx, serverId) });
  }));

  app.get('/api/servers', ctx.requireAuth, route((req, res) => {
    const ids = ctx.db
      .prepare('SELECT server_id FROM members WHERE user_id=? ORDER BY joined_at')
      .all(userIdOf(req)) as { server_id: string }[];
    res.json({
      servers: ids.map(({ server_id }) => ({
        server: serverOf(ctx, server_id),
        channels: channelsOf(ctx, server_id),
        members: ctx.getMembers(server_id),
      })),
    });
  }));

  app.post('/api/servers/:id/channels', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    requireAdmin(ctx, serverId, userIdOf(req));
    const body = bodyOf(req);
    if (body.kind !== 'text' && body.kind !== 'voice') bad('kind must be text or voice');
    const name = cleanText(body.name, CHANNEL_NAME_MAX, 'channel name');
    const channel = insertChannel(ctx, serverId, name, body.kind);
    ctx.broadcastToServer(serverId, { t: 'channel.new', channel });
    res.json({ channel });
  }));

  app.patch('/api/servers/:id/channels/:channelId', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    const channelId = String(req.params.channelId);
    requireAdmin(ctx, serverId, userIdOf(req));
    const row = ctx.db
      .prepare('SELECT kind FROM channels WHERE id=? AND server_id=?')
      .get(channelId, serverId) as { kind: Channel['kind'] } | undefined;
    if (!row) throw new ApiError(404, 'channel not found');
    const bitrate = bodyOf(req).bitrateKbps;
    if (typeof bitrate !== 'number' || !(VOICE_BITRATES_KBPS as readonly number[]).includes(bitrate)) {
      bad(`bitrateKbps must be one of ${VOICE_BITRATES_KBPS.join(', ')}`);
    }
    if (row.kind !== 'voice') bad('bitrate can only be set on voice channels');
    ctx.db.prepare('UPDATE channels SET bitrate_kbps=? WHERE id=?').run(bitrate, channelId);
    const channel = channelOf(ctx, channelId);
    ctx.broadcastToServer(serverId, { t: 'channel.update', channel });
    res.json({ channel });
  }));

  app.post('/api/servers/:id/invites', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    requireAdmin(ctx, serverId, userIdOf(req));
    const maxUses = bodyOf(req).maxUses ?? 1;
    if (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > INVITE_MAX_USES) {
      bad(`maxUses must be an integer 1-${INVITE_MAX_USES}`);
    }
    const code = crypto.randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + INVITE_TTL_MS;
    ctx.db
      .prepare('INSERT INTO invites (code, server_id, created_by, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)')
      .run(code, serverId, userIdOf(req), expiresAt, maxUses);
    res.json({ code, expiresAt });
  }));

  app.post('/api/invites/:code/join', ctx.requireAuth, route((req, res) => {
    const uid = userIdOf(req);
    const result = ctx.db.transaction(() => redeemInvite(ctx, String(req.params.code), uid))();
    if (!result) throw new ApiError(404, 'invite is invalid or expired');
    if (result.joined) announceJoin(ctx, result.serverId, uid);
    res.json({ server: serverOf(ctx, result.serverId) });
  }));

  app.get('/api/servers/:id/invites', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    requireAdmin(ctx, serverId, userIdOf(req));
    const rows = ctx.db
      .prepare('SELECT code, expires_at, max_uses, uses FROM invites WHERE server_id=? AND expires_at > ? AND uses < max_uses ORDER BY expires_at')
      .all(serverId, Date.now()) as { code: string; expires_at: number; max_uses: number; uses: number }[];
    res.json({
      invites: rows.map((r) => ({ code: r.code, expiresAt: r.expires_at, maxUses: r.max_uses, uses: r.uses })),
    });
  }));

  app.delete('/api/servers/:id/invites/:code', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    requireAdmin(ctx, serverId, userIdOf(req));
    const { changes } = ctx.db
      .prepare('DELETE FROM invites WHERE code=? AND server_id=?')
      .run(String(req.params.code), serverId);
    if (changes === 0) throw new ApiError(404, 'invite not found');
    res.json({ ok: true });
  }));

  app.delete('/api/servers/:id/members/:userId', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    const targetId = String(req.params.userId);
    assertCanModerate(ctx, serverId, userIdOf(req), targetId);
    removeMember(ctx, serverId, targetId);
    res.json({ ok: true });
  }));

  app.post('/api/servers/:id/bans', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    const actorId = userIdOf(req);
    const targetId = bodyOf(req).userId;
    if (typeof targetId !== 'string') bad('userId is required');
    assertCanModerate(ctx, serverId, actorId, targetId);
    ctx.db.transaction(() => {
      ctx.db
        .prepare('INSERT OR IGNORE INTO bans (server_id, user_id, banned_by, created_at) VALUES (?, ?, ?, ?)')
        .run(serverId, targetId, actorId, Date.now());
      removeMember(ctx, serverId, targetId);
    })();
    res.json({ ok: true });
  }));

  app.get('/api/servers/:id/bans', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    requireAdmin(ctx, serverId, userIdOf(req));
    const rows = ctx.db
      .prepare('SELECT user_id, created_at FROM bans WHERE server_id=? ORDER BY created_at')
      .all(serverId) as { user_id: string; created_at: number }[];
    const bans = rows.flatMap((r) => {
      const user = ctx.getUser(r.user_id);
      return user ? [{ user, bannedAt: r.created_at }] : [];
    });
    res.json({ bans });
  }));

  app.delete('/api/servers/:id/bans/:userId', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    requireAdmin(ctx, serverId, userIdOf(req));
    const { changes } = ctx.db
      .prepare('DELETE FROM bans WHERE server_id=? AND user_id=?')
      .run(serverId, String(req.params.userId));
    if (changes === 0) throw new ApiError(404, 'ban not found');
    res.json({ ok: true });
  }));
}

/** Admins can kick or ban members, but never the owner, and only the owner can act on an admin. */
function assertCanModerate(ctx: Ctx, serverId: string, actorId: string, targetId: string): void {
  const actorRole = requireAdmin(ctx, serverId, actorId);
  if (targetId === actorId) bad('you cannot remove yourself');
  const targetRole = ctx.roleIn(serverId, targetId);
  if (!targetRole) throw new ApiError(404, 'member not found');
  if (targetRole === 'owner' || (targetRole === 'admin' && actorRole !== 'owner')) {
    throw new ApiError(403, 'you cannot remove this member');
  }
}

/** Takes a user out of the server: membership, their live socket, and any voice call they are in. */
function removeMember(ctx: Ctx, serverId: string, targetId: string): void {
  ctx.db.prepare('DELETE FROM members WHERE server_id=? AND user_id=?').run(serverId, targetId);
  // Sent after the delete, so the kicked user needs an explicit send.
  const leave: ServerFrame = { t: 'member.leave', serverId, userId: targetId };
  ctx.broadcastToServer(serverId, leave);
  ctx.sendToUser(targetId, leave);
  kickFromCall(ctx, serverId, targetId);
}
