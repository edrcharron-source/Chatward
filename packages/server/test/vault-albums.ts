// Checks Vault albums: make, add, take out, rename, cover, delete, and who may do what. Real modules, fake auth.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const dataDir = path.join(path.resolve(import.meta.dirname, '..'), 'out', `vault-albums-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
const { default: express } = await import('express');
const { openDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { register: vault } = await import('../src/modules/vault.js');
const { register: albums } = await import('../src/modules/vaultAlbums.js');

const log = (msg: string) => console.log(`  ok  ${msg}`);
const db = openDb();
const now = Date.now();
for (const [id, name] of [['u1', 'ann'], ['u2', 'ben'], ['u3', 'cat'], ['u4', 'dan']]) {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run(id, name, name, 'x', now);
}
for (const s of ['s1', 's2']) db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?,?,?,?)').run(s, s, 'u1', now);
db.prepare("INSERT INTO members (server_id, user_id, role, joined_at) VALUES ('s1','u1','owner',?),('s1','u2','member',?),('s1','u4','member',?),('s2','u1','owner',?)").run(now, now, now, now);
db.prepare("INSERT INTO channels (id, server_id, name, kind, created_at) VALUES ('c1','s1','general','text',?),('c2','s2','general','text',?)").run(now, now);
const item = (id: string, server = 's1', channel = 'c1') =>
  db.prepare('INSERT INTO vault_items (id, server_id, owner_id, channel_id, key_version, ciphertext, size, thumb_size, created_at) VALUES (?,?,?,?,1,?,1,1,?)').run(id, server, 'u1', channel, 'x', now);
['i1', 'i2', 'i3', 'i4'].forEach((i) => item(i));
item('other', 's2', 'c2');

const frames: { t: string }[] = [];
const roleIn = (s: string, u: string) => (db.prepare('SELECT role FROM members WHERE server_id=? AND user_id=?').get(s, u) as { role: string } | undefined)?.role ?? null;
const app = express();
const ctx = {
  db, config,
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as unknown as { userId: string }).userId = String(req.headers['x-user']); next(); },
  roleIn,
  getChannel: (id: string) => (id === 'c1' ? { id, serverId: 's1' } : id === 'c2' ? { id, serverId: 's2' } : null),
  broadcastToServer: (_s: string, f: { t: string }) => { frames.push(f); },
};
vault(app, ctx as never);
albums(app, ctx as never);
const srv = app.listen(0);
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const call = async (user: string, method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const sealedName = { channelId: 'c1', keyVersion: 1, ciphertext: 'sealed-name' };

try {
  let r = await call('u2', 'POST', '/api/servers/s1/vault/albums', { ...sealedName, itemIds: ['i1', 'i2', 'other', 'i1', 'bad!'] });
  assert.equal(r.status, 400, 'malformed ids are refused');
  r = await call('u2', 'POST', '/api/servers/s1/vault/albums', { ...sealedName, itemIds: ['i1', 'i2', 'other', 'i1'] });
  assert.equal(r.status, 201);
  const album = r.body.album;
  assert.deepEqual(album.itemIds, ['i1', 'i2'], 'items from other servers and repeats are dropped');
  assert.equal(album.coverItemId, 'i1');
  assert.equal(album.ownerId, 'u2');
  assert.equal(frames.at(-1)?.t, 'vault.album');
  assert.equal((await call('u3', 'POST', '/api/servers/s1/vault/albums', sealedName)).status, 404, 'outsiders cannot make albums');
  assert.equal((await call('u2', 'POST', '/api/servers/s1/vault/albums', { ...sealedName, channelId: 'c2' })).status, 400, 'a channel from another server is refused');
  log('a member makes an album with photos; outsiders and foreign items are kept out');

  r = await call('u4', 'POST', `/api/vault/albums/${album.id}/items`, { add: ['i3', 'i4'] });
  assert.deepEqual(r.body.album.itemIds, ['i1', 'i2', 'i3', 'i4']);
  assert.equal((await call('u4', 'POST', `/api/vault/albums/${album.id}/items`, { remove: ['i1'] })).status, 403, 'members cannot take out what others added');
  assert.equal((await call('u4', 'POST', `/api/vault/albums/${album.id}/items`, { remove: ['i3'] })).status, 200, 'but can take out their own');
  assert.equal((await call('u3', 'POST', `/api/vault/albums/${album.id}/items`, { add: ['i3'] })).status, 404);
  r = await call('u2', 'POST', `/api/vault/albums/${album.id}/items`, { remove: ['i1'] });
  assert.deepEqual(r.body.album.itemIds, ['i2', 'i4']);
  assert.equal(r.body.album.coverItemId, 'i2', 'the cover moves when its photo is taken out');
  log('anyone adds; people take out what they added, the maker takes out anything');

  assert.equal((await call('u4', 'PATCH', `/api/vault/albums/${album.id}`, { ...sealedName, ciphertext: 'x' })).status, 403, 'members cannot rename others\' albums');
  r = await call('u1', 'PATCH', `/api/vault/albums/${album.id}`, { ...sealedName, ciphertext: 'renamed' });
  assert.equal(r.status, 200, 'the server owner can');
  assert.equal(r.body.album.ciphertext, 'renamed');
  assert.equal(r.body.album.sealedBy, 'u1', 'the new seal records who sealed it');
  assert.equal((await call('u2', 'PATCH', `/api/vault/albums/${album.id}`, { coverItemId: 'i1' })).status, 400, 'the cover must be in the album');
  assert.equal((await call('u2', 'PATCH', `/api/vault/albums/${album.id}`, { coverItemId: 'i4' })).body.album.coverItemId, 'i4');
  log('the maker and admins rename and pick the cover');

  // Deleting a photo takes it out of albums and clears the cover.
  assert.equal((await call('u1', 'DELETE', '/api/vault/i4')).status, 200);
  const list = await call('u2', 'GET', '/api/servers/s1/vault/albums');
  assert.deepEqual(list.body.albums[0].itemIds, ['i2']);
  assert.equal(list.body.albums[0].coverItemId, null);
  assert.equal((await call('u3', 'GET', '/api/servers/s1/vault/albums')).status, 404);
  log('deleting a photo takes it out of every album');

  assert.equal((await call('u4', 'DELETE', `/api/vault/albums/${album.id}`)).status, 403);
  assert.equal((await call('u2', 'DELETE', `/api/vault/albums/${album.id}`)).status, 200);
  assert.equal(frames.at(-1)?.t, 'vault.album.delete');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM vault_items WHERE server_id=?').get('s1') as { n: number }).n, 3, 'photos stay');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM vault_album_items').get() as { n: number }).n, 0);
  log('deleting an album keeps its photos');
  console.log('\nVault albums: all checks passed');
} catch (err) {
  console.error('\nVault albums FAILED:', err);
  process.exitCode = 1;
} finally {
  srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
