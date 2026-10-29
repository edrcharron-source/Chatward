// The `chatward` command on the server talks to the running server through a socket file in the data folder. It is
// not a network port, so nothing outside the machine can reach it, and the file is readable only by the server's own
// user. Anyone who can run commands in the server container can use it; on lebserver that means SSH plus Docker.
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import type { Ctx } from '../ctx.js';
import { adminSocketPathFor } from '../adminSocketPath.js';
import { mainServerId } from '../singleServer.js';
import {
  SIGNUP_CODE_DEFAULT_HOURS,
  SIGNUP_CODE_MAX_HOURS,
  createSignupCode,
  inviteLogPath,
  listSignupCodes,
  revokeSignupCode,
  sweepExpiredSignupCodes,
} from '../signupCodes.js';
import { issueResetCode } from './auth.js';
import { ApiError, bad, bodyOf, disableAccount, restoreAccount, route } from './servers.js';

type UserRow = {
  id: string; username: string; created_at: number; disabled_at: number | null;
  invited_by: string | null; invite_label: string | null; role: string | null; last_seen: number | null;
};

function findUser(ctx: Ctx, name: unknown): UserRow {
  if (typeof name !== 'string' || !name.trim()) bad('give the account name');
  const row = ctx.db.prepare(`SELECT u.id, u.username, u.created_at, u.disabled_at, u.invited_by, u.invite_label,
      m.role, (SELECT MAX(last_seen) FROM devices d WHERE d.user_id=u.id) AS last_seen
    FROM users u LEFT JOIN members m ON m.user_id=u.id AND m.server_id=?
    WHERE u.username=? AND u.deleted_at IS NULL`).get(mainServerId(ctx.db), name.trim()) as UserRow | undefined;
  if (!row) throw new ApiError(404, `no account is called ${name.trim()}`);
  return row;
}

function issuerOf(body: Record<string, unknown>): string {
  const v = typeof body.issuer === 'string' ? body.issuer.trim() : '';
  return /^[A-Za-z0-9_.@-]{1,64}$/.test(v) ? v : 'server';
}

function requireServerOwner(ctx: Ctx): { serverId: string; ownerId: string } {
  const serverId = mainServerId(ctx.db);
  if (!serverId) throw new ApiError(409, 'there are no accounts yet, make the first one with a sign-up code');
  const { owner_id } = ctx.db.prepare('SELECT owner_id FROM servers WHERE id=?').get(serverId) as { owner_id: string };
  return { serverId, ownerId: owner_id };
}

export function startAdminSocket(ctx: Ctx): http.Server {
  const { db } = ctx;
  const dataDir = ctx.config.dataDir;
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.post('/invite', route((req, res) => {
    const body = bodyOf(req);
    const hours = body.hours === undefined ? SIGNUP_CODE_DEFAULT_HOURS : Number(body.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > SIGNUP_CODE_MAX_HOURS) bad(`hours must be between 1 and ${SIGNUP_CODE_MAX_HOURS}`);
    const made = createSignupCode(db, dataDir, hours, issuerOf(body));
    const firstAccount = mainServerId(db) === null;
    res.json({ ...made, publicUrl: ctx.config.publicUrl, firstAccount });
  }));

  app.get('/invites', route((_req, res) => {
    sweepExpiredSignupCodes(db, dataDir);
    res.json({ codes: listSignupCodes(db) });
  }));

  app.post('/revoke', route((req, res) => {
    const body = bodyOf(req);
    if (typeof body.code !== 'string') bad('give the code, or its last 4 characters');
    const result = revokeSignupCode(db, dataDir, body.code, issuerOf(body));
    if ('error' in result) throw new ApiError(404, result.error);
    res.json(result);
  }));

  app.get('/users', route((_req, res) => {
    const rows = db.prepare(`SELECT u.id, u.username, u.created_at, u.disabled_at, u.invited_by, u.invite_label,
        m.role, (SELECT MAX(last_seen) FROM devices d WHERE d.user_id=u.id) AS last_seen
      FROM users u LEFT JOIN members m ON m.user_id=u.id AND m.server_id=?
      WHERE u.deleted_at IS NULL ORDER BY u.created_at`).all(mainServerId(db)) as UserRow[];
    res.json({
      users: rows.map((r) => ({
        name: r.username, role: r.disabled_at ? 'off' : (r.role ?? 'none'), createdAt: r.created_at,
        lastSeen: r.last_seen, invitedBy: r.invited_by, inviteLabel: r.invite_label,
      })),
    });
  }));

  app.post('/reset', route((req, res) => {
    const user = findUser(ctx, bodyOf(req).name);
    if (user.disabled_at) bad(`${user.username} is turned off, run chatward restore first`);
    const { ownerId } = requireServerOwner(ctx);
    res.json({ name: user.username, ...issueResetCode(ctx, user.id, ownerId) });
  }));

  app.post('/remove', route((req, res) => {
    const user = findUser(ctx, bodyOf(req).name);
    if (user.role === 'owner') bad('the owner account cannot be turned off');
    if (!disableAccount(ctx, user.id)) bad(`${user.username} is already turned off`);
    res.json({ name: user.username });
  }));

  app.post('/restore', route((req, res) => {
    const user = findUser(ctx, bodyOf(req).name);
    if (!restoreAccount(ctx, user.id)) bad(`${user.username} is not turned off`);
    res.json({ name: user.username });
  }));

  app.post('/role', route((req, res) => {
    const body = bodyOf(req);
    const user = findUser(ctx, body.name);
    const role = body.role;
    if (role !== 'admin' && role !== 'member') bad('role must be admin or member');
    if (user.disabled_at) bad(`${user.username} is turned off`);
    if (user.role === 'owner') bad('the owner role cannot be changed');
    const { serverId } = requireServerOwner(ctx);
    db.prepare('UPDATE members SET role=? WHERE server_id=? AND user_id=?').run(role, serverId, user.id);
    ctx.broadcastToServer(serverId, { t: 'member.role', serverId, userId: user.id, role });
    res.json({ name: user.username, role });
  }));

  app.get('/log', route((_req, res) => {
    sweepExpiredSignupCodes(db, dataDir);
    let log = '';
    try { log = fs.readFileSync(inviteLogPath(dataDir), 'utf8'); } catch { /* no codes made yet */ }
    res.json({ log });
  }));

  app.use((_req, res) => res.status(404).json({ error: 'unknown command' }));

  const socketPath = adminSocketPathFor(dataDir);
  // A socket file left by a server that did not shut down cleanly would make listen fail.
  if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true });
  const server = http.createServer(app);
  server.on('error', (err) => console.error('admin socket failed; the chatward command will not work', err));
  server.listen(socketPath, () => {
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
  });

  // Expired codes are deleted (and logged) every 10 minutes, and once now.
  sweepExpiredSignupCodes(db, dataDir);
  setInterval(() => sweepExpiredSignupCodes(db, dataDir), 10 * 60_000).unref();
  return server;
}
