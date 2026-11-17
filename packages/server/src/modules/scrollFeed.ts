import express, { type Express, type Request, type Response } from 'express';
import type { ScrollComment, ScrollSocial } from '@chatward/shared';
import type { AuthedRequest, Ctx } from '../ctx.js';
import { newId } from '../db.js';

const ID = /^[0-9a-z]{1,40}$/;
const TEXT_MAX = 500;
const GIF_URL_MAX = 2000;
const COMMENTS_PER_ITEM = 200;
const GIF_PROVIDERS = ['klipy', 'tenor', 'library'];

type CommentRow = { id: string; item_id: string; server_id?: string; author_id: string; text: string; gif: string | null; created_at: number };

/**
 * The Scroll feed's likes and comments on Vault items. Anyone in the server can like an item (once) and comment on it;
 * a comment can carry a GIF from the GIF integration. Text is stored as the client sends it, like Vault names that are
 * not sealed; the feed is for fun, not a place for secrets. The author, the server's owner and its admins can delete a
 * comment.
 */
export function register(app: Express, ctx: Ctx): void {
  const { db } = ctx;

  type ItemRow = { id: string; server_id: string };
  const itemOf = (id: string) => (ID.test(id) ? db.prepare('SELECT id, server_id FROM vault_items WHERE id=?').get(id) as ItemRow | undefined : undefined);
  const userOf = (req: Request) => (req as AuthedRequest).userId;

  /** The item and the caller's role in its server; sends a 404 and returns null when either is missing. */
  const itemFor = (req: Request, res: Response): { item: ItemRow; role: 'owner' | 'admin' | 'member' } | null => {
    const item = itemOf(req.params.id);
    const role = item ? ctx.roleIn(item.server_id, userOf(req)) : null;
    if (!item || !role) { res.status(404).json({ error: 'item not found' }); return null; }
    return { item, role };
  };

  const likeCount = db.prepare('SELECT COUNT(*) AS n FROM vault_likes WHERE item_id=?');
  const likedByMe = db.prepare('SELECT 1 FROM vault_likes WHERE item_id=? AND user_id=?');
  const commentCount = db.prepare('SELECT COUNT(*) AS n FROM vault_comments WHERE item_id=?');
  const social = (itemId: string, userId: string): ScrollSocial => ({
    count: (likeCount.get(itemId) as { n: number }).n,
    liked: !!likedByMe.get(itemId, userId),
    comments: (commentCount.get(itemId) as { n: number }).n,
  });
  const toComment = (r: CommentRow): ScrollComment => ({
    id: r.id, itemId: r.item_id, authorId: r.author_id, text: r.text,
    gif: r.gif ? JSON.parse(r.gif) : null, createdAt: r.created_at,
  });

  /** Likes and comment counts for every item in a server, for the feed. */
  app.get('/api/servers/:id/scroll', ctx.requireAuth, (req: Request, res: Response) => {
    if (!ctx.roleIn(req.params.id, userOf(req))) { res.status(404).json({ error: 'server not found' }); return; }
    const me = userOf(req);
    const ids = db.prepare('SELECT id FROM vault_items WHERE server_id=?').all(req.params.id) as { id: string }[];
    const items: Record<string, ScrollSocial> = {};
    for (const { id } of ids) items[id] = social(id, me);
    res.json({ items });
  });

  /** Sets or clears the caller's like on an item. */
  app.post('/api/vault/:id/like', ctx.requireAuth, express.json({ limit: '1kb' }), (req: Request, res: Response) => {
    const f = itemFor(req, res);
    if (!f) return;
    const me = userOf(req);
    const on = (req.body as { liked?: unknown } | undefined)?.liked;
    if (typeof on !== 'boolean') { res.status(400).json({ error: 'bad details' }); return; }
    if (on) db.prepare('INSERT OR IGNORE INTO vault_likes (item_id, user_id, created_at) VALUES (?,?,?)').run(f.item.id, me, Date.now());
    else db.prepare('DELETE FROM vault_likes WHERE item_id=? AND user_id=?').run(f.item.id, me);
    res.json(social(f.item.id, me));
  });

  app.get('/api/vault/:id/comments', ctx.requireAuth, (req: Request, res: Response) => {
    const f = itemFor(req, res);
    if (!f) return;
    const rows = db.prepare('SELECT * FROM vault_comments WHERE item_id=? ORDER BY created_at, id LIMIT ?').all(f.item.id, COMMENTS_PER_ITEM) as CommentRow[];
    res.json({ comments: rows.map(toComment) });
  });

  /** Adds a comment: text, a GIF, or both. */
  app.post('/api/vault/:id/comments', ctx.requireAuth, express.json({ limit: '16kb' }), (req: Request, res: Response) => {
    const f = itemFor(req, res);
    if (!f) return;
    const body = (req.body ?? {}) as { text?: unknown; gif?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length > TEXT_MAX) { res.status(400).json({ error: 'comment too long' }); return; }
    let gif: string | null = null;
    if (body.gif !== undefined && body.gif !== null) {
      const g = body.gif as Record<string, unknown>;
      const ok = typeof g === 'object' && typeof g.url === 'string' && typeof g.previewUrl === 'string' && typeof g.title === 'string'
        && typeof g.provider === 'string' && GIF_PROVIDERS.includes(g.provider)
        && g.url.length <= GIF_URL_MAX && g.previewUrl.length <= GIF_URL_MAX && g.title.length <= 200
        && (g.libraryId === undefined || typeof g.libraryId === 'string');
      if (!ok) { res.status(400).json({ error: 'bad gif' }); return; }
      gif = JSON.stringify({ url: g.url, previewUrl: g.previewUrl, title: g.title, provider: g.provider, ...(g.libraryId ? { libraryId: g.libraryId } : {}) });
    }
    if (!text && !gif) { res.status(400).json({ error: 'empty comment' }); return; }
    const row = { id: newId(), item_id: f.item.id, author_id: userOf(req), text, gif, created_at: Date.now() };
    db.prepare('INSERT INTO vault_comments (id, item_id, server_id, author_id, text, gif, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(row.id, row.item_id, f.item.server_id, row.author_id, row.text, row.gif, row.created_at);
    res.status(201).json({ comment: toComment(row) });
  });

  app.delete('/api/vault/comments/:cid', ctx.requireAuth, (req: Request, res: Response) => {
    const cid = req.params.cid;
    const row = ID.test(cid) ? db.prepare('SELECT * FROM vault_comments WHERE id=?').get(cid) as CommentRow | undefined : undefined;
    const role = row ? ctx.roleIn(row.server_id ?? '', userOf(req)) : null;
    if (!row || !role) { res.status(404).json({ error: 'comment not found' }); return; }
    if (row.author_id !== userOf(req) && role !== 'owner' && role !== 'admin') { res.status(403).json({ error: 'not allowed' }); return; }
    db.prepare('DELETE FROM vault_comments WHERE id=?').run(cid);
    res.json({ ok: true });
  });
}
