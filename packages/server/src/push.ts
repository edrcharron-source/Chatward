import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import webpush from 'web-push';
import type { AuthedRequest, Ctx } from './ctx.js';
import { newId } from './db.js';

/**
 * Web Push: notifications for the web app, including the app added to an iPhone home screen (iOS 16.4 or later).
 *
 * The server signs pushes with a VAPID key pair made on first start and kept in the data folder (vapid.json), unless
 * VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set. Pushes only carry what the server already knows: who did what, never
 * message text, which stays end-to-end encrypted.
 */

const MAX_DEVICES = 10;
/** Push services browsers use. A subscription naming any other host is refused, so the server never posts to arbitrary URLs. */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^android\.googleapis\.com$/];

export interface PushPayload { title: string; body: string; url?: string; tag?: string }

let vapidPublic = '';
let ready = false;

function loadKeys(dataDir: string): void {
  if (ready) return;
  let keys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
    : null;
  if (!keys) {
    const file = path.join(dataDir, 'vapid.json');
    try { keys = JSON.parse(fs.readFileSync(file, 'utf8')) as { publicKey: string; privateKey: string }; } catch { keys = null; }
    if (!keys?.publicKey || !keys.privateKey) {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    }
  }
  // Apple refuses pushes whose subject is not a mailto: or https: address.
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);
  vapidPublic = keys.publicKey;
  ready = true;
}

export function validPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch { return false; }
}

interface SubRow { id: string; endpoint: string; p256dh: string; auth: string }

/** Sends a notification to every device the user turned notifications on for. Resolves true if any device took it. */
export async function pushToUser(ctx: Ctx, userId: string, payload: PushPayload): Promise<boolean> {
  if (!ready) return false;
  const subs = ctx.db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?').all(userId) as SubRow[];
  const results = await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 12 * 60 * 60, urgency: 'normal', topic: payload.tag?.slice(0, 32) });
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // Gone: the device turned notifications off or the app was removed.
      if (status === 404 || status === 410) ctx.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
      else console.warn('[push] failed', status ?? (err as Error).message);
      return false;
    }
  }));
  return results.some(Boolean);
}

export function register(app: Express, ctx: Ctx): void {
  const { db } = ctx;
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_id TEXT,
    endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);`);
  try { loadKeys(ctx.config.dataDir); } catch (e) { console.warn('[push] disabled:', (e as Error).message); }

  app.get('/api/push/key', ctx.requireAuth, (_req, res) => {
    if (!ready) { res.status(503).json({ error: 'Notifications are not set up on this server.' }); return; }
    res.json({ publicKey: vapidPublic });
  });

  app.get('/api/push/status', ctx.requireAuth, (req, res) => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?').get((req as AuthedRequest).userId) as { n: number };
    res.json({ devices: n });
  });

  app.post('/api/push/subscribe', ctx.requireAuth, (req, res) => {
    const { userId, deviceId } = req as AuthedRequest;
    const sub = (req.body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const p256dh = sub.keys?.p256dh; const auth = sub.keys?.auth;
    if (!validPushEndpoint(sub.endpoint) || typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) {
      res.status(400).json({ error: 'That notification subscription was not valid.' }); return;
    }
    const endpoint = sub.endpoint;
    db.transaction(() => {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
      db.prepare('INSERT INTO push_subscriptions (id, user_id, device_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(newId(), userId, deviceId ?? null, endpoint, p256dh, auth, Date.now());
      // Keep only the newest few devices.
      db.prepare(`DELETE FROM push_subscriptions WHERE user_id=? AND id NOT IN
        (SELECT id FROM push_subscriptions WHERE user_id=? ORDER BY created_at DESC LIMIT ${MAX_DEVICES})`).run(userId, userId);
    })();
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', ctx.requireAuth, (req, res) => {
    const endpoint = (req.body as { endpoint?: unknown })?.endpoint;
    if (typeof endpoint === 'string') db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(endpoint, (req as AuthedRequest).userId);
    res.json({ ok: true });
  });

  app.post('/api/push/test', ctx.requireAuth, async (req, res) => {
    const delivered = await pushToUser(ctx, (req as AuthedRequest).userId, { title: 'Chatward', body: 'Notifications are working.', tag: 'test' });
    res.json({ ok: true, delivered });
  });

  // New messages: a member with no open connection gets "Name sent a message in #channel". The text is encrypted, so
  // the push never has it. One push per channel per person every few minutes, so a busy chat doesn't buzz nonstop.
  const lastPushed = new Map<string, number>();
  const QUIET_MS = 3 * 60_000;
  const online = new Set<string>();
  ctx.onConnect.push((userId) => { online.add(userId); });
  ctx.onDisconnect.push((userId, _device, state) => { if (!state.user) online.delete(userId); });
  messageHooks.push((channelId, authorId) => {
    const ch = ctx.getChannel(channelId);
    if (!ch) return;
    const author = ctx.getUser(authorId)?.displayName ?? 'Someone';
    for (const m of ctx.getMembers(ch.serverId)) {
      const uid = m.user.id;
      if (uid === authorId || online.has(uid)) continue;
      const key = `${uid}|${channelId}`;
      const now = Date.now();
      if (now - (lastPushed.get(key) ?? 0) < QUIET_MS) continue;
      lastPushed.set(key, now);
      void pushToUser(ctx, uid, { title: `#${ch.name}`, body: `${author} sent a message`, url: '/?tab=text', tag: `chat-${channelId}` });
    }
  });
}

/** Called by the messages module after a new message is stored. */
export const messageHooks: Array<(channelId: string, authorId: string) => void> = [];
