import type { Express, Response } from 'express';
import { LIMITS, type Channel, type KeyEnvelope, type Message } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';

interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  created_at: number;
  edited_at: number | null;
  key_version: number;
  ciphertext: string;
}

/** A message row plus the server it belongs to, for authz. */
type MessageRef = MessageRow & { server_id: string };

interface EnvelopeRow {
  channel_id: string;
  key_version: number;
  to_device_id: string;
  from_device_id: string;
  wrapped: string;
  signature: string;
}

const MAX_ENVELOPES_PER_REQUEST = 500;
const MAX_ATTACHMENTS = 10; // matches the composer's file limit
const ENVELOPE_FIELD_MAX = 2048;
const SIGNATURE_MAX = 512;

const ID = /^[0-9a-z]{1,40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  channelId: r.channel_id,
  authorId: r.author_id,
  createdAt: r.created_at,
  editedAt: r.edited_at,
  keyVersion: r.key_version,
  ciphertext: r.ciphertext,
});

const toEnvelope = (r: EnvelopeRow): KeyEnvelope => ({
  channelId: r.channel_id,
  keyVersion: r.key_version,
  toDeviceId: r.to_device_id,
  fromDeviceId: r.from_device_id,
  wrapped: r.wrapped,
  signature: r.signature,
});

const validCiphertext = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= LIMITS.MESSAGE_CIPHERTEXT_MAX && BASE64.test(v);

const validKeyVersion = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;

const parseLimit = (raw: unknown): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return LIMITS.HISTORY_PAGE;
  return Math.min(n, LIMITS.HISTORY_PAGE);
};

const bad = (res: Response, error: string) => res.status(400).json({ error });

export function register(app: Express, ctx: Ctx): void {
  const { db } = ctx;

  const historyLatest = db.prepare(
    'SELECT * FROM messages WHERE channel_id=? ORDER BY id DESC LIMIT ?');
  const historyBefore = db.prepare(
    'SELECT * FROM messages WHERE channel_id=? AND id<? ORDER BY id DESC LIMIT ?');
  const historyAfter = db.prepare(
    'SELECT * FROM messages WHERE channel_id=? AND id>? ORDER BY id ASC LIMIT ?');
  const insertMessage = db.prepare(
    'INSERT INTO messages (id, channel_id, author_id, created_at, key_version, ciphertext) VALUES (?,?,?,?,?,?)');
  // Only uploads the caller made for this purpose, and not already attached to another message.
  const attachableUpload = db.prepare(
    'SELECT 1 FROM uploads WHERE id=? AND owner_id=? AND tracked=1 AND message_id IS NULL');
  const attachUpload = db.prepare('UPDATE uploads SET message_id=? WHERE id=?');
  const updateMessage = db.prepare(
    'UPDATE messages SET ciphertext=?, key_version=?, edited_at=? WHERE id=?');
  const deleteMessage = db.prepare('DELETE FROM messages WHERE id=?');
  const findMessage = db.prepare(
    'SELECT m.*, c.server_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=?');

  const deviceOwnerInServer = db.prepare(
    'SELECT d.user_id FROM devices d JOIN members m ON m.user_id=d.user_id WHERE d.device_id=? AND m.server_id=?');
  // First envelope per device per version wins; rotation creates a new version instead of overwriting.
  const insertEnvelope = db.prepare(`
    INSERT INTO key_envelopes (channel_id, key_version, to_device_id, from_device_id, wrapped, signature)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(channel_id, key_version, to_device_id) DO NOTHING`);
  const envelopesForDevice = db.prepare(
    'SELECT * FROM key_envelopes WHERE channel_id=? AND to_device_id=? ORDER BY key_version');
  const latestKeyVersion = db.prepare(
    'SELECT COALESCE(MAX(key_version), 0) AS v FROM key_envelopes WHERE channel_id=?');
  const devicesMissingKey = db.prepare(`
    SELECT d.device_id FROM members m JOIN devices d ON d.user_id=m.user_id
    WHERE m.server_id=?
      AND NOT EXISTS (
        SELECT 1 FROM key_envelopes k
        WHERE k.channel_id=? AND k.key_version=? AND k.to_device_id=d.device_id)`);

  /** Text channel the caller is a member of. 404 for non-members so channel ids can't be probed. */
  const textChannelFor = (userId: string, channelId: string, res: Response): Channel | null => {
    const ch = ctx.getChannel(channelId);
    if (!ch || !ctx.roleIn(ch.serverId, userId)) { res.status(404).json({ error: 'channel not found' }); return null; }
    if (ch.kind !== 'text') { bad(res, 'not a text channel'); return null; }
    return ch;
  };

  /** Message in a server the caller belongs to. 404 otherwise. */
  const messageFor = (userId: string, messageId: string, res: Response): MessageRef | null => {
    const row = ID.test(messageId) ? (findMessage.get(messageId) as MessageRef | undefined) : undefined;
    if (!row || !ctx.roleIn(row.server_id, userId)) { res.status(404).json({ error: 'message not found' }); return null; }
    return row;
  };

  // ---------- messages ----------

  app.get('/api/channels/:id/messages', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ch = textChannelFor(userId, req.params.id, res);
    if (!ch) return;
    const { before, after } = req.query;
    if (before !== undefined && (typeof before !== 'string' || !ID.test(before))) return void bad(res, 'invalid before');
    if (after !== undefined && (typeof after !== 'string' || !ID.test(after))) return void bad(res, 'invalid after');
    if (before !== undefined && after !== undefined) return void bad(res, 'use before or after, not both');
    const limit = parseLimit(req.query.limit);
    // `after` pages forward, oldest first, so a client can walk from what it holds up to the newest message.
    if (typeof after === 'string') {
      const rows = historyAfter.all(ch.id, after, limit) as MessageRow[];
      return void res.json({ messages: rows.map(toMessage) });
    }
    const rows = (typeof before === 'string'
      ? historyBefore.all(ch.id, before, limit)
      : historyLatest.all(ch.id, limit)) as MessageRow[];
    res.json({ messages: rows.reverse().map(toMessage) });
  });

  app.post('/api/channels/:id/messages', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ch = textChannelFor(userId, req.params.id, res);
    if (!ch) return;
    const { ciphertext, keyVersion, attachmentIds = [] } = (req.body ?? {}) as
      { ciphertext?: unknown; keyVersion?: unknown; attachmentIds?: unknown };
    if (!validCiphertext(ciphertext)) return void bad(res, 'invalid ciphertext');
    if (!validKeyVersion(keyVersion)) return void bad(res, 'invalid keyVersion');
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_ATTACHMENTS) return void bad(res, 'invalid attachmentIds');
    if (new Set(attachmentIds).size !== attachmentIds.length) return void bad(res, 'invalid attachmentIds');
    if (!attachmentIds.every((id) => typeof id === 'string' && ID.test(id) && attachableUpload.get(id, userId))) {
      return void bad(res, 'invalid attachmentIds');
    }

    const row: MessageRow = {
      id: newId(),
      channel_id: ch.id,
      author_id: userId,
      created_at: Date.now(),
      edited_at: null,
      key_version: keyVersion,
      ciphertext,
    };
    db.transaction(() => {
      insertMessage.run(row.id, row.channel_id, row.author_id, row.created_at, row.key_version, row.ciphertext);
      for (const id of attachmentIds as string[]) attachUpload.run(row.id, id);
    })();
    const message = toMessage(row);
    ctx.broadcastToServer(ch.serverId, { t: 'message.new', message });
    res.status(201).json({ message });
  });

  app.patch('/api/messages/:id', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const row = messageFor(userId, req.params.id, res);
    if (!row) return;
    if (row.author_id !== userId) { res.status(403).json({ error: 'only the author can edit' }); return; }
    const { ciphertext, keyVersion } = (req.body ?? {}) as { ciphertext?: unknown; keyVersion?: unknown };
    if (!validCiphertext(ciphertext)) return void bad(res, 'invalid ciphertext');
    if (!validKeyVersion(keyVersion)) return void bad(res, 'invalid keyVersion');

    const editedAt = Date.now();
    updateMessage.run(ciphertext, keyVersion, editedAt, row.id);
    const message = toMessage({ ...row, ciphertext, key_version: keyVersion, edited_at: editedAt });
    ctx.broadcastToServer(row.server_id, { t: 'message.edit', message });
    res.json({ message });
  });

  app.delete('/api/messages/:id', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const row = messageFor(userId, req.params.id, res);
    if (!row) return;
    const role = ctx.roleIn(row.server_id, userId);
    if (row.author_id !== userId && role === 'member') {
      res.status(403).json({ error: 'only the author or an admin can delete' });
      return;
    }
    deleteMessage.run(row.id);
    ctx.broadcastToServer(row.server_id, { t: 'message.delete', channelId: row.channel_id, messageId: row.id });
    res.json({ ok: true });
  });

  // ---------- channel keys ----------

  app.post('/api/channels/:id/keys', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ch = textChannelFor(userId, req.params.id, res);
    if (!ch) return;
    const envelopes = (req.body ?? {}).envelopes;
    if (!Array.isArray(envelopes) || envelopes.length === 0 || envelopes.length > MAX_ENVELOPES_PER_REQUEST) {
      return void bad(res, 'envelopes must be a non-empty array');
    }

    const ownDevices = new Set(ctx.getDevices(userId).map((d) => d.deviceId));
    // Validate everything before writing anything: one bad envelope rejects the whole batch.
    const checked: { env: KeyEnvelope; toUserId: string }[] = [];
    for (const e of envelopes as Partial<Record<keyof KeyEnvelope, unknown>>[]) {
      const { keyVersion, toDeviceId, fromDeviceId, wrapped, signature } = e ?? {};
      if (!validKeyVersion(keyVersion)) return void bad(res, 'invalid keyVersion');
      if (typeof fromDeviceId !== 'string' || !ownDevices.has(fromDeviceId)) {
        return void res.status(403).json({ error: 'fromDeviceId is not one of your devices' });
      }
      if (typeof toDeviceId !== 'string') return void bad(res, 'invalid toDeviceId');
      const owner = deviceOwnerInServer.get(toDeviceId, ch.serverId) as { user_id: string } | undefined;
      if (!owner) return void bad(res, 'toDeviceId is not a device of a member');
      if (typeof wrapped !== 'string' || wrapped.length === 0 || wrapped.length > ENVELOPE_FIELD_MAX) {
        return void bad(res, 'invalid wrapped');
      }
      if (typeof signature !== 'string' || signature.length === 0 || signature.length > SIGNATURE_MAX) {
        return void bad(res, 'invalid signature');
      }
      checked.push({
        env: { channelId: ch.id, keyVersion, toDeviceId, fromDeviceId, wrapped, signature },
        toUserId: owner.user_id,
      });
    }

    const store = db.transaction((items: typeof checked) =>
      items.filter(({ env }) =>
        insertEnvelope.run(env.channelId, env.keyVersion, env.toDeviceId, env.fromDeviceId, env.wrapped, env.signature)
          .changes > 0));
    // Push only envelopes that were newly stored, and only to the device's owner.
    for (const { env, toUserId } of store(checked)) {
      ctx.sendToUser(toUserId, { t: 'key.envelope', envelope: env });
    }
    res.json({ ok: true });
  });

  app.get('/api/channels/:id/keys', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ch = textChannelFor(userId, req.params.id, res);
    if (!ch) return;
    const { deviceId } = req.query;
    if (typeof deviceId !== 'string' || !ctx.getDevices(userId).some((d) => d.deviceId === deviceId)) {
      res.status(403).json({ error: 'deviceId is not one of your devices' });
      return;
    }
    const rows = envelopesForDevice.all(ch.id, deviceId) as EnvelopeRow[];
    res.json({ envelopes: rows.map(toEnvelope) });
  });

  app.get('/api/channels/:id/key-status', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const ch = textChannelFor(userId, req.params.id, res);
    if (!ch) return;
    const { v } = latestKeyVersion.get(ch.id) as { v: number };
    const missing = devicesMissingKey.all(ch.serverId, ch.id, v) as { device_id: string }[];
    res.json({ latestVersion: v, devicesMissing: missing.map((m) => m.device_id) });
  });
}
