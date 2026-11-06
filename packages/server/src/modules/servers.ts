import type { Express, NextFunction, Request, Response } from 'express';
import {
  DEFAULT_VOICE_BITRATE_KBPS,
  LIMITS,
  VOICE_BITRATES_KBPS,
  type Channel,
  type Member,
  type Server,
  type ServerFrame,
} from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';
import { mainServerId } from '../singleServer.js';
import { forgetWatchParty } from './watchparty.js';
import { clearVoiceChannel, endAccountCall, forgetChannelRemovals, forgetMemberRemovals, kickFromCall } from './voice.js';

const { SERVER_NAME_MAX, CHANNEL_NAME_MAX } = LIMITS;

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

/**
 * Consumes one use of an invite made in the app before sign-up codes replaced it. Only invites to the one server
 * count, and an invite is deleted once its last use is taken. Run inside the sign-up transaction.
 */
export function takeLegacyInvite(ctx: Ctx, code: string, serverId: string): boolean {
  const inv = ctx.db
    .prepare('SELECT server_id, expires_at, max_uses, uses FROM invites WHERE code=?')
    .get(code) as InviteRow | undefined;
  if (!inv || inv.server_id !== serverId || inv.expires_at <= Date.now() || inv.uses >= inv.max_uses) return false;
  if (inv.uses + 1 >= inv.max_uses) ctx.db.prepare('DELETE FROM invites WHERE code=?').run(code);
  else ctx.db.prepare('UPDATE invites SET uses = uses + 1 WHERE code=?').run(code);
  return true;
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

  app.get('/api/servers', ctx.requireAuth, route((req, res) => {
    // Only the one server is listed. Extra servers from before the single-server release stay in the database unlisted.
    const main = mainServerId(ctx.db);
    const ids = main && ctx.roleIn(main, userIdOf(req)) ? [{ server_id: main }] : [];
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

  /** Renames a channel and/or sets its voice bitrate. Both are validated before anything is written. */
  app.patch('/api/servers/:id/channels/:channelId', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    const channelId = String(req.params.channelId);
    requireAdmin(ctx, serverId, userIdOf(req));
    const row = ctx.db
      .prepare('SELECT kind FROM channels WHERE id=? AND server_id=?')
      .get(channelId, serverId) as { kind: Channel['kind'] } | undefined;
    if (!row) throw new ApiError(404, 'channel not found');
    const body = bodyOf(req);
    if (body.name === undefined && body.bitrateKbps === undefined) bad('nothing to update');
    const name = body.name === undefined ? null : cleanText(body.name, CHANNEL_NAME_MAX, 'channel name');
    const bitrate = body.bitrateKbps;
    if (bitrate !== undefined) {
      if (typeof bitrate !== 'number' || !(VOICE_BITRATES_KBPS as readonly number[]).includes(bitrate)) {
        bad(`bitrateKbps must be one of ${VOICE_BITRATES_KBPS.join(', ')}`);
      }
      if (row.kind !== 'voice') bad('bitrate can only be set on voice channels');
    }
    if (name !== null) ctx.db.prepare('UPDATE channels SET name=? WHERE id=?').run(name, channelId);
    if (typeof bitrate === 'number') ctx.db.prepare('UPDATE channels SET bitrate_kbps=? WHERE id=?').run(bitrate, channelId);
    const channel = channelOf(ctx, channelId);
    ctx.broadcastToServer(serverId, { t: 'channel.update', channel });
    res.json({ channel });
  }));

  app.delete('/api/servers/:id/channels/:channelId', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    const channelId = String(req.params.channelId);
    requireAdmin(ctx, serverId, userIdOf(req));
    const row = ctx.db
      .prepare('SELECT kind FROM channels WHERE id=? AND server_id=?')
      .get(channelId, serverId) as { kind: Channel['kind'] } | undefined;
    if (!row) throw new ApiError(404, 'channel not found');
    // Voice calls take their key from the server's first text channel, so a server must always keep one.
    if (row.kind === 'text') {
      const { count } = ctx.db
        .prepare("SELECT COUNT(*) AS count FROM channels WHERE server_id=? AND kind='text'")
        .get(serverId) as { count: number };
      if (count <= 1) throw new ApiError(409, 'a server needs at least one text channel');
    }
    // Everyone in the voice channel is dropped first. Messages, keys and MLS state cascade with the row.
    clearVoiceChannel(ctx, channelId);
    ctx.db.prepare('DELETE FROM channels WHERE id=?').run(channelId);
    forgetChannelRemovals(ctx, channelId);
    forgetWatchParty(channelId);
    ctx.broadcastToServer(serverId, { t: 'channel.delete', serverId, channelId });
    res.json({ ok: true });
  }));

  app.patch('/api/servers/:id', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    requireAdmin(ctx, serverId, userIdOf(req));
    const name = cleanText(bodyOf(req).name, SERVER_NAME_MAX, 'server name');
    ctx.db.prepare('UPDATE servers SET name=? WHERE id=?').run(name, serverId);
    const server = serverOf(ctx, serverId);
    ctx.broadcastToServer(serverId, { t: 'server.update', server });
    res.json({ server });
  }));

  // Owner only: promote a member to admin or demote an admin back to member.
  app.patch('/api/servers/:id/members/:userId', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    const targetId = String(req.params.userId);
    const actorRole = ctx.roleIn(serverId, userIdOf(req));
    if (!actorRole) throw new ApiError(404, 'server not found');
    if (actorRole !== 'owner') throw new ApiError(403, 'only the owner can change roles');
    const role = bodyOf(req).role;
    if (role !== 'admin' && role !== 'member') bad('role must be admin or member');
    const targetRole = ctx.roleIn(serverId, targetId);
    if (!targetRole) throw new ApiError(404, 'member not found');
    if (targetRole === 'owner') bad('the owner role cannot be changed');
    ctx.db.prepare('UPDATE members SET role=? WHERE server_id=? AND user_id=?').run(role, serverId, targetId);
    ctx.broadcastToServer(serverId, { t: 'member.role', serverId, userId: targetId, role });
    res.json({ ok: true });
  }));

  // There is one server, so removing someone from it turns their account off. Ban and kick do the same thing; the ban
  // list is the list of turned-off accounts, and lifting a ban turns the account back on.
  app.delete('/api/servers/:id/members/:userId', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    const targetId = String(req.params.userId);
    assertCanModerate(ctx, serverId, userIdOf(req), targetId);
    disableAccount(ctx, targetId);
    res.json({ ok: true });
  }));

  app.post('/api/servers/:id/bans', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    const targetId = bodyOf(req).userId;
    if (typeof targetId !== 'string') bad('userId is required');
    assertCanModerate(ctx, serverId, userIdOf(req), targetId);
    disableAccount(ctx, targetId);
    res.json({ ok: true });
  }));

  app.get('/api/servers/:id/bans', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    requireAdmin(ctx, serverId, userIdOf(req));
    const rows = ctx.db
      .prepare('SELECT id, disabled_at FROM users WHERE disabled_at IS NOT NULL AND deleted_at IS NULL ORDER BY disabled_at')
      .all() as { id: string; disabled_at: number }[];
    const bans = rows.flatMap((r) => {
      const user = ctx.getUser(r.id);
      return user ? [{ user, bannedAt: r.disabled_at }] : [];
    });
    res.json({ bans });
  }));

  // People who have posted here but are no longer members and whose account is still on. With one server that is
  // rare, but the moderation panel still offers it.
  app.get('/api/servers/:id/former-members', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    requireAdmin(ctx, serverId, userIdOf(req));
    const rows = ctx.db
      .prepare(`
        SELECT m.author_id AS user_id FROM messages m
        JOIN channels c ON c.id = m.channel_id
        JOIN users u ON u.id = m.author_id
        WHERE c.server_id = ?
          AND m.author_id NOT IN (SELECT user_id FROM members WHERE server_id = ?)
          AND u.disabled_at IS NULL AND u.deleted_at IS NULL
        GROUP BY m.author_id
        ORDER BY MAX(m.id) DESC
        LIMIT 100`)
      .all(serverId, serverId) as { user_id: string }[];
    const users = rows.flatMap((r) => {
      const user = ctx.getUser(r.user_id);
      return user ? [user] : [];
    });
    res.json({ users });
  }));

  app.delete('/api/servers/:id/bans/:userId', ctx.requireAuth, route((req, res) => {
    const serverId = String(req.params.id);
    requireAdmin(ctx, serverId, userIdOf(req));
    if (!restoreAccount(ctx, String(req.params.userId))) throw new ApiError(404, 'ban not found');
    res.json({ ok: true });
  }));
}

/** Admins can remove members, but never the owner, and only the owner can act on an admin. */
function assertCanModerate(ctx: Ctx, serverId: string, actorId: string, targetId: string): void {
  const actorRole = requireAdmin(ctx, serverId, actorId);
  if (targetId === actorId) bad('you cannot remove yourself');
  const targetRole = ctx.roleIn(serverId, targetId);
  if (!targetRole) throw new ApiError(404, 'member not found');
  if (targetRole === 'owner' || (targetRole === 'admin' && actorRole !== 'owner')) {
    throw new ApiError(403, 'you cannot remove this member');
  }
}

/**
 * Turns an account off: it is signed out everywhere, leaves the server (so peers drop its devices from every MLS
 * group) and cannot sign in until restoreAccount. Its messages and devices stay. Returns false if it was already off.
 */
export function disableAccount(ctx: Ctx, userId: string): boolean {
  const serverId = mainServerId(ctx.db);
  const changed = ctx.db.transaction(() => {
    const { changes } = ctx.db
      .prepare('UPDATE users SET disabled_at=?, session_version=session_version+1 WHERE id=? AND disabled_at IS NULL AND deleted_at IS NULL')
      .run(Date.now(), userId);
    if (changes === 0) return false;
    ctx.db.prepare('DELETE FROM password_resets WHERE user_id=?').run(userId);
    return true;
  })();
  if (!changed) return false;
  if (serverId && ctx.roleIn(serverId, userId)) removeMember(ctx, serverId, userId);
  endAccountCall(ctx, userId);
  ctx.revokeSockets(userId);
  return true;
}

/** Turns an account back on and puts it back in the server as a member. Returns false if it was not off. */
export function restoreAccount(ctx: Ctx, userId: string): boolean {
  const serverId = mainServerId(ctx.db);
  const changed = ctx.db.transaction(() => {
    const { changes } = ctx.db
      .prepare('UPDATE users SET disabled_at=NULL WHERE id=? AND disabled_at IS NOT NULL AND deleted_at IS NULL')
      .run(userId);
    if (changes === 0) return false;
    if (serverId) {
      ctx.db.prepare("INSERT OR IGNORE INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
        .run(serverId, userId, Date.now());
    }
    return true;
  })();
  if (changed && serverId) announceJoin(ctx, serverId, userId);
  return changed;
}

/** A reset code only works while its issuer still owns a server the member is in. */
export const ISSUER_OWNS_SHARED_SERVER = `EXISTS (
  SELECT 1 FROM members m JOIN servers s ON s.id = m.server_id
  WHERE m.user_id = password_resets.user_id AND s.owner_id = password_resets.issued_by)`;

/** Drops reset codes whose issuer no longer owns a server with the member. Run after any membership or ownership change. */
export function pruneResetCodes(ctx: Ctx): void {
  ctx.db.prepare(`DELETE FROM password_resets WHERE NOT ${ISSUER_OWNS_SHARED_SERVER}`).run();
}

/** Takes a user out of the server: membership, their live socket, and any voice call they are in. */
export function removeMember(ctx: Ctx, serverId: string, targetId: string): void {
  ctx.db.prepare('DELETE FROM members WHERE server_id=? AND user_id=?').run(serverId, targetId);
  forgetMemberRemovals(ctx, serverId, targetId);
  pruneResetCodes(ctx);
  // Sent after the delete, so the kicked user needs an explicit send.
  const leave: ServerFrame = { t: 'member.leave', serverId, userId: targetId };
  ctx.broadcastToServer(serverId, leave);
  ctx.sendToUser(targetId, leave);
  kickFromCall(ctx, serverId, targetId);
}
