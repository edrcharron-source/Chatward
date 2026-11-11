import express, { type Express, type Request, type Response } from 'express';
import type { VaultAlbum } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';

const ID = /^[0-9a-z]{1,40}$/;
/** Most item ids one request may add or remove. */
const ITEMS_PER_CALL = 500;
const ALBUMS_PER_SERVER = 500;

type AlbumRow = {
  id: string; server_id: string; owner_id: string; channel_id: string; key_version: number; sealed_by: string;
  ciphertext: string; cover_item_id: string | null; created_at: number; updated_at: number;
};

/**
 * Albums people make by hand in the Vault. The name is sealed with a channel key on the client, like Vault descriptors,
 * so the server only learns which item ids sit together. Any member can make an album and add to any album; the
 * album's maker, owners and admins can rename or delete it, and anyone can take out what they added.
 */
export function register(app: Express, ctx: Ctx): void {
  const { db } = ctx;

  const itemIdsOf = db.prepare('SELECT item_id FROM vault_album_items WHERE album_id=? ORDER BY added_at, item_id');
  const toAlbum = (r: AlbumRow): VaultAlbum => ({
    id: r.id, serverId: r.server_id, ownerId: r.owner_id, channelId: r.channel_id, keyVersion: r.key_version,
    sealedBy: r.sealed_by, ciphertext: r.ciphertext, coverItemId: r.cover_item_id, createdAt: r.created_at, updatedAt: r.updated_at,
    itemIds: (itemIdsOf.all(r.id) as { item_id: string }[]).map((x) => x.item_id),
  });
  const albumById = (id: string) => (ID.test(id) ? db.prepare('SELECT * FROM vault_albums WHERE id=?').get(id) as AlbumRow | undefined : undefined);
  const userOf = (req: Request) => (req as AuthedRequest).userId;
  const publish = (id: string) => {
    const row = albumById(id);
    if (!row) return null;
    const album = toAlbum(row);
    ctx.broadcastToServer(row.server_id, { t: 'vault.album', album });
    return album;
  };

  /** The album and the caller's role in its server; sends a 404 and returns null when either is missing. */
  const albumFor = (req: Request, res: Response) => {
    const row = albumById(req.params.aid);
    const role = row ? ctx.roleIn(row.server_id, userOf(req)) : null;
    if (!row || !role) { res.status(404).json({ error: 'album not found' }); return null; }
    return { row, role, canManage: row.owner_id === userOf(req) || role === 'owner' || role === 'admin' };
  };

  /** Checks a sealed name: the channel belongs to the server and the details look sane. */
  const sealed = (body: unknown, serverId: string): { channelId: string; keyVersion: number; ciphertext: string } | string => {
    const { channelId, keyVersion, ciphertext } = (body ?? {}) as { channelId?: unknown; keyVersion?: unknown; ciphertext?: unknown };
    if (typeof channelId !== 'string' || ctx.getChannel(channelId)?.serverId !== serverId) return 'bad channel';
    if (!Number.isInteger(keyVersion) || (keyVersion as number) < 1 || typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > 8000) return 'bad details';
    return { channelId, keyVersion: keyVersion as number, ciphertext };
  };

  /** Keeps only well-formed ids of items in this server. */
  const itemsInServer = (ids: unknown, serverId: string): string[] | null => {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > ITEMS_PER_CALL || !ids.every((i) => typeof i === 'string' && ID.test(i))) return null;
    if (!ids.length) return [];
    const rows = db.prepare(`SELECT id FROM vault_items WHERE server_id=? AND id IN (${ids.map(() => '?').join(',')})`).all(serverId, ...ids) as { id: string }[];
    const found = new Set(rows.map((r) => r.id));
    return [...new Set(ids as string[])].filter((i) => found.has(i));
  };
  const addItems = db.prepare('INSERT OR IGNORE INTO vault_album_items (album_id, item_id, added_by, added_at) VALUES (?,?,?,?)');

  app.get('/api/servers/:id/vault/albums', ctx.requireAuth, (req, res) => {
    if (!ctx.roleIn(req.params.id, userOf(req))) { res.status(404).json({ error: 'server not found' }); return; }
    const rows = db.prepare('SELECT * FROM vault_albums WHERE server_id=? ORDER BY created_at DESC, id DESC').all(req.params.id) as AlbumRow[];
    res.json({ albums: rows.map(toAlbum) });
  });

  app.post('/api/servers/:id/vault/albums', ctx.requireAuth, express.json({ limit: '64kb' }), (req, res) => {
    const userId = userOf(req);
    const serverId = req.params.id;
    if (!ctx.roleIn(serverId, userId)) { res.status(404).json({ error: 'server not found' }); return; }
    const s = sealed(req.body, serverId);
    if (typeof s === 'string') { res.status(400).json({ error: s }); return; }
    const items = itemsInServer((req.body as { itemIds?: unknown }).itemIds, serverId);
    if (!items) { res.status(400).json({ error: `send up to ${ITEMS_PER_CALL} item ids` }); return; }
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM vault_albums WHERE server_id=?').get(serverId) as { n: number };
    if (n >= ALBUMS_PER_SERVER) { res.status(409).json({ error: `This server already has ${ALBUMS_PER_SERVER} albums.` }); return; }
    const id = newId();
    const now = Date.now();
    db.transaction(() => {
      db.prepare('INSERT INTO vault_albums (id, server_id, owner_id, channel_id, key_version, sealed_by, ciphertext, cover_item_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, serverId, userId, s.channelId, s.keyVersion, userId, s.ciphertext, items[0] ?? null, now, now);
      items.forEach((itemId, i) => addItems.run(id, itemId, userId, now + i));
    })();
    res.status(201).json({ album: publish(id) });
  });

  // Rename (a new sealed name) or pick a cover. Only the album's maker, owners and admins.
  app.patch('/api/vault/albums/:aid', ctx.requireAuth, express.json({ limit: '32kb' }), (req, res) => {
    const a = albumFor(req, res);
    if (!a) return;
    if (!a.canManage) { res.status(403).json({ error: 'only the person who made the album, or an admin, can change it' }); return; }
    const body = (req.body ?? {}) as { ciphertext?: unknown; coverItemId?: unknown };
    const now = Date.now();
    if (body.ciphertext !== undefined) {
      const s = sealed(req.body, a.row.server_id);
      if (typeof s === 'string') { res.status(400).json({ error: s }); return; }
      db.prepare('UPDATE vault_albums SET channel_id=?, key_version=?, sealed_by=?, ciphertext=?, updated_at=? WHERE id=?')
        .run(s.channelId, s.keyVersion, userOf(req), s.ciphertext, now, a.row.id);
    }
    if (body.coverItemId !== undefined) {
      const cover = body.coverItemId === null ? null : typeof body.coverItemId === 'string' ? body.coverItemId : undefined;
      const inAlbum = cover && db.prepare('SELECT 1 FROM vault_album_items WHERE album_id=? AND item_id=?').get(a.row.id, cover);
      if (cover === undefined || (cover !== null && !inAlbum)) { res.status(400).json({ error: 'the cover must be in the album' }); return; }
      db.prepare('UPDATE vault_albums SET cover_item_id=?, updated_at=? WHERE id=?').run(cover, now, a.row.id);
    }
    res.json({ album: publish(a.row.id) });
  });

  // Add or take out items. Anyone in the server can add; taking out is for whoever added it, the album's maker and admins.
  app.post('/api/vault/albums/:aid/items', ctx.requireAuth, express.json({ limit: '64kb' }), (req, res) => {
    const a = albumFor(req, res);
    if (!a) return;
    const userId = userOf(req);
    const { add, remove } = (req.body ?? {}) as { add?: unknown; remove?: unknown };
    const toAdd = itemsInServer(add, a.row.server_id);
    const toRemove = remove === undefined ? [] : Array.isArray(remove) && remove.length <= ITEMS_PER_CALL && remove.every((i) => typeof i === 'string' && ID.test(i)) ? remove as string[] : null;
    if (!toAdd || !toRemove) { res.status(400).json({ error: `send up to ${ITEMS_PER_CALL} item ids` }); return; }
    if (!a.canManage && toRemove.length) {
      const others = toRemove.filter((itemId) => {
        const r = db.prepare('SELECT added_by FROM vault_album_items WHERE album_id=? AND item_id=?').get(a.row.id, itemId) as { added_by: string } | undefined;
        return r && r.added_by !== userId;
      });
      if (others.length) { res.status(403).json({ error: 'you can only take out photos you added' }); return; }
    }
    const now = Date.now();
    db.transaction(() => {
      toAdd.forEach((itemId, i) => addItems.run(a.row.id, itemId, userId, now + i));
      for (const itemId of toRemove) db.prepare('DELETE FROM vault_album_items WHERE album_id=? AND item_id=?').run(a.row.id, itemId);
      // An album without a cover takes its first photo; a removed cover is replaced the same way.
      const cover = db.prepare('SELECT cover_item_id AS c FROM vault_albums WHERE id=?').get(a.row.id) as { c: string | null };
      const stillThere = cover.c && db.prepare('SELECT 1 FROM vault_album_items WHERE album_id=? AND item_id=?').get(a.row.id, cover.c);
      if (!stillThere) {
        const first = db.prepare('SELECT item_id FROM vault_album_items WHERE album_id=? ORDER BY added_at, item_id LIMIT 1').get(a.row.id) as { item_id: string } | undefined;
        db.prepare('UPDATE vault_albums SET cover_item_id=? WHERE id=?').run(first?.item_id ?? null, a.row.id);
      }
      db.prepare('UPDATE vault_albums SET updated_at=? WHERE id=?').run(now, a.row.id);
    })();
    res.json({ album: publish(a.row.id) });
  });

  // Deleting an album never deletes its photos.
  app.delete('/api/vault/albums/:aid', ctx.requireAuth, (req, res) => {
    const a = albumFor(req, res);
    if (!a) return;
    if (!a.canManage) { res.status(403).json({ error: 'only the person who made the album, or an admin, can delete it' }); return; }
    db.prepare('DELETE FROM vault_albums WHERE id=?').run(a.row.id);
    ctx.broadcastToServer(a.row.server_id, { t: 'vault.album.delete', serverId: a.row.server_id, albumId: a.row.id });
    res.json({ ok: true });
  });
}
