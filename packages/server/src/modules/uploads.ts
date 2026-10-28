import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { LIMITS } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';

const UPLOAD_ID = /^[0-9a-z]{1,40}$/;

// Binary route only: the global parser is JSON with a small limit.
const rawBody = express.raw({ type: '*/*', limit: LIMITS.UPLOAD_MAX_BYTES });

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

  const insertUpload = db.prepare('INSERT INTO uploads (id, owner_id, size, created_at) VALUES (?,?,?,?)');
  const findUpload = db.prepare('SELECT owner_id FROM uploads WHERE id=?');
  // Two users may fetch an upload if they share at least one server.
  const sharesServer = db.prepare(
    'SELECT 1 FROM members a JOIN members b ON b.server_id=a.server_id WHERE a.user_id=? AND b.user_id=? LIMIT 1');

  const filePathFor = (id: string) => path.join(ctx.config.uploadsDir, id);

  app.post('/api/uploads', ctx.requireAuth, readRawBody, async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).userId;
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'empty upload' });
        return;
      }
      const id = newId();
      await fs.writeFile(filePathFor(id), body, { flag: 'wx', mode: 0o600 });
      insertUpload.run(id, userId, body.length, Date.now());
      res.status(201).json({ uploadId: id });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/uploads/:id', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const id = req.params.id;
    const row = UPLOAD_ID.test(id) ? (findUpload.get(id) as { owner_id: string } | undefined) : undefined;
    const allowed = row && (row.owner_id === userId || sharesServer.get(userId, row.owner_id));
    if (!row || !allowed) { res.status(404).json({ error: 'not found' }); return; }

    res.type('application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Ids are never reused, so a missing file here means the blob was removed out of band.
    res.sendFile(filePathFor(id), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });
}
