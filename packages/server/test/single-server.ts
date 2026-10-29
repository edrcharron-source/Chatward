// Checks the upgrade from the multi-server releases: ensureSingleServer on databases shaped like lebserver's could be.
// Run with: npm run test:e2e -w @chatward/server (it runs before the MLS check).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(path.resolve(import.meta.dirname, '..'), 'out', `migrate-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
const { openDb } = await import('../src/db.js');
const { ensureSingleServer, mainServerId } = await import('../src/singleServer.js');

const log = (msg: string) => console.log(`  ok  ${msg}`);
let at = 1_000;
const addUser = (db: ReturnType<typeof openDb>, id: string, username: string, displayName: string) =>
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, displayName, 'x', at++);
const addServer = (db: ReturnType<typeof openDb>, id: string, owner: string) => {
  db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run(id, id, owner, at++);
  db.prepare("INSERT INTO members (server_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(id, owner, at++);
};
const memberIds = (db: ReturnType<typeof openDb>, serverId: string) =>
  (db.prepare('SELECT user_id FROM members WHERE server_id=? ORDER BY user_id').all(serverId) as { user_id: string }[]).map((r) => r.user_id);

try {
  // Fresh install: nothing to do until the first account.
  let db = openDb();
  ensureSingleServer(db);
  assert.equal(mainServerId(db), null, 'no server before the first account');
  log('an empty database gets no server');

  // The live case: the owner registered but never made a server.
  addUser(db, 'u1', 'carlube', 'Caleb');
  ensureSingleServer(db);
  const sid = mainServerId(db)!;
  assert.ok(sid, 'a server is made for the existing owner');
  assert.equal((db.prepare('SELECT owner_id FROM servers WHERE id=?').get(sid) as { owner_id: string }).owner_id, 'u1');
  const channels = db.prepare('SELECT name, kind FROM channels WHERE server_id=? ORDER BY kind').all(sid);
  assert.deepEqual(channels, [{ name: 'general', kind: 'text' }, { name: 'General', kind: 'voice' }]);
  assert.equal((db.prepare("SELECT display_name FROM users WHERE id='u1'").get() as { display_name: string }).display_name, 'carlube',
    'the display name follows the login name');
  ensureSingleServer(db);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM servers').get() as { n: number }).n, 1, 'running again changes nothing');
  log('an owner without a server gets one with #general and General, once');
  db.close();

  // Several servers, outsiders and a ban: the oldest server wins, everyone else joins it, the banned account turns off.
  fs.rmSync(path.join(dataDir, 'chatward.db'));
  fs.rmSync(path.join(dataDir, 'chatward.db-wal'), { force: true });
  fs.rmSync(path.join(dataDir, 'chatward.db-shm'), { force: true });
  db = openDb();
  addUser(db, 'a', 'alice', 'Alice');
  addUser(db, 'b', 'bob', 'Bobby');
  addUser(db, 'c', 'carol', 'Carol');
  addUser(db, 'd', 'dave', 'Dave');
  addServer(db, 'first', 'a');
  addServer(db, 'second', 'b');
  db.prepare("INSERT INTO members (server_id, user_id, role, joined_at) VALUES ('second', 'c', 'member', ?)").run(at++);
  db.prepare("INSERT INTO bans (server_id, user_id, banned_by, created_at) VALUES ('first', 'd', 'a', ?)").run(at++);
  db.prepare("UPDATE users SET deleted_at=1, username='deleted-x' WHERE id='c'").run();
  addUser(db, 'e', 'erin', 'Erin');
  db.prepare("UPDATE users SET deleted_at=1, username='deleted-e', display_name='Deleted user' WHERE id='e'").run();
  ensureSingleServer(db);
  assert.equal(mainServerId(db), 'first', 'the oldest server is the server');
  assert.deepEqual(memberIds(db, 'first'), ['a', 'b'], 'live accounts join it; deleted and banned ones do not');
  assert.deepEqual(memberIds(db, 'second'), ['b', 'c'], 'the other server is left untouched');
  assert.ok((db.prepare("SELECT disabled_at FROM users WHERE id='d'").get() as { disabled_at: number | null }).disabled_at, 'the banned account is turned off');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM bans WHERE server_id='first'").get() as { n: number }).n, 0, 'its ban is dropped');
  assert.equal((db.prepare("SELECT display_name FROM users WHERE id='e'").get() as { display_name: string }).display_name, 'Deleted user',
    'deleted accounts keep their tombstone name');
  ensureSingleServer(db);
  assert.deepEqual(memberIds(db, 'first'), ['a', 'b'], 'running again changes nothing');
  log('with several servers the oldest wins, live accounts join, banned ones turn off, the rest stays as it was');
  db.close();
  console.log('\nSingle-server migration: all checks passed');
} catch (err) {
  console.error('\nSingle-server migration FAILED:', err);
  process.exitCode = 1;
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
