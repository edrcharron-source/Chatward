// Checks the GIF library API: upload, names and tags, quota, access, rename, delete. Runs the real module against a fake auth layer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const dataDir = path.join(path.resolve(import.meta.dirname, '..'), 'out', `gif-library-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_QUOTA_MB = '1';
const { default: express } = await import('express');
const { openDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { LIMITS } = await import('@chatward/shared');
const { register, libraryGifsDirOf, isKlipyUrl } = await import('../src/modules/gifLibrary.js');

const log = (msg: string) => console.log(`  ok  ${msg}`);
const db = openDb();
const now = Date.now();
for (const [id, name] of [['u1', 'ann'], ['u2', 'ben'], ['u3', 'cat'], ['u4', 'dan']]) {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run(id, name, name, 'x', now);
}
db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?,?,?,?)').run('s1', 's', 'u1', now);
db.prepare("INSERT INTO members (server_id, user_id, role, joined_at) VALUES ('s1','u1','owner',?),('s1','u2','member',?),('s1','u4','member',?)").run(now, now, now);

const frames: { t: string }[] = [];
const roleIn = (s: string, u: string) => (db.prepare('SELECT role FROM members WHERE server_id=? AND user_id=?').get(s, u) as { role: string } | undefined)?.role ?? null;
const app = express();
app.use(express.json());
const ctx = {
  db, config,
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as unknown as { userId: string }).userId = String(req.headers['x-user']); next(); },
  roleIn,
  broadcastToServer: (_s: string, f: { t: string }) => { frames.push(f); },
};
register(app, ctx as never);
const srv = app.listen(0);
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

/** A GIF header with the given size, padded to `bytes`. Enough for the server's checks. */
const gif = (bytes = 64, width = 32, height = 24) => {
  const b = Buffer.alloc(Math.max(bytes, 13), 0);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
};
const call = (user: string, method: string, url: string, body?: Buffer | object) =>
  fetch(base + url, {
    method,
    headers: { 'x-user': user, 'content-type': Buffer.isBuffer(body) ? 'image/gif' : 'application/json' },
    body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined,
  });
const up = (user: string, body: Buffer, q = 'name=Bruh&tags=Reaction,%20meme') => call(user, 'POST', `/api/servers/s1/library-gifs?${q}`, body);

try {
  const r1 = await up('u2', gif(100, 48, 36));
  assert.equal(r1.status, 201);
  const { gif: g1 } = await r1.json() as { gif: { id: string; name: string; tags: string[]; width: number; height: number; ownerId: string } };
  assert.deepEqual([g1.name, g1.tags, g1.width, g1.height, g1.ownerId], ['Bruh', ['reaction', 'meme'], 48, 36, 'u2']);
  assert.ok(fs.existsSync(path.join(libraryGifsDirOf(config.uploadsDir), g1.id)));
  assert.equal(frames.at(-1)?.t, 'gif.new');
  log('a member uploads a GIF with a name and tags');

  assert.equal((await up('u2', Buffer.from('not a gif at all'))).status, 400);
  assert.equal((await up('u2', gif(), 'name=')).status, 400);
  assert.equal((await up('u2', gif(), `name=${'x'.repeat(41)}`)).status, 400);
  assert.equal((await up('u2', gif(), 'name=a&tags=1,2,3,4,5,6')).status, 400);
  log('non-GIFs, missing or long names and too many tags are refused');

  assert.equal((await up('u3', gif())).status, 404);
  assert.equal((await call('u3', 'GET', '/api/servers/s1/library-gifs')).status, 404);
  assert.equal((await call('u3', 'GET', `/api/library-gifs/${g1.id}/file`)).status, 404);
  log('people outside the server cannot list, add or fetch');

  const list = await (await call('u4', 'GET', '/api/servers/s1/library-gifs')).json() as { gifs: { id: string }[] };
  assert.deepEqual(list.gifs.map((g) => g.id), [g1.id]);
  const file = await call('u4', 'GET', `/api/library-gifs/${g1.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/gif');
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal((await call('u4', 'POST', `/api/library-gifs/${g1.id}/use`)).status, 200);
  const used = await (await call('u4', 'GET', '/api/servers/s1/library-gifs')).json() as { gifs: { uses: number }[] };
  assert.equal(used.gifs[0].uses, 1);
  log('other members list, fetch and count a use');

  assert.equal((await call('u4', 'PATCH', `/api/library-gifs/${g1.id}`, { name: 'Mine now' })).status, 403);
  assert.equal((await call('u4', 'DELETE', `/api/library-gifs/${g1.id}`)).status, 403);
  log('another member cannot rename or delete it');

  const renamed = await call('u2', 'PATCH', `/api/library-gifs/${g1.id}`, { name: '  Big   bruh ', tags: ['funny'] });
  assert.equal(renamed.status, 200);
  const { gif: g1b } = await renamed.json() as { gif: { name: string; tags: string[] } };
  assert.deepEqual([g1b.name, g1b.tags], ['Big bruh', ['funny']]);
  assert.equal(frames.at(-1)?.t, 'gif.update');
  assert.equal((await call('u1', 'PATCH', `/api/library-gifs/${g1.id}`, { name: 'Owner edit' })).status, 200);
  log('whoever added it and the server owner can rename it');

  // The 1 MB quota is shared with chat attachments.
  db.prepare('INSERT INTO uploads (id, owner_id, size, created_at, tracked) VALUES (?,?,?,?,?)').run('up1', 'u2', 900 * 1024, now, 0);
  const over = await up('u2', gif(200 * 1024));
  assert.equal(over.status, 413);
  assert.match(((await over.json()) as { error: string }).error, /Upload space is full/);
  assert.equal((await up('u4', gif(200 * 1024))).status, 201);
  log('library GIFs count toward the shared upload quota');

  assert.equal((await up('u2', gif(LIMITS.LIBRARY_GIF_MAX_BYTES + 1))).status, 413);
  log('GIFs over 10 MB are refused');

  assert.equal((await call('u1', 'DELETE', `/api/library-gifs/${g1.id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(libraryGifsDirOf(config.uploadsDir), g1.id)));
  assert.equal(frames.at(-1)?.t, 'gif.delete');
  assert.equal((await call('u4', 'GET', `/api/library-gifs/${g1.id}/file`)).status, 404);
  log('an admin deletes it and the file goes away');

  for (const bad of ['http://klipy.com/a.gif', 'https://evil.com/a.gif', 'https://klipy.com.evil.com/a.gif', 'https://user@klipy.com/a.gif', 'https://klipy.com:8443/a.gif', 42]) {
    assert.equal(isKlipyUrl(bad), null, String(bad));
  }
  assert.ok(isKlipyUrl('https://static.klipy.com/x/y.gif'));
  const notKlipy = await call('u2', 'POST', '/api/servers/s1/library-gifs/from-url?name=x', { url: 'https://example.com/a.gif' });
  assert.equal(notKlipy.status, 400);
  log('saving by address only fetches from KLIPY');

  console.log('gif library: all checks passed');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  srv.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

