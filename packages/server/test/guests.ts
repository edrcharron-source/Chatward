// Checks the demo chatter on a server: members only, at most three, frames carry numbers only, replies, and clean up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const dataDir = path.join(path.resolve(import.meta.dirname, '..'), 'out', `guests-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
const { default: express } = await import('express');
const { openDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { GUESTS_MAX } = await import('@chatward/shared');
const { register, guestsHearMessage } = await import('../src/modules/guests.js');

const log = (msg: string) => console.log(`  ok  ${msg}`);
const db = openDb();
const now = Date.now();
for (const [id, name] of [['u1', 'ann'], ['u2', 'ben'], ['u3', 'cat']]) {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run(id, name, name, 'x', now);
}
db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?,?,?,?)').run('s1', 's', 'u1', now);
db.prepare("INSERT INTO members (server_id, user_id, role, joined_at) VALUES ('s1','u1','owner',?),('s1','u2','member',?)").run(now, now);
db.prepare("INSERT INTO channels (id, server_id, name, kind, created_at) VALUES ('t1','s1','general','text',?),('v1','s1','Lounge','voice',?)").run(now, now);

const frames: Record<string, unknown>[] = [];
const roleIn = (s: string, u: string) => (db.prepare('SELECT role FROM members WHERE server_id=? AND user_id=?').get(s, u) as { role: string } | undefined)?.role ?? null;
const app = express();
app.use(express.json());
const ctx = {
  db, config,
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as unknown as { userId: string }).userId = String(req.headers['x-user']); next(); },
  roleIn,
  getMembers: () => [],
  broadcastToServer: (_s: string, f: Record<string, unknown>) => { frames.push(f); },
};
register(app, ctx as never);
const srv = app.listen(0);
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const call = async (user: string, method: string) => {
  const res = await fetch(`${base}/api/servers/s1/guests`, { method, headers: { 'x-user': user } });
  return { status: res.status, body: await res.json() as { guests: number[]; inVoice: number[]; voiceChannelId: string | null } };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  assert.equal((await call('u3', 'POST')).status, 404);
  assert.equal((await call('u3', 'GET')).status, 404);
  log('people outside the server cannot see or add');

  const empty = await call('u2', 'GET');
  assert.deepEqual(empty.body, { serverId: 's1', guests: [], voiceChannelId: 'v1', inVoice: [] });
  for (let i = 0; i < GUESTS_MAX + 2; i++) await call('u2', 'POST');
  const full = await call('u1', 'GET');
  assert.deepEqual(full.body.guests, [0, 1, 2]);
  assert.deepEqual(full.body.inVoice, [0, 1]);
  assert.equal(frames.filter((f) => f.t === 'guests.state').length, GUESTS_MAX);
  log('any member adds, capped at three; the first two sit in voice');

  frames.length = 0;
  guestsHearMessage('s1', 't1');
  await wait(5_500);
  const typing = frames.find((f) => f.t === 'guests.typing');
  const said = frames.find((f) => f.t === 'guests.say');
  assert.ok(typing && said, 'a guest types, then answers');
  assert.equal(said.channelId, 't1');
  assert.equal(said.reply, true);
  assert.equal(typeof said.line, 'number');
  assert.ok(!Object.values(said).some((v) => typeof v === 'string' && v.includes(' ')), 'no text in the frame');
  assert.ok(!frames.some((f) => f.t === 'guests.speak'), 'no voice frames while nobody is in the call');
  log('a member message gets one reply, sent as numbers only');

  await call('u2', 'DELETE');
  assert.deepEqual((await call('u2', 'GET')).body.guests, [0, 1]);
  await call('u2', 'DELETE');
  await call('u2', 'DELETE');
  const gone = await call('u2', 'DELETE');
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body.guests, []);
  log('removing takes the newest first and stops at none');
} finally {
  srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
