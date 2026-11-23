// Checks the Scroll feed's likes and comments: who may like, comment and delete, and that a comment with a GIF saves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const dataDir = path.join(path.resolve(import.meta.dirname, '..'), 'out', `scroll-feed-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
const { default: express } = await import('express');
const { openDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { register: scrollFeed } = await import('../src/modules/scrollFeed.js');

const db = openDb();
const now = Date.now();
for (const [id, name] of [['u1', 'ann'], ['u2', 'ben'], ['u3', 'cat']]) {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run(id, name, name, 'x', now);
}
db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?,?,?,?)').run('s1', 's1', 'u1', now);
db.prepare("INSERT INTO members (server_id, user_id, role, joined_at) VALUES ('s1','u1','owner',?),('s1','u2','member',?)").run(now, now);
db.prepare("INSERT INTO vault_items (id, server_id, owner_id, channel_id, key_version, ciphertext, size, thumb_size, created_at) VALUES ('i1','s1','u1','c1',1,'x',1,1,?)").run(now);

const roleIn = (s: string, u: string) => (db.prepare('SELECT role FROM members WHERE server_id=? AND user_id=?').get(s, u) as { role: string } | undefined)?.role ?? null;
const app = express();
const ctx = {
  db, config,
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as unknown as { userId: string }).userId = String(req.headers['x-user']); next(); },
  roleIn,
};
scrollFeed(app, ctx as never);
const srv = app.listen(0);
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const call = async (user: string, method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};

try {
  let r = await call('u2', 'POST', '/api/vault/i1/like', { liked: true });
  assert.equal(r.status, 200, `like: ${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual({ count: r.body.count, liked: r.body.liked }, { count: 1, liked: true });
  r = await call('u2', 'POST', '/api/vault/i1/comments', { text: 'hello' });
  assert.equal(r.status, 201, `text comment: ${r.status} ${JSON.stringify(r.body)}`);
  const cid = r.body.comment.id;
  const gif = { url: 'https://media.klipy.com/a.gif', previewUrl: 'https://media.klipy.com/p.gif', title: 'wave', provider: 'klipy' };
  r = await call('u2', 'POST', '/api/vault/i1/comments', { text: '', gif });
  assert.equal(r.status, 201, `gif comment: ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('u2', 'POST', '/api/vault/i1/comments', { text: 'with gif', gif: { ...gif, provider: 'library', libraryId: 'g1' } });
  assert.equal(r.status, 201, `library gif comment: ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('u3', 'POST', '/api/vault/i1/comments', { text: 'outsider' });
  assert.equal(r.status, 404, 'outsiders cannot comment');
  r = await call('u2', 'GET', '/api/vault/i1/comments');
  assert.equal(r.body.comments.length, 3);
  r = await call('u1', 'DELETE', `/api/vault/comments/${cid}`);
  assert.equal(r.status, 200, 'owner can delete');
  r = await call('u2', 'GET', '/api/servers/s1/scroll');
  assert.equal(r.body.items.i1.comments, 2);
  console.log('  ok  scroll feed likes and comments');
} finally {
  srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
