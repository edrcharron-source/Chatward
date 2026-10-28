import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { Channel, DeviceKeys, Member, User } from '@chatward/shared';
import { config, setupCode } from './config.js';
import { openDb } from './db.js';
import { makeAuth, type Ctx } from './ctx.js';
import { attachWs } from './ws.js';
import { register as auth } from './modules/auth.js';
import { register as servers } from './modules/servers.js';
import { register as messages } from './modules/messages.js';
import { register as uploads } from './modules/uploads.js';
import { register as soundboard } from './modules/soundboard.js';
import { register as gifs } from './modules/gifs.js';
import { register as linkpreview } from './modules/linkpreview.js';
import { register as voice } from './modules/voice.js';
import { register as groups } from './modules/groups.js';
import { register as watchparty } from './modules/watchparty.js';
import { register as updates } from './modules/updates.js';

// Log instead of exiting, so one bad request or a failed async task cannot take down every voice call and open socket.
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); });

const db = openDb();
const { signToken, verifySession, requireAuth } = makeAuth(db);

type UserRow = {
  id: string; username: string; display_name: string; avatar_path: string | null; created_at: number;
  bio: string; pronouns: string; accent_color: string | null; banner_color: string | null; banner_path: string | null;
};
const USER_COLUMNS = `id, username, display_name, avatar_path, created_at, bio, pronouns, accent_color, banner_color, banner_path`;
const avatarDir = path.join(config.dataDir, 'avatars');
const bannerDir = path.join(config.dataDir, 'banners');
// The stored file name stays the same when a picture is replaced, so browsers would keep showing
// the old image from cache. Adding the file's modified time to the URL makes a new upload load right away.
const imageVersion = (dir: string, file: string | null) => {
  if (!file) return '';
  try { return `?v=${Math.floor(fs.statSync(path.join(dir, path.basename(file))).mtimeMs)}`; }
  catch { return ''; }
};
const toUser = (r: UserRow): User => ({
  id: r.id, username: r.username, displayName: r.display_name,
  avatarUrl: r.avatar_path ? `/api/avatars/${r.id}${imageVersion(avatarDir, r.avatar_path)}` : null,
  profile: {
    bio: r.bio,
    pronouns: r.pronouns,
    accentColor: r.accent_color,
    bannerColor: r.banner_color,
    bannerUrl: r.banner_path ? `/api/banners/${r.id}${imageVersion(bannerDir, r.banner_path)}` : null,
    createdAt: r.created_at,
  },
});

const ctx: Ctx = {
  db, config, requireAuth, signToken, verifySession,
  broadcastToServer: () => {},
  sendToUser: () => {},
  revokeSockets: () => {},
  onDisconnect: [],
  onConnect: [],
  getUser: (id) => {
    const r = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id=?`).get(id) as UserRow | undefined;
    return r ? toUser(r) : null;
  },
  getDevices: (userId) =>
    (db.prepare('SELECT device_id, ecdh_public, sign_public FROM devices WHERE user_id=?').all(userId) as
      { device_id: string; ecdh_public: string; sign_public: string }[])
      .map((d): DeviceKeys => ({ deviceId: d.device_id, ecdhPublic: d.ecdh_public, signPublic: d.sign_public })),
  getMembers: (serverId) =>
    (db.prepare('SELECT user_id, role FROM members WHERE server_id=?').all(serverId) as { user_id: string; role: Member['role'] }[])
      .map((m): Member => ({ user: ctx.getUser(m.user_id)!, role: m.role, devices: ctx.getDevices(m.user_id) })),
  getChannel: (id) => {
    const r = db.prepare('SELECT id, server_id, name, kind FROM channels WHERE id=?').get(id) as
      { id: string; server_id: string; name: string; kind: Channel['kind'] } | undefined;
    return r ? { id: r.id, serverId: r.server_id, name: r.name, kind: r.kind } : null;
  },
  roleIn: (serverId, userId) =>
    ((db.prepare('SELECT role FROM members WHERE server_id=? AND user_id=?').get(serverId, userId) as { role: 'owner' | 'admin' | 'member' } | undefined)?.role ?? null),
  serverIdForChannelMember: (channelId, userId) =>
    ((db.prepare('SELECT c.server_id AS sid FROM channels c JOIN members m ON m.server_id=c.server_id WHERE c.id=? AND m.user_id=?').get(channelId, userId) as { sid: string } | undefined)?.sid ?? null),
};

const app = express();
app.disable('x-powered-by');
// Behind Caddy (TRUST_PROXY=1 in deploy/docker-compose.yml), trust its X-Forwarded-For so the login rate limit sees real client IPs.
if (config.trustProxy) app.set('trust proxy', 1);
app.use(helmet());
// Sign-in, register and reset share one per-IP limit. Refresh runs on its own, so a household that signs in and
// renews together does not use up the sign-in allowance.
app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: true, skip: (req) => req.path === '/refresh' }));
app.use('/api/auth/refresh', rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: true }));
// A Commit lists a batch of Welcomes, so it needs more room than the default limit. Only that route gets it.
app.post('/api/groups/:id/commits', express.json({ limit: '512kb' }));
app.use(express.json({ limit: '64kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

for (const reg of [auth, servers, messages, uploads, soundboard, gifs, linkpreview, voice, groups, watchparty, updates]) reg(app, ctx);

app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err: Error & { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // express.json rejects an oversize body with this type; that is the client's fault, not a server error.
  if (err.type === 'entity.too.large') { res.status(413).json({ error: 'request too large' }); return; }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const server = http.createServer(app);
attachWs(server, ctx);
// A fresh server needs its setup code before the first account, so make it (and print it) at startup.
const { n: accountCount } = db.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL').get() as { n: number };
if (accountCount === 0) setupCode();
server.listen(config.port, config.host, () =>
  console.log(`Chatward server listening on http://${config.host}:${config.port}`));
