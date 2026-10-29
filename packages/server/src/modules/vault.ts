import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { VaultItem } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';

const ITEM_ID = /^[0-9a-z]{1,40}$/;
const PAGE = 60;
const THUMB_MAX_BYTES = 512 * 1024;
const MB = 1024 * 1024;

type Row = {
  id: string; server_id: string; owner_id: string; channel_id: string; key_version: number;
  ciphertext: string; size: number; thumb_size: number; created_at: number;
};

/**
 * Shared photo and video gallery. Files and thumbnails are encrypted on the client before upload; the server only
 * stores the opaque blobs plus a small descriptor sealed with a channel key, so it never sees names, types or contents.
 * One upload carries both blobs: 4-byte big-endian thumbnail length, the thumbnail, then the file.
 */
export function register(app: Express, ctx: Ctx): void {
  const { db } = ctx;
  const { vaultDir, vaultQuotaBytes, vaultMaxBytes } = ctx.config;
  const filePath = (id: string, thumb = false) => path.join(vaultDir, thumb ? `${id}.thumb` : id);

  const toItem = (r: Row): VaultItem => ({
    id: r.id, serverId: r.server_id, ownerId: r.owner_id, createdAt: r.created_at,
    size: r.size + r.thumb_size, channelId: r.channel_id, keyVersion: r.key_version, ciphertext: r.ciphertext,
  });
  const byId = (id: string) => (ITEM_ID.test(id) ? db.prepare('SELECT * FROM vault_items WHERE id=?').get(id) as Row | undefined : undefined);
  const usedFor = db.prepare('SELECT COALESCE(SUM(size + thumb_size), 0) AS used FROM vault_items WHERE owner_id=?');
  // Checks the quota and records the row in one synchronous step, so simultaneous uploads cannot both squeeze under.
  const reserve = db.transaction((r: Row): boolean => {
    const { used } = usedFor.get(r.owner_id) as { used: number };
    if (vaultQuotaBytes > 0 && used + r.size + r.thumb_size > vaultQuotaBytes) return false;
    db.prepare('INSERT INTO vault_items (id, server_id, owner_id, channel_id, key_version, ciphertext, size, thumb_size, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(r.id, r.server_id, r.owner_id, r.channel_id, r.key_version, r.ciphertext, r.size, r.thumb_size, r.created_at);
    return true;
  });

  const requireMember = (req: Request, res: Response, next: NextFunction) => {
    if (!ctx.roleIn(req.params.id, (req as AuthedRequest).userId)) { res.status(404).json({ error: 'server not found' }); return; }
    next();
  };
  const rawBody = express.raw({ type: '*/*', limit: vaultMaxBytes > 0 ? vaultMaxBytes : '1gb' });
  const readBody = (req: Request, res: Response, next: NextFunction) =>
    rawBody(req, res, (err?: unknown) => {
      if (err) {
        const status = (err as { status?: number }).status === 413 ? 413 : 400;
        res.status(status).json({ error: status === 413 ? `file too large (limit ${Math.round(vaultMaxBytes / MB)} MB)` : 'invalid body' });
        return;
      }
      next();
    });

  app.get('/api/servers/:id/vault', ctx.requireAuth, requireMember, (req, res) => {
    const before = Number(req.query.before);
    const rows = (Number.isFinite(before) && before > 0
      ? db.prepare('SELECT * FROM vault_items WHERE server_id=? AND created_at<? ORDER BY created_at DESC, id DESC LIMIT ?').all(req.params.id, before, PAGE + 1)
      : db.prepare('SELECT * FROM vault_items WHERE server_id=? ORDER BY created_at DESC, id DESC LIMIT ?').all(req.params.id, PAGE + 1)) as Row[];
    const { used } = usedFor.get((req as AuthedRequest).userId) as { used: number };
    res.json({ items: rows.slice(0, PAGE).map(toItem), hasMore: rows.length > PAGE, usedBytes: used, quotaBytes: vaultQuotaBytes, maxBytes: vaultMaxBytes });
  });

  app.post('/api/servers/:id/vault', ctx.requireAuth, requireMember, readBody, async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).userId;
      const serverId = req.params.id;
      const body: unknown = req.body;
      const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : '';
      const keyVersion = Number(req.query.keyVersion);
      const meta = typeof req.query.meta === 'string' ? req.query.meta : '';
      if (!Buffer.isBuffer(body) || body.length < 5) { res.status(400).json({ error: 'empty upload' }); return; }
      if (ctx.getChannel(channelId)?.serverId !== serverId) { res.status(400).json({ error: 'bad channel' }); return; }
      if (!Number.isInteger(keyVersion) || keyVersion < 1 || !meta || meta.length > 8000) { res.status(400).json({ error: 'bad details' }); return; }
      const thumbLen = body.readUInt32BE(0);
      if (thumbLen < 1 || thumbLen > THUMB_MAX_BYTES || 4 + thumbLen >= body.length) { res.status(400).json({ error: 'bad thumbnail' }); return; }
      const thumb = body.subarray(4, 4 + thumbLen);
      const file = body.subarray(4 + thumbLen);

      const row: Row = {
        id: newId(), server_id: serverId, owner_id: userId, channel_id: channelId, key_version: keyVersion,
        ciphertext: meta, size: file.length, thumb_size: thumb.length, created_at: Date.now(),
      };
      if (!reserve(row)) {
        const { used } = usedFor.get(userId) as { used: number };
        res.status(413).json({ error: `Vault space is full: you have ${Math.round(used / MB)} MB of ${Math.round(vaultQuotaBytes / MB)} MB used. Delete something or ask the server owner to raise VAULT_QUOTA_MB.` });
        return;
      }
      try {
        await fs.writeFile(filePath(row.id), file, { flag: 'wx', mode: 0o600 });
        await fs.writeFile(filePath(row.id, true), thumb, { flag: 'wx', mode: 0o600 });
      } catch (err) {
        // Give the space back so a failed write does not count against the person's quota.
        db.prepare('DELETE FROM vault_items WHERE id=?').run(row.id);
        await Promise.all([fs.rm(filePath(row.id), { force: true }), fs.rm(filePath(row.id, true), { force: true })]).catch(() => {});
        throw err;
      }
      const item = toItem(row);
      ctx.broadcastToServer(serverId, { t: 'vault.new', item });
      res.status(201).json({ item });
    } catch (err) {
      next(err);
    }
  });

  const send = (thumb: boolean) => (req: Request, res: Response) => {
    const row = byId(req.params.id);
    if (!row || !ctx.roleIn(row.server_id, (req as AuthedRequest).userId)) { res.status(404).json({ error: 'not found' }); return; }
    res.type('application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(filePath(row.id, thumb), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  };
  app.get('/api/vault/:id/thumb', ctx.requireAuth, send(true));
  app.get('/api/vault/:id/file', ctx.requireAuth, send(false));

  app.delete('/api/vault/:id', ctx.requireAuth, async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).userId;
      const row = byId(req.params.id);
      const role = row ? ctx.roleIn(row.server_id, userId) : null;
      if (!row || !role) { res.status(404).json({ error: 'not found' }); return; }
      if (row.owner_id !== userId && role !== 'owner' && role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return; }
      db.prepare('DELETE FROM vault_items WHERE id=?').run(row.id);
      await Promise.all([fs.rm(filePath(row.id), { force: true }), fs.rm(filePath(row.id, true), { force: true })])
        .catch((err) => console.error(`vault ${row.id} cleanup failed`, err));
      ctx.broadcastToServer(row.server_id, { t: 'vault.delete', serverId: row.server_id, itemId: row.id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}
