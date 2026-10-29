import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { LIMITS, type LibraryGif } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';

const GIFS_PER_SERVER = 1000;
const GIF_ID = /^[0-9a-z]{1,40}$/;
const MB = 1024 * 1024;

type GifRow = {
  id: string;
  server_id: string;
  owner_id: string;
  name: string;
  tags: string;
  width: number;
  height: number;
  size: number;
  uses: number;
  created_at: number;
};

/** Width and height from a GIF's logical screen descriptor, or null when the bytes are not a GIF. */
export function gifSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 13) return null;
  const sig = b.subarray(0, 6).toString('ascii');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Trims and checks a GIF name. Returns null when it is empty or too long. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim().replace(/\s+/g, ' ');
  return name && name.length <= LIMITS.LIBRARY_GIF_NAME_MAX ? name : null;
}

/** Tags arrive as a comma-separated string or a list. Lowercased, de-duplicated, empty ones dropped. */
export function cleanTags(v: unknown): string[] | null {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : v == null ? [] : null;
  if (!parts) return null;
  const tags: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') return null;
    const tag = p.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!tag) continue;
    if (tag.length > LIMITS.LIBRARY_GIF_TAG_MAX || tag.includes(',')) return null;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags.length <= LIMITS.LIBRARY_GIF_TAGS_MAX ? tags : null;
}

export const libraryGifsDirOf = (dataDir: string) => path.join(dataDir, 'library-gifs');

/**
 * A server's shared GIF library. Like soundboard sounds, the files are stored as plain GIFs so the server
 * can hand them to every member; they count toward the uploader's upload quota.
 */
export function register(app: Express, ctx: Ctx): void {
  const gifsDir = libraryGifsDirOf(ctx.config.dataDir);
  fs.mkdirSync(gifsDir, { recursive: true });
  const filePath = (id: string) => path.join(gifsDir, id);
  const { db } = ctx;
  const { uploadQuotaBytes } = ctx.config;

  const toGif = (r: GifRow): LibraryGif => ({
    id: r.id,
    serverId: r.server_id,
    ownerId: r.owner_id,
    name: r.name,
    tags: r.tags ? r.tags.split(',') : [],
    width: r.width,
    height: r.height,
    size: r.size,
    uses: r.uses,
    createdAt: r.created_at,
  });
  const gifById = (id: string) =>
    GIF_ID.test(id) ? (db.prepare('SELECT * FROM library_gifs WHERE id=?').get(id) as GifRow | undefined) : undefined;
  // Library GIFs share the per-person upload quota with chat attachments.
  const usedBytesFor = db.prepare(`SELECT
    (SELECT COALESCE(SUM(size), 0) FROM uploads WHERE owner_id=?) +
    (SELECT COALESCE(SUM(size), 0) FROM library_gifs WHERE owner_id=?) AS used`);
  const usedBy = (userId: string) => (usedBytesFor.get(userId, userId) as { used: number }).used;

  // Count, quota check and insert in one transaction so two uploads at once cannot both slip under a limit.
  const insertIfRoom = db.transaction((r: GifRow): 'ok' | 'full' | 'quota' => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM library_gifs WHERE server_id=?').get(r.server_id) as { n: number };
    if (n >= GIFS_PER_SERVER) return 'full';
    if (uploadQuotaBytes > 0 && usedBy(r.owner_id) + r.size > uploadQuotaBytes) return 'quota';
    db.prepare('INSERT INTO library_gifs (id, server_id, owner_id, name, tags, width, height, size, uses, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(r.id, r.server_id, r.owner_id, r.name, r.tags, r.width, r.height, r.size, r.uses, r.created_at);
    return 'ok';
  });

  const requireMember = (req: Request, res: Response, next: NextFunction) => {
    if (!ctx.roleIn(req.params.id, (req as AuthedRequest).userId)) { res.status(404).json({ error: 'server not found' }); return; }
    next();
  };
  /** The GIF plus whether this user may rename or delete it: whoever added it, or a server owner or admin. */
  const findEditable = (req: Request, res: Response): GifRow | null => {
    const userId = (req as AuthedRequest).userId;
    const row = gifById(req.params.id);
    const role = row ? ctx.roleIn(row.server_id, userId) : null;
    if (!row || !role) { res.status(404).json({ error: 'GIF not found' }); return null; }
    if (row.owner_id !== userId && role !== 'owner' && role !== 'admin') { res.status(403).json({ error: 'Only the person who added this GIF or an admin can change it.' }); return null; }
    return row;
  };

  const gifBody = express.raw({ type: '*/*', limit: LIMITS.LIBRARY_GIF_MAX_BYTES });
  const readGif = (req: Request, res: Response, next: NextFunction) =>
    gifBody(req, res, (err?: unknown) => {
      if (err) {
        const status = (err as { status?: number }).status === 413 ? 413 : 400;
        res.status(status).json({ error: status === 413 ? `GIFs must be ${LIMITS.LIBRARY_GIF_MAX_BYTES / MB} MB or smaller.` : 'invalid body' });
        return;
      }
      next();
    });

  app.get('/api/servers/:id/library-gifs', ctx.requireAuth, requireMember, (req, res) => {
    const rows = db.prepare('SELECT * FROM library_gifs WHERE server_id=? ORDER BY created_at DESC, id DESC').all(req.params.id) as GifRow[];
    res.json({ gifs: rows.map(toGif) });
  });

  app.post('/api/servers/:id/library-gifs', ctx.requireAuth, requireMember, readGif, async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).userId;
      const serverId = req.params.id;
      const body: unknown = req.body;
      const name = cleanName(req.query.name);
      const tags = cleanTags(req.query.tags);
      if (!name) { res.status(400).json({ error: `Give the GIF a name (up to ${LIMITS.LIBRARY_GIF_NAME_MAX} characters).` }); return; }
      if (!tags) { res.status(400).json({ error: `Up to ${LIMITS.LIBRARY_GIF_TAGS_MAX} tags, each up to ${LIMITS.LIBRARY_GIF_TAG_MAX} characters.` }); return; }
      const dims = Buffer.isBuffer(body) ? gifSize(body) : null;
      if (!Buffer.isBuffer(body) || !dims) { res.status(400).json({ error: "That file isn't a GIF." }); return; }

      const row: GifRow = {
        id: newId(), server_id: serverId, owner_id: userId, name, tags: tags.join(','),
        width: dims.width, height: dims.height, size: body.length, uses: 0, created_at: Date.now(),
      };
      const added = insertIfRoom(row);
      if (added === 'full') { res.status(409).json({ error: `The GIF library is full (${GIFS_PER_SERVER} GIFs). Delete some first.` }); return; }
      if (added === 'quota') {
        res.status(413).json({
          error: `Upload space is full: you have ${Math.round(usedBy(userId) / MB)} MB of ${Math.round(uploadQuotaBytes / MB)} MB used on this server. ` +
            'Delete some of your GIFs or ask the server owner to raise UPLOAD_QUOTA_MB.',
        });
        return;
      }
      try {
        await fs.promises.writeFile(filePath(row.id), body, { flag: 'wx', mode: 0o600 });
      } catch (err) {
        // Give the space back so a failed write does not count against the person's quota.
        db.prepare('DELETE FROM library_gifs WHERE id=?').run(row.id);
        throw err;
      }
      const gif = toGif(row);
      ctx.broadcastToServer(serverId, { t: 'gif.new', gif });
      res.status(201).json({ gif });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/library-gifs/:id', ctx.requireAuth, (req, res) => {
    const row = findEditable(req, res);
    if (!row) return;
    const body = (req.body ?? {}) as { name?: unknown; tags?: unknown };
    const name = body.name === undefined ? row.name : cleanName(body.name);
    const tags = body.tags === undefined ? (row.tags ? row.tags.split(',') : []) : cleanTags(body.tags);
    if (!name) { res.status(400).json({ error: `Give the GIF a name (up to ${LIMITS.LIBRARY_GIF_NAME_MAX} characters).` }); return; }
    if (!tags) { res.status(400).json({ error: `Up to ${LIMITS.LIBRARY_GIF_TAGS_MAX} tags, each up to ${LIMITS.LIBRARY_GIF_TAG_MAX} characters.` }); return; }
    db.prepare('UPDATE library_gifs SET name=?, tags=? WHERE id=?').run(name, tags.join(','), row.id);
    const gif = toGif({ ...row, name, tags: tags.join(',') });
    ctx.broadcastToServer(row.server_id, { t: 'gif.update', gif });
    res.json({ gif });
  });

  app.delete('/api/library-gifs/:id', ctx.requireAuth, async (req, res, next) => {
    try {
      const row = findEditable(req, res);
      if (!row) return;
      db.prepare('DELETE FROM library_gifs WHERE id=?').run(row.id);
      await fs.promises.rm(filePath(row.id), { force: true }).catch((err) => console.error(`library gif ${row.id} cleanup failed`, err));
      ctx.broadcastToServer(row.server_id, { t: 'gif.delete', serverId: row.server_id, gifId: row.id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Counts a pick for the "Most used" sort. Not broadcast: the order refreshes the next time the tab loads.
  app.post('/api/library-gifs/:id/use', ctx.requireAuth, (req, res) => {
    const row = gifById(req.params.id);
    if (!row || !ctx.roleIn(row.server_id, (req as AuthedRequest).userId)) { res.status(404).json({ error: 'GIF not found' }); return; }
    db.prepare('UPDATE library_gifs SET uses=uses+1 WHERE id=?').run(row.id);
    res.json({ ok: true });
  });

  app.get('/api/library-gifs/:id/file', ctx.requireAuth, (req, res) => {
    const row = gifById(req.params.id);
    if (!row || !ctx.roleIn(row.server_id, (req as AuthedRequest).userId)) { res.status(404).json({ error: 'GIF not found' }); return; }
    res.type('image/gif');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath(row.id), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'GIF not found' });
    });
  });
}
