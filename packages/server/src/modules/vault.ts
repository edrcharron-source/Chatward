import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { VaultAnnotation, VaultItem } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';

const ITEM_ID = /^[0-9a-z]{1,40}$/;
const PAGE = 60;
const THUMB_MAX_BYTES = 512 * 1024;
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
const MB = 1024 * 1024;
/** Largest piece of a file sent in one request. The client sends the file in pieces of this size. */
export const VAULT_CHUNK_BYTES = 8 * MB;
/** The old one-request upload holds the whole body in memory, so it keeps its old ceiling. */
const LEGACY_MAX_BYTES = 200 * MB;
/** Unfinished uploads older than this are thrown away and their space given back. */
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
/** How many item ids one /items request may ask for. */
const ITEMS_MAX = 500;

type Part = 'file' | 'thumb' | 'prev';
const SUFFIX: Record<Part, string> = { file: '', thumb: '.thumb', prev: '.prev' };

type Row = {
  id: string; server_id: string; owner_id: string; channel_id: string; key_version: number;
  ciphertext: string; size: number; thumb_size: number; prev_size: number; created_at: number;
};
type UploadRow = {
  id: string; server_id: string; owner_id: string; channel_id: string; key_version: number; ciphertext: string;
  size: number; thumb_size: number; prev_size: number; received: number; created_at: number; updated_at: number;
};

/**
 * Where a Vault blob lives: two folder levels taken from the end of the id (its random part), so files spread
 * evenly over up to 65,536 folders instead of piling into one. `vault/<id>` was the layout before this, and is
 * still read until the startup move has finished.
 */
export function vaultBlobPath(vaultDir: string, id: string, part: Part = 'file'): string {
  const tail = id.slice(-4).padStart(4, '_');
  return path.join(vaultDir, tail.slice(0, 2), tail.slice(2, 4), id + SUFFIX[part]);
}
const flatPath = (vaultDir: string, id: string, part: Part) => path.join(vaultDir, id + SUFFIX[part]);

/** Moves blobs from the old flat layout into the sharded one. Safe to run again; a rename on one disk is instant. */
export async function migrateFlatVault(vaultDir: string): Promise<number> {
  let moved = 0;
  const names = await fs.readdir(vaultDir, { withFileTypes: true });
  for (const e of names) {
    if (!e.isFile()) continue;
    const m = /^([0-9a-z]{1,40})(\.thumb|\.prev)?$/.exec(e.name);
    if (!m) continue;
    const part: Part = m[2] === '.thumb' ? 'thumb' : m[2] === '.prev' ? 'prev' : 'file';
    const to = vaultBlobPath(vaultDir, m[1], part);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(path.join(vaultDir, e.name), to);
    moved++;
  }
  return moved;
}

/**
 * Shared photo and video gallery. Files, previews and thumbnails are encrypted on the client before upload; the server
 * only stores the opaque blobs plus a small descriptor sealed with a channel key, so it never sees names, types or contents.
 *
 * Uploads: POST /api/servers/:id/vault/uploads starts one. Its body is the 4-byte big-endian thumbnail length, the
 * thumbnail, the 4-byte preview length (0 for none), the preview, then the start of the file (all of it when small).
 * The rest of the file follows in PUT /api/vault/uploads/:uid?offset=N pieces, and the upload finishes by itself
 * once every byte is in. A dropped connection resumes from GET /api/vault/uploads/:uid.
 * The older one-request POST /api/servers/:id/vault still works for clients that have not updated.
 */
export function register(app: Express, ctx: Ctx): void {
  const { db } = ctx;
  const { vaultDir, vaultQuotaBytes, vaultMaxBytes } = ctx.config;
  const incomingDir = path.join(vaultDir, '.incoming');
  const incomingPath = (uploadId: string, part: Part) => path.join(incomingDir, `${uploadId}.${part}`);
  const maxFile = vaultMaxBytes > 0 ? vaultMaxBytes : Number.MAX_SAFE_INTEGER;
  const legacyMax = Math.min(maxFile, LEGACY_MAX_BYTES);

  /** Finds a blob in the sharded layout, or the old flat one while the move is still running. */
  const existingPath = async (id: string, part: Part): Promise<string | null> => {
    for (const p of [vaultBlobPath(vaultDir, id, part), flatPath(vaultDir, id, part)]) {
      try { await fs.access(p); return p; } catch { /* try the next layout */ }
    }
    return null;
  };
  const removeBlobs = (id: string) => Promise.all((['file', 'thumb', 'prev'] as Part[]).flatMap((part) =>
    [fs.rm(vaultBlobPath(vaultDir, id, part), { force: true }), fs.rm(flatPath(vaultDir, id, part), { force: true })]));
  const writeBlob = async (id: string, part: Part, data: Uint8Array) => {
    const to = vaultBlobPath(vaultDir, id, part);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, data, { flag: 'wx', mode: 0o600 });
  };

  const toItem = (r: Row): VaultItem => ({
    id: r.id, serverId: r.server_id, ownerId: r.owner_id, createdAt: r.created_at,
    size: r.size + r.thumb_size + (r.prev_size ?? 0), channelId: r.channel_id, keyVersion: r.key_version, ciphertext: r.ciphertext,
    ...(r.prev_size ? { hasPreview: true } : {}),
  });
  const byId = (id: string) => (ITEM_ID.test(id) ? db.prepare('SELECT * FROM vault_items WHERE id=?').get(id) as Row | undefined : undefined);
  // Space in use counts finished items and the full declared size of uploads still arriving.
  const usedStmt = db.prepare(`SELECT
      (SELECT COALESCE(SUM(size + thumb_size + prev_size), 0) FROM vault_items WHERE owner_id=?) +
      (SELECT COALESCE(SUM(size + thumb_size + prev_size), 0) FROM vault_uploads WHERE owner_id=?) AS used`);
  const usedBy = (userId: string) => (usedStmt.get(userId, userId) as { used: number }).used;
  const insertItem = db.prepare('INSERT INTO vault_items (id, server_id, owner_id, channel_id, key_version, ciphertext, size, thumb_size, prev_size, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const fits = (owner: string, bytes: number) => vaultQuotaBytes <= 0 || usedBy(owner) + bytes <= vaultQuotaBytes;
  // Checks the quota and records the row in one synchronous step, so simultaneous uploads cannot both squeeze under.
  const reserve = db.transaction((r: Row): boolean => {
    if (!fits(r.owner_id, r.size + r.thumb_size + r.prev_size)) return false;
    insertItem.run(r.id, r.server_id, r.owner_id, r.channel_id, r.key_version, r.ciphertext, r.size, r.thumb_size, r.prev_size, r.created_at);
    return true;
  });
  const reserveUpload = db.transaction((u: UploadRow): boolean => {
    if (!fits(u.owner_id, u.size + u.thumb_size + u.prev_size)) return false;
    db.prepare('INSERT INTO vault_uploads (id, server_id, owner_id, channel_id, key_version, ciphertext, size, thumb_size, prev_size, received, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(u.id, u.server_id, u.owner_id, u.channel_id, u.key_version, u.ciphertext, u.size, u.thumb_size, u.prev_size, u.received, u.created_at, u.updated_at);
    return true;
  });
  const fullMessage = (userId: string) =>
    `Vault space is full: you have ${Math.round(usedBy(userId) / MB)} MB of ${Math.round(vaultQuotaBytes / MB)} MB used. Delete something or ask the server owner to raise VAULT_QUOTA_MB.`;
  const tooBig = () => `file too large (limit ${Math.round(maxFile / MB)} MB)`;

  /** Throws away unfinished uploads that have sat untouched for a day, and their pieces on disk. */
  const sweepStale = async () => {
    const old = db.prepare('SELECT id FROM vault_uploads WHERE updated_at<?').all(Date.now() - STALE_UPLOAD_MS) as { id: string }[];
    for (const { id } of old) {
      db.prepare('DELETE FROM vault_uploads WHERE id=?').run(id);
      await Promise.all((['file', 'thumb', 'prev'] as Part[]).map((p) => fs.rm(incomingPath(id, p), { force: true })));
    }
  };
  void fs.mkdir(incomingDir, { recursive: true })
    .then(() => sweepStale())
    .then(() => migrateFlatVault(vaultDir))
    .then((n) => { if (n) console.log(`vault: moved ${n} files into the sharded layout`); })
    .catch((err) => console.error('vault: startup housekeeping failed', err));
  setInterval(() => void sweepStale().catch((err) => console.error('vault: sweep failed', err)), 60 * 60 * 1000).unref();

  const requireMember = (req: Request, res: Response, next: NextFunction) => {
    if (!ctx.roleIn(req.params.id, (req as AuthedRequest).userId)) { res.status(404).json({ error: 'server not found' }); return; }
    next();
  };
  const readRaw = (limit: number) => {
    const rawBody = express.raw({ type: '*/*', limit });
    return (req: Request, res: Response, next: NextFunction) =>
      rawBody(req, res, (err?: unknown) => {
        if (err) {
          const status = (err as { status?: number }).status === 413 ? 413 : 400;
          res.status(status).json({ error: status === 413 ? tooBig() : 'invalid body' });
          return;
        }
        next();
      });
  };
  /** Reads channelId, keyVersion and meta from the query; null after sending a 400. */
  const sealedDetails = (req: Request, res: Response, serverId: string) => {
    const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : '';
    const keyVersion = Number(req.query.keyVersion);
    const meta = typeof req.query.meta === 'string' ? req.query.meta : '';
    if (ctx.getChannel(channelId)?.serverId !== serverId) { res.status(400).json({ error: 'bad channel' }); return null; }
    if (!Number.isInteger(keyVersion) || keyVersion < 1 || !meta || meta.length > 8000) { res.status(400).json({ error: 'bad details' }); return null; }
    return { channelId, keyVersion, meta };
  };

  app.get('/api/servers/:id/vault', ctx.requireAuth, requireMember, (req, res) => {
    const before = Number(req.query.before);
    const rows = (Number.isFinite(before) && before > 0
      ? db.prepare('SELECT * FROM vault_items WHERE server_id=? AND created_at<? ORDER BY created_at DESC, id DESC LIMIT ?').all(req.params.id, before, PAGE + 1)
      : db.prepare('SELECT * FROM vault_items WHERE server_id=? ORDER BY created_at DESC, id DESC LIMIT ?').all(req.params.id, PAGE + 1)) as Row[];
    res.json({ items: rows.slice(0, PAGE).map(toItem), hasMore: rows.length > PAGE, usedBytes: usedBy((req as AuthedRequest).userId), quotaBytes: vaultQuotaBytes, maxBytes: vaultMaxBytes });
  });

  // Every item id in the server with its time, newest first: small enough to send whole, so albums and sorting can
  // see the entire Vault. The client fetches the sealed details of ids it has not cached through /vault/items.
  app.get('/api/servers/:id/vault/index', ctx.requireAuth, requireMember, (req, res) => {
    const rows = db.prepare('SELECT id, created_at FROM vault_items WHERE server_id=? ORDER BY created_at DESC, id DESC').all(req.params.id) as { id: string; created_at: number }[];
    res.json({
      ids: rows.map((r) => [r.id, r.created_at]),
      usedBytes: usedBy((req as AuthedRequest).userId), quotaBytes: vaultQuotaBytes, maxBytes: vaultMaxBytes, chunkBytes: VAULT_CHUNK_BYTES,
    });
  });

  app.post('/api/servers/:id/vault/items', ctx.requireAuth, requireMember, express.json({ limit: '64kb' }), (req, res) => {
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || ids.length > ITEMS_MAX || !ids.every((i) => typeof i === 'string' && ITEM_ID.test(i))) {
      res.status(400).json({ error: `send up to ${ITEMS_MAX} item ids` }); return;
    }
    if (!ids.length) { res.json({ items: [] }); return; }
    const rows = db.prepare(`SELECT * FROM vault_items WHERE server_id=? AND id IN (${ids.map(() => '?').join(',')})`).all(req.params.id, ...ids) as Row[];
    res.json({ items: rows.map(toItem) });
  });

  // The original one-request upload: 4-byte thumbnail length, the thumbnail, then the file. Kept for older clients.
  app.post('/api/servers/:id/vault', ctx.requireAuth, requireMember, readRaw(legacyMax), async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).userId;
      const serverId = req.params.id;
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length < 5) { res.status(400).json({ error: 'empty upload' }); return; }
      const sealed = sealedDetails(req, res, serverId);
      if (!sealed) return;
      const thumbLen = body.readUInt32BE(0);
      if (thumbLen < 1 || thumbLen > THUMB_MAX_BYTES || 4 + thumbLen >= body.length) { res.status(400).json({ error: 'bad thumbnail' }); return; }
      const thumb = body.subarray(4, 4 + thumbLen);
      const file = body.subarray(4 + thumbLen);

      const row: Row = {
        id: newId(), server_id: serverId, owner_id: userId, channel_id: sealed.channelId, key_version: sealed.keyVersion,
        ciphertext: sealed.meta, size: file.length, thumb_size: thumb.length, prev_size: 0, created_at: Date.now(),
      };
      if (!reserve(row)) { res.status(413).json({ error: fullMessage(userId) }); return; }
      try {
        await writeBlob(row.id, 'file', file);
        await writeBlob(row.id, 'thumb', thumb);
      } catch (err) {
        // Give the space back so a failed write does not count against the person's quota.
        db.prepare('DELETE FROM vault_items WHERE id=?').run(row.id);
        await removeBlobs(row.id).catch(() => {});
        throw err;
      }
      const item = toItem(row);
      ctx.broadcastToServer(serverId, { t: 'vault.new', item });
      res.status(201).json({ item });
    } catch (err) {
      next(err);
    }
  });

  // Uploads whose pieces are being written right now; a second request for the same one waits its turn.
  const busy = new Set<string>();

  /** Moves a fully received upload into place as a Vault item. */
  const finish = async (u: UploadRow): Promise<VaultItem> => {
    const row: Row = {
      id: newId(), server_id: u.server_id, owner_id: u.owner_id, channel_id: u.channel_id, key_version: u.key_version,
      ciphertext: u.ciphertext, size: u.size, thumb_size: u.thumb_size, prev_size: u.prev_size, created_at: Date.now(),
    };
    const parts: Part[] = u.prev_size ? ['file', 'thumb', 'prev'] : ['file', 'thumb'];
    try {
      for (const part of parts) {
        const to = vaultBlobPath(vaultDir, row.id, part);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(incomingPath(u.id, part), to);
      }
      // The space was reserved when the upload started, so this swaps the reservation for the item.
      db.transaction(() => {
        db.prepare('DELETE FROM vault_uploads WHERE id=?').run(u.id);
        insertItem.run(row.id, row.server_id, row.owner_id, row.channel_id, row.key_version, row.ciphertext, row.size, row.thumb_size, row.prev_size, row.created_at);
      })();
    } catch (err) {
      await removeBlobs(row.id).catch(() => {});
      throw err;
    }
    const item = toItem(row);
    ctx.broadcastToServer(row.server_id, { t: 'vault.new', item });
    return item;
  };

  const CREATE_MAX = 8 + THUMB_MAX_BYTES + PREVIEW_MAX_BYTES + VAULT_CHUNK_BYTES;
  app.post('/api/servers/:id/vault/uploads', ctx.requireAuth, requireMember, readRaw(CREATE_MAX), async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).userId;
      const serverId = req.params.id;
      const body: unknown = req.body;
      const sealed = sealedDetails(req, res, serverId);
      if (!sealed) return;
      const size = Number(req.query.size);
      if (!Number.isInteger(size) || size < 1) { res.status(400).json({ error: 'bad size' }); return; }
      if (size > maxFile) { res.status(413).json({ error: tooBig() }); return; }
      if (!Buffer.isBuffer(body) || body.length < 9) { res.status(400).json({ error: 'empty upload' }); return; }
      const thumbLen = body.readUInt32BE(0);
      if (thumbLen < 1 || thumbLen > THUMB_MAX_BYTES || 8 + thumbLen > body.length) { res.status(400).json({ error: 'bad thumbnail' }); return; }
      const prevLen = body.readUInt32BE(4 + thumbLen);
      const prevStart = 8 + thumbLen;
      if (prevLen > PREVIEW_MAX_BYTES || prevStart + prevLen > body.length) { res.status(400).json({ error: 'bad preview' }); return; }
      const head = body.subarray(prevStart + prevLen);
      if (head.length > size) { res.status(400).json({ error: 'more bytes than the declared size' }); return; }

      const now = Date.now();
      const u: UploadRow = {
        id: newId(), server_id: serverId, owner_id: userId, channel_id: sealed.channelId, key_version: sealed.keyVersion,
        ciphertext: sealed.meta, size, thumb_size: thumbLen, prev_size: prevLen, received: head.length, created_at: now, updated_at: now,
      };
      if (!reserveUpload(u)) { res.status(413).json({ error: fullMessage(userId) }); return; }
      try {
        await fs.mkdir(incomingDir, { recursive: true });
        await fs.writeFile(incomingPath(u.id, 'thumb'), body.subarray(4, 4 + thumbLen), { flag: 'wx', mode: 0o600 });
        if (prevLen) await fs.writeFile(incomingPath(u.id, 'prev'), body.subarray(prevStart, prevStart + prevLen), { flag: 'wx', mode: 0o600 });
        await fs.writeFile(incomingPath(u.id, 'file'), head, { flag: 'wx', mode: 0o600 });
      } catch (err) {
        db.prepare('DELETE FROM vault_uploads WHERE id=?').run(u.id);
        await Promise.all((['file', 'thumb', 'prev'] as Part[]).map((p) => fs.rm(incomingPath(u.id, p), { force: true }))).catch(() => {});
        throw err;
      }
      if (u.received === size) { res.status(201).json({ item: await finish(u) }); return; }
      res.status(202).json({ uploadId: u.id, received: u.received, size, chunkBytes: VAULT_CHUNK_BYTES });
    } catch (err) {
      next(err);
    }
  });

  const uploadFor = (req: Request): UploadRow | undefined => {
    const id = req.params.uid;
    if (!ITEM_ID.test(id)) return undefined;
    const u = db.prepare('SELECT * FROM vault_uploads WHERE id=?').get(id) as UploadRow | undefined;
    return u && u.owner_id === (req as AuthedRequest).userId && ctx.roleIn(u.server_id, u.owner_id) ? u : undefined;
  };

  app.get('/api/vault/uploads/:uid', ctx.requireAuth, (req, res) => {
    const u = uploadFor(req);
    if (!u) { res.status(404).json({ error: 'upload not found' }); return; }
    res.json({ uploadId: u.id, received: u.received, size: u.size, chunkBytes: VAULT_CHUNK_BYTES });
  });

  app.put('/api/vault/uploads/:uid', ctx.requireAuth, readRaw(VAULT_CHUNK_BYTES), async (req, res, next) => {
    const u = uploadFor(req);
    if (!u) { res.status(404).json({ error: 'upload not found' }); return; }
    if (busy.has(u.id)) { res.status(409).json({ error: 'another piece is still being written', received: u.received }); return; }
    busy.add(u.id);
    try {
      const body: unknown = req.body;
      const offset = Number(req.query.offset);
      if (!Buffer.isBuffer(body) || !body.length) { res.status(400).json({ error: 'empty piece' }); return; }
      // Pieces must arrive in order; the reply says where to carry on from.
      if (offset !== u.received) { res.status(409).json({ error: 'wrong offset', received: u.received }); return; }
      if (u.received + body.length > u.size) { res.status(400).json({ error: 'more bytes than the declared size', received: u.received }); return; }
      const fh = await fs.open(incomingPath(u.id, 'file'), 'r+');
      try { await fh.write(body, 0, body.length, offset); } finally { await fh.close(); }
      const received = u.received + body.length;
      db.prepare('UPDATE vault_uploads SET received=?, updated_at=? WHERE id=?').run(received, Date.now(), u.id);
      if (received === u.size) { res.status(201).json({ item: await finish({ ...u, received }) }); return; }
      res.json({ uploadId: u.id, received, size: u.size });
    } catch (err) {
      next(err);
    } finally {
      busy.delete(u.id);
    }
  });

  app.delete('/api/vault/uploads/:uid', ctx.requireAuth, async (req, res) => {
    const u = uploadFor(req);
    if (!u) { res.status(404).json({ error: 'upload not found' }); return; }
    db.prepare('DELETE FROM vault_uploads WHERE id=?').run(u.id);
    await Promise.all((['file', 'thumb', 'prev'] as Part[]).map((p) => fs.rm(incomingPath(u.id, p), { force: true }))).catch(() => {});
    res.json({ ok: true });
  });

  const send = (part: Part) => async (req: Request, res: Response) => {
    const row = byId(req.params.id);
    if (!row || !ctx.roleIn(row.server_id, (req as AuthedRequest).userId)) { res.status(404).json({ error: 'not found' }); return; }
    const file = await existingPath(row.id, part);
    if (!file) { res.status(404).json({ error: 'not found' }); return; }
    res.type('application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  };
  // The photo sorter's model file. Sorting happens on people's devices; the server only serves the file. Its hash is
  // worked out once, so clients can keep it cached under that name.
  let modelInfo: Promise<{ available: boolean; sha256?: string; bytes?: number }> | null = null;
  const sortModelInfo = () => (modelInfo ??= (async () => {
    try {
      const { size } = await fs.stat(ctx.config.vaultSortModel);
      const hash = createHash('sha256');
      await new Promise<void>((resolve, reject) => createReadStream(ctx.config.vaultSortModel).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject));
      return { available: true, sha256: hash.digest('hex'), bytes: size };
    } catch {
      modelInfo = null; // look again next time, in case the file is added later
      return { available: false };
    }
  })());
  app.get('/api/vault/sort-model/info', ctx.requireAuth, async (_req, res) => { res.json(await sortModelInfo()); });
  app.get('/api/vault/sort-model', ctx.requireAuth, async (_req, res) => {
    const info = await sortModelInfo();
    if (!info.available) { res.status(404).json({ error: 'no sorter model on this server' }); return; }
    res.type('application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=604800');
    res.sendFile(ctx.config.vaultSortModel, (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'not found' }); });
  });
  app.get('/api/vault/:id/thumb', ctx.requireAuth, send('thumb'));
  app.get('/api/vault/:id/preview', ctx.requireAuth, send('prev'));
  app.get('/api/vault/:id/file', ctx.requireAuth, send('file'));

  type NoteRow = { item_id: string; author_id: string; server_id: string; channel_id: string; key_version: number; ciphertext: string; updated_at: number };
  const toNote = (n: NoteRow): VaultAnnotation => ({
    itemId: n.item_id, authorId: n.author_id, serverId: n.server_id, channelId: n.channel_id,
    keyVersion: n.key_version, ciphertext: n.ciphertext, updatedAt: n.updated_at,
  });

  // Everyone's sealed tags for the server in one go; the client merges and decrypts them.
  app.get('/api/servers/:id/vault/annotations', ctx.requireAuth, requireMember, (req, res) => {
    const rows = db.prepare('SELECT a.*, i.channel_id FROM vault_annotations a JOIN vault_items i ON i.id=a.item_id WHERE a.server_id=?').all(req.params.id) as NoteRow[];
    res.json({ annotations: rows.map(toNote) });
  });

  // Each person has one sealed set of tags per item, so people never overwrite each other.
  app.post('/api/vault/:id/annotation', ctx.requireAuth, express.json({ limit: '32kb' }), (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const row = byId(req.params.id);
    if (!row || !ctx.roleIn(row.server_id, userId)) { res.status(404).json({ error: 'not found' }); return; }
    const { keyVersion, ciphertext } = (req.body ?? {}) as { keyVersion?: unknown; ciphertext?: unknown };
    if (!Number.isInteger(keyVersion) || (keyVersion as number) < 1 || typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > 16000) {
      res.status(400).json({ error: 'bad details' }); return;
    }
    const at = Date.now();
    db.prepare(`INSERT INTO vault_annotations (item_id, author_id, server_id, key_version, ciphertext, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(item_id, author_id) DO UPDATE SET key_version=excluded.key_version, ciphertext=excluded.ciphertext, updated_at=excluded.updated_at`)
      .run(row.id, userId, row.server_id, keyVersion, ciphertext, at);
    const annotation = toNote({ item_id: row.id, author_id: userId, server_id: row.server_id, channel_id: row.channel_id, key_version: keyVersion as number, ciphertext, updated_at: at });
    ctx.broadcastToServer(row.server_id, { t: 'vault.annotation', annotation });
    res.json({ annotation });
  });

  // Removes your own tags; owners and admins can clear anyone's with ?author=<id>.
  app.delete('/api/vault/:id/annotation', ctx.requireAuth, (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const row = byId(req.params.id);
    const role = row ? ctx.roleIn(row.server_id, userId) : null;
    if (!row || !role) { res.status(404).json({ error: 'not found' }); return; }
    const author = typeof req.query.author === 'string' && req.query.author ? req.query.author : userId;
    if (author !== userId && role !== 'owner' && role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return; }
    db.prepare('DELETE FROM vault_annotations WHERE item_id=? AND author_id=?').run(row.id, author);
    ctx.broadcastToServer(row.server_id, { t: 'vault.annotation.delete', serverId: row.server_id, itemId: row.id, authorId: author });
    res.json({ ok: true });
  });

  app.delete('/api/vault/:id', ctx.requireAuth, async (req, res, next) => {
    try {
      const userId = (req as AuthedRequest).userId;
      const row = byId(req.params.id);
      const role = row ? ctx.roleIn(row.server_id, userId) : null;
      if (!row || !role) { res.status(404).json({ error: 'not found' }); return; }
      if (row.owner_id !== userId && role !== 'owner' && role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return; }
      db.prepare('DELETE FROM vault_items WHERE id=?').run(row.id);
      await removeBlobs(row.id).catch((err) => console.error(`vault ${row.id} cleanup failed`, err));
      ctx.broadcastToServer(row.server_id, { t: 'vault.delete', serverId: row.server_id, itemId: row.id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}
