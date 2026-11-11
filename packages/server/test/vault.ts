// Checks the Vault API: upload, quota, access, delete. Runs the real module against a fake auth layer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const dataDir = path.join(path.resolve(import.meta.dirname, '..'), 'out', `vault-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.VAULT_QUOTA_MB = '1';
process.env.VAULT_MAX_MB = '2';
const { default: express } = await import('express');
const { openDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { register, vaultBlobPath, migrateFlatVault } = await import('../src/modules/vault.js');

const log = (msg: string) => console.log(`  ok  ${msg}`);
const db = openDb();
const now = Date.now();
for (const [id, name] of [['u1', 'ann'], ['u2', 'ben'], ['u3', 'cat']]) {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run(id, name, name, 'x', now);
}
db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?,?,?,?)').run('s1', 's', 'u1', now);
db.prepare("INSERT INTO members (server_id, user_id, role, joined_at) VALUES ('s1','u1','owner',?),('s1','u2','member',?)").run(now, now);
db.prepare("INSERT INTO channels (id, server_id, name, kind, created_at) VALUES ('c1','s1','general','text',?)").run(now);

const frames: unknown[] = [];
const roleIn = (s: string, u: string) => (db.prepare('SELECT role FROM members WHERE server_id=? AND user_id=?').get(s, u) as { role: string } | undefined)?.role ?? null;
const app = express();
const ctx = {
  db, config,
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as unknown as { userId: string }).userId = String(req.headers['x-user']); next(); },
  roleIn,
  getChannel: (id: string) => (id === 'c1' ? { id, serverId: 's1', name: 'general', kind: 'text' } : null),
  broadcastToServer: (_s: string, f: unknown) => { frames.push(f); },
};
register(app, ctx as never);
const srv = app.listen(0);
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const framed = (thumb: number, file: number) => {
  const b = Buffer.alloc(4 + thumb + file, 7);
  b.writeUInt32BE(thumb, 0);
  return b;
};
const call = (user: string, method: string, url: string, body?: Buffer) =>
  fetch(base + url, { method, headers: { 'x-user': user, 'content-type': 'application/octet-stream' }, body });
const up = (user: string, body: Buffer, q = 'channelId=c1&keyVersion=1&meta=abc') => call(user, 'POST', `/api/servers/s1/vault?${q}`, body);

try {
  let r = await up('u1', framed(100, 1000));
  assert.equal(r.status, 201);
  const { item } = await r.json() as { item: { id: string; size: number } };
  assert.equal(item.size, 1100);
  assert.ok(fs.existsSync(vaultBlobPath(config.vaultDir, item.id)) && fs.existsSync(vaultBlobPath(config.vaultDir, item.id, 'thumb')));
  assert.equal(frames.length, 1);
  log('a member uploads; both blobs land in VAULT_DIR and the server hears about it');

  assert.equal((await up('u3', framed(10, 10))).status, 404, 'outsiders cannot upload');
  assert.equal((await call('u3', 'GET', `/api/vault/${item.id}/file`)).status, 404, 'outsiders cannot read');
  assert.equal((await up('u2', framed(10, 10), 'channelId=nope&keyVersion=1&meta=abc')).status, 400, 'bad channel');
  assert.equal((await up('u2', Buffer.from([0, 0, 0, 9, 1]))).status, 400, 'bad thumbnail length');
  log('outsiders and malformed uploads are refused');

  const file = await call('u2', 'GET', `/api/vault/${item.id}/file`);
  assert.equal(file.status, 200);
  assert.equal((await file.arrayBuffer()).byteLength, 1000);
  const list = await (await call('u2', 'GET', '/api/servers/s1/vault')).json() as { items: unknown[]; quotaBytes: number };
  assert.equal(list.items.length, 1);
  assert.equal(list.quotaBytes, 1024 * 1024);
  log('members can list and download');

  assert.equal((await up('u1', framed(10, 1024 * 1024))).status, 413, 'over quota');
  assert.equal((await up('u2', framed(10, 3 * 1024 * 1024))).status, 413, 'over the per-file limit');
  log('quota and file size limits hold');

  const note = (user: string, ct = 'sealed') => fetch(`${base}/api/vault/${item.id}/annotation`, { method: 'POST', headers: { 'x-user': user, 'content-type': 'application/json' }, body: JSON.stringify({ keyVersion: 1, ciphertext: ct }) });
  assert.equal((await note('u3')).status, 404, 'outsiders cannot tag');
  assert.equal((await note('u1', '')).status, 400, 'empty tags are refused');
  assert.equal((await note('u1', 'one')).status, 200);
  assert.equal((await note('u2', 'two')).status, 200);
  assert.equal((await note('u2', 'two-b')).status, 200, 'retagging replaces your own row');
  const notes = await (await call('u1', 'GET', '/api/servers/s1/vault/annotations')).json() as { annotations: { authorId: string; ciphertext: string; channelId: string }[] };
  assert.equal(notes.annotations.length, 2);
  assert.equal(notes.annotations.find((n) => n.authorId === 'u2')?.ciphertext, 'two-b');
  assert.equal(notes.annotations[0].channelId, 'c1');
  assert.equal((await call('u2', 'DELETE', `/api/vault/${item.id}/annotation?author=u1`)).status, 403, 'members cannot clear others');
  assert.equal((await call('u2', 'DELETE', `/api/vault/${item.id}/annotation`)).status, 200);
  assert.equal((await call('u1', 'DELETE', `/api/vault/${item.id}/annotation?author=u1`)).status, 200);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM vault_annotations').get() as { n: number }).n, 0);
  await note('u1', 'again');
  log('members tag with their own sealed row; only owners clear other people\'s');

  assert.equal((await call('u2', 'DELETE', `/api/vault/${item.id}`)).status, 403, 'other members cannot delete');
  assert.equal((await call('u1', 'DELETE', `/api/vault/${item.id}`)).status, 200);
  assert.ok(!fs.existsSync(vaultBlobPath(config.vaultDir, item.id)));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM vault_items').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM vault_annotations').get() as { n: number }).n, 0, 'tags go with the item');
  log('only the uploader or an admin deletes, and the files go');

  // Chunked uploads. The quota is 1 MB and the per-file limit 2 MB in this test.
  db.prepare('DELETE FROM vault_items').run();
  frames.length = 0;
  const head = (thumb: number, prev: number, fileHead: number) => {
    const b = Buffer.alloc(8 + thumb + prev + fileHead, 3);
    b.writeUInt32BE(thumb, 0);
    b.writeUInt32BE(prev, 4 + thumb);
    return b;
  };
  const start = (user: string, size: number, body: Buffer) => call(user, 'POST', `/api/servers/s1/vault/uploads?channelId=c1&keyVersion=1&meta=abc&size=${size}`, body);
  r = await start('u2', 500, head(50, 80, 500));
  assert.equal(r.status, 201, 'a small file finishes in one request');
  const small = (await r.json() as { item: { id: string; size: number; hasPreview?: boolean } }).item;
  assert.equal(small.size, 630);
  assert.equal(small.hasPreview, true);
  assert.equal((await (await call('u2', 'GET', `/api/vault/${small.id}/preview`)).arrayBuffer()).byteLength, 80);
  assert.equal((await (await call('u2', 'GET', `/api/vault/${small.id}/file`)).arrayBuffer()).byteLength, 500);
  assert.equal(frames.length, 1);
  log('a small upload with a preview lands in one request, and the preview is served');

  r = await start('u2', 300_000, head(50, 0, 100_000));
  assert.equal(r.status, 202);
  const { uploadId } = await r.json() as { uploadId: string };
  const piece = (user: string, offset: number, n: number) => call(user, 'PUT', `/api/vault/uploads/${uploadId}?offset=${offset}`, Buffer.alloc(n, 9));
  assert.equal((await piece('u2', 0, 10)).status, 409, 'a piece at the wrong offset is refused');
  assert.equal((await piece('u1', 100_000, 10)).status, 404, 'someone else cannot add to my upload');
  assert.equal((await piece('u2', 100_000, 100_000)).status, 200);
  const status = await (await call('u2', 'GET', `/api/vault/uploads/${uploadId}`)).json() as { received: number };
  assert.equal(status.received, 200_000, 'the server reports where to resume');
  assert.equal((await piece('u2', 200_000, 100_001)).status, 400, 'more than the declared size is refused');
  r = await piece('u2', 200_000, 100_000);
  assert.equal(r.status, 201);
  const big = (await r.json() as { item: { id: string; size: number; hasPreview?: boolean } }).item;
  assert.equal(big.size, 300_050);
  assert.equal(big.hasPreview, undefined);
  assert.equal((await call('u2', 'GET', `/api/vault/${big.id}/preview`)).status, 404, 'no preview, no preview file');
  assert.equal((await (await call('u2', 'GET', `/api/vault/${big.id}/file`)).arrayBuffer()).byteLength, 300_000);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM vault_uploads').get() as { n: number }).n, 0);
  assert.deepEqual(fs.readdirSync(path.join(config.vaultDir, '.incoming')), [], 'no pieces are left behind');
  log('a larger file arrives in pieces, resumes from the reported offset, and finishes by itself');

  r = await start('u2', 800_000, head(10, 0, 10));
  assert.equal(r.status, 413, 'an upload that would pass the quota is refused before any bytes are sent');
  r = await start('u2', 600_000, head(10, 0, 10));
  assert.equal(r.status, 202);
  const pending = (await r.json() as { uploadId: string }).uploadId;
  assert.equal((await start('u2', 200_000, head(10, 0, 10))).status, 413, 'an unfinished upload holds its space');
  assert.equal((await call('u2', 'DELETE', `/api/vault/uploads/${pending}`)).status, 200);
  assert.equal((await start('u2', 3 * 1024 * 1024, head(10, 0, 10))).status, 413, 'over the per-file limit');
  r = await start('u2', 200_000, head(10, 0, 200_000));
  assert.equal(r.status, 201, 'cancelling gives the space back');
  log('unfinished uploads count against the quota until finished or cancelled');

  const index = await (await call('u1', 'GET', '/api/servers/s1/vault/index')).json() as { ids: [string, number][]; chunkBytes: number };
  assert.equal(index.ids.length, 3);
  assert.ok(index.ids[0][1] >= index.ids[2][1], 'newest first');
  assert.ok(index.chunkBytes > 0);
  assert.equal((await call('u3', 'GET', '/api/servers/s1/vault/index')).status, 404, 'outsiders get no index');
  const fetched = await (await fetch(`${base}/api/servers/s1/vault/items`, { method: 'POST', headers: { 'x-user': 'u1', 'content-type': 'application/json' }, body: JSON.stringify({ ids: [small.id, 'nope'] }) })).json() as { items: { id: string }[] };
  assert.deepEqual(fetched.items.map((i) => i.id), [small.id]);
  log('the index lists every item and /items returns the sealed details of the ones asked for');

  // Files stored in the old flat layout are still served, and the startup move puts them into folders.
  const legacy = 'legacyitem1';
  db.prepare("INSERT INTO vault_items (id, server_id, owner_id, channel_id, key_version, ciphertext, size, thumb_size, created_at) VALUES (?, 's1', 'u1', 'c1', 1, 'x', 4, 2, ?)").run(legacy, Date.now());
  fs.writeFileSync(path.join(config.vaultDir, legacy), 'abcd');
  fs.writeFileSync(path.join(config.vaultDir, `${legacy}.thumb`), 'ab');
  assert.equal(await (await call('u1', 'GET', `/api/vault/${legacy}/file`)).text(), 'abcd');
  assert.equal(await migrateFlatVault(config.vaultDir), 2);
  assert.ok(!fs.existsSync(path.join(config.vaultDir, legacy)) && fs.existsSync(vaultBlobPath(config.vaultDir, legacy)));
  assert.equal(await (await call('u1', 'GET', `/api/vault/${legacy}/thumb`)).text(), 'ab');
  assert.equal(await migrateFlatVault(config.vaultDir), 0, 'running it again moves nothing');
  log('old flat files are served and moved into the sharded folders');
  console.log('\nVault: all checks passed');
} catch (err) {
  console.error('\nVault FAILED:', err);
  process.exitCode = 1;
} finally {
  srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
