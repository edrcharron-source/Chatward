import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { LIMITS } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';

const UPLOAD_ID = /^[0-9a-z]{1,40}$/;
// An upload nobody attached to a message within this window is treated as abandoned.
const UNATTACHED_GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Binary route only: the global parser is JSON with a small limit.
const rawBody = express.raw({ type: '*/*', limit: LIMITS.UPLOAD_MAX_BYTES });

const MB = 1024 * 1024;
/** The message people see when their upload space is used up. Plain words, and it says who can change it. */
const storageFullMessage = (usedBytes: number, quotaBytes: number) =>
  `Upload space is full: you have ${Math.round(usedBytes / MB)} MB of ${Math.round(quotaBytes / MB)} MB used on this server. ` +
  'Ask the server owner to free up space or raise UPLOAD_QUOTA_MB.';

/** Wraps express.raw so an oversized body answers 413 instead of reaching the 500 handler. */
const readRawBody = (req: Request, res: Response, next: NextFunction) =>
  rawBody(req, res, (err?: unknown) => {
    if (err) {
      const status = (err as { status?: number }).status ?? 400;
      res.status(status).json({ error: status === 413 ? 'file too large' : 'invalid body' });
      return;
    }
    next();
  });

export function register(app: Express, ctx: Ctx): void {
  const { db } = ctx;

  const insertUpload = db.prepare('INSERT INTO uploads (id, owner_id, size, created_at, tracked) VALUES (?,?,?,?,?)');
  const deleteUpload = db.prepare('DELETE FROM uploads WHERE id=?');
  const usedBytesFor = db.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM uploads WHERE owner_id=?');
  const { uploadQuotaBytes } = ctx.config;
  // Checks the quota and records the upload in one synchronous step, so two uploads from the same person
  // arriving together cannot both squeeze under the limit. Returns false when the upload would go over.
  const reserveUpload = db.transaction((id: string, userId: string, size: number, tracked: number): boolean => {
    const { used } = usedBytesFor.get(userId) as { used: number };
    if (uploadQuotaBytes > 0 && used + size > uploadQuotaBytes) return false;
    insertUpload.run(id, userId, size, Date.now(), tracked);
    return true;
  });
  // The server an upload belongs to is the one its message was posted in. Unattached uploads have none.
  const findUpload = db.prepare(`
    SELECT u.owner_id, u.tracked, c.server_id FROM uploads u
    LEFT JOIN messages m ON m.id=u.message_id
    LEFT JOIN channels c ON c.id=m.channel_id
    WHERE u.id=?`);
  // Older uploads (tracked=0) have no message to check, so they fall back to: the two users share a server.
  const sharesServer = db.prepare(
    'SELECT 1 FROM members a JOIN members b ON b.server_id=a.server_id WHERE a.user_id=? AND b.user_id=? LIMIT 1');

  const filePathFor = (id: string) => path.join(ctx.config.uploadsDir, id);

  // One atomic statement: a row is only removed while it still matches, so a message attaching it
  // at the same moment cannot lose its file. Returns the ids so their files can be removed after.
  const sweepAbandoned = db.prepare(`
    DELETE FROM uploads
    WHERE tracked=1 AND (
      (message_id IS NULL AND created_at < ?)
      OR (message_id IS NOT NULL AND message_id NOT IN (SELECT id FROM messages)))
    RETURNING id`);

  const sweep = async () => {
    const removed = sweepAbandoned.all(Date.now() - UNATTACHED_GRACE_MS) as { id: string }[];
    for (const { id } of removed) {
      await fs.rm(filePathFor(id), { force: true }).catch((err) => console.error(`upload ${id} cleanup failed`, err));
    }
  };
  void sweep().catch((err) => console.error('upload cleanup failed', err));
  setInterval(() => {
    sweep().catch((err) => console.error('upload cleanup failed', err));
  }, SWEEP_INTERVAL_MS).unref();

  // Clients send `?tracked=1` when they will report the upload's message through `attachmentIds`.
  app.post('/api/uploads', ctx.requireAuth, readRawBody, async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).userId;
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'empty upload' });
        return;
      }
      const id = newId();
      const tracked = req.query.tracked === '1' ? 1 : 0;
      if (!reserveUpload(id, userId, body.length, tracked)) {
        const { used } = usedBytesFor.get(userId) as { used: number };
        res.status(413).json({ error: storageFullMessage(used, uploadQuotaBytes) });
        return;
      }
      try {
        await fs.writeFile(filePathFor(id), body, { flag: 'wx', mode: 0o600 });
      } catch (err) {
        // Give the space back so a failed write does not count against the person's quota.
        deleteUpload.run(id);
        throw err;
      }
      res.status(201).json({ uploadId: id });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/uploads/:id', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const id = req.params.id;
    const row = UPLOAD_ID.test(id)
      ? (findUpload.get(id) as { owner_id: string; tracked: number; server_id: string | null } | undefined)
      : undefined;
    // The uploader can always fetch. A tracked upload needs membership of the server its message was posted in.
    // An untracked one has no message to check, so sharing any server with the uploader is enough.
    const allowed = row && (row.owner_id === userId
      || (row.tracked === 1
        ? row.server_id !== null && ctx.roleIn(row.server_id, userId) !== null
        : sharesServer.get(userId, row.owner_id) !== undefined));
    if (!row || !allowed) { res.status(404).json({ error: 'not found' }); return; }

    res.type('application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Ids are never reused, so a missing file here means the blob was removed out of band.
    res.sendFile(filePathFor(id), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });
}
