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
const { register } = await import('../src/modules/vault.js');

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
  assert.ok(fs.existsSync(path.join(config.vaultDir, item.id)) && fs.existsSync(path.join(config.vaultDir, `${item.id}.thumb`)));
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

  assert.equal((await call('u2', 'DELETE', `/api/vault/${item.id}`)).status, 403, 'other members cannot delete');
  assert.equal((await call('u1', 'DELETE', `/api/vault/${item.id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(config.vaultDir, item.id)));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM vault_items').get() as { n: number }).n, 0);
  log('only the uploader or an admin deletes, and the files go');
  console.log('\nVault: all checks passed');
} catch (err) {
  console.error('\nVault FAILED:', err);
  process.exitCode = 1;
} finally {
  srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
