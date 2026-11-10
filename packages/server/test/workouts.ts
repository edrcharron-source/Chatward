// Checks the Workouts module (the crew tracker that replaced DOSS): streaks, logging rules, PRs, crew scope, nudges and
// cheers, and that someone outside the server can't see a member's page. Runs the real module against a fake auth layer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const dataDir = path.join(path.resolve(import.meta.dirname, '..'), 'out', `workouts-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
const { default: express } = await import('express');
const { openDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { register, computeStreak, addDays, dowOf, fmtValue, localNow } = await import('../src/modules/workouts.js');

const log = (msg: string) => console.log(`  ok  ${msg}`);

// Pure rules first.
const week = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, dow) => ({ dow, day, workout: dow === 6 ? '' : 'Run', kind: (dow === 6 ? 'Rest' : 'Cardio') as 'Rest' | 'Cardio' }));
assert.equal(dowOf('2026-11-02'), 0); // a Monday
assert.equal(addDays('2026-11-30', 1), '2026-12-01');
// Sat logged, Sun rest (skipped), Mon today not logged yet (skipped): streak 1.
assert.equal(computeStreak(new Set(['2026-11-07']), week, '2026-11-09', ''), 1);
// Fri missed breaks it.
assert.equal(computeStreak(new Set(['2026-11-05', '2026-11-07']), week, '2026-11-08', ''), 1);
// Nothing before the start date counts, and does not break it either.
assert.equal(computeStreak(new Set(['2026-11-07']), week, '2026-11-08', '2026-11-07'), 1);
assert.equal(fmtValue(26 + 10 / 60, 'min'), '26:10');
assert.equal(fmtValue(225, 'lb'), '225 lb');
log('streaks, dates and value formatting');

const db = openDb();
const now = Date.now();
for (const [id, name] of [['u1', 'ann'], ['u2', 'ben'], ['u3', 'cat']]) {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)').run(id, name, name, 'x', now);
}
db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?,?,?,?)').run('s1', 's', 'u1', now);
db.prepare("INSERT INTO members (server_id, user_id, role, joined_at) VALUES ('s1','u1','owner',?),('s1','u2','member',?)").run(now, now);
const app = express();
app.use(express.json());
const ctx = {
  db, config,
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as unknown as { userId: string }).userId = String(req.headers['x-user']); next(); },
  getUser: (id: string) => { const r = db.prepare('SELECT id, display_name FROM users WHERE id=?').get(id) as { id: string; display_name: string } | undefined; return r ? { id: r.id, displayName: r.display_name, avatarUrl: null } : null; },
};
register(app, ctx as never);
const srv = app.listen(0);
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const call = async (user: string, method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

try {
  const split = await call('u1', 'PUT', '/api/workouts/me/split', week);
  assert.equal(split.status, 200);
  const me = await call('u1', 'GET', '/api/workouts/me');
  assert.equal(me.body.startDate, localNow(me.body.tz as string).date, 'a first plan starts today');
  log('weekly plan saves and starts today');

  assert.equal((await call('u1', 'POST', '/api/workouts/log', {})).status, 200);
  assert.equal((await call('u1', 'POST', '/api/workouts/log', { date: '2001-01-01' })).status, 400);
  const crew = await call('u1', 'GET', '/api/workouts/crew');
  const members = crew.body.members as Array<{ userId: string; pos: number; week: { todayLogged: boolean } }>;
  assert.deepEqual(members.map((m) => m.userId).sort(), ['u1', 'u2'], 'the crew is the server, not outsiders');
  assert.equal(members.find((m) => m.userId === 'u1')!.week.todayLogged, true);
  log('logging today works, old dates are refused, crew is the server');

  const metrics = await call('u1', 'PUT', '/api/workouts/me/metrics', [{ name: '5K', unit: 'min', better: 'down' }]);
  const mid = (metrics.body.metrics as Array<{ id: string }>)[0].id;
  assert.equal((await call('u1', 'POST', `/api/workouts/metrics/${mid}/entries`, { value: 27.5 })).body.pr, false);
  assert.equal((await call('u1', 'POST', `/api/workouts/metrics/${mid}/entries`, { value: 26 })).body.pr, true);
  assert.equal((await call('u1', 'POST', `/api/workouts/metrics/${mid}/entries`, { value: 26.5 })).body.pr, false);
  assert.equal((await call('u2', 'POST', `/api/workouts/metrics/${mid}/entries`, { value: 1 })).status, 404, 'only the owner logs a metric');
  const feed = await call('u2', 'GET', '/api/workouts/feed');
  assert.ok((feed.body as unknown as Array<{ type: string }>).some((e) => e.type === 'pr'));
  log('PRs follow "lower is better" and reach the feed');

  await call('u1', 'PUT', '/api/workouts/me', { showNumbers: false });
  const page = await call('u2', 'GET', '/api/workouts/users/u1');
  assert.equal(page.body.numbersHidden, true);
  assert.deepEqual(page.body.metrics, []);
  assert.equal((await call('u3', 'GET', '/api/workouts/users/u1')).status, 404, 'outsiders cannot see a page');
  log('private numbers stay private; outsiders get 404');

  assert.equal((await call('u2', 'POST', '/api/workouts/users/u1/nudge')).status, 200);
  assert.equal((await call('u2', 'POST', '/api/workouts/users/u1/nudge')).status, 429);
  for (let i = 0; i < 5; i += 1) assert.equal((await call('u2', 'POST', '/api/workouts/users/u1/cheer')).status, 200);
  assert.equal((await call('u2', 'POST', '/api/workouts/users/u1/cheer')).status, 429);
  assert.equal((await call('u3', 'POST', '/api/workouts/users/u1/cheer')).status, 404);
  log('one nudge and five cheers a day; outsiders cannot');

  assert.equal((await call('u2', 'POST', '/api/workouts/users/u1/comments', { body: 'nice run' })).status, 200);
  const comments = (await call('u1', 'GET', '/api/workouts/users/u1')).body.comments as Array<{ id: string; body: string }>;
  assert.equal(comments[0].body, 'nice run');
  await call('u1', 'DELETE', `/api/workouts/comments/${comments[0].id}`);
  assert.equal(((await call('u1', 'GET', '/api/workouts/users/u1')).body.comments as unknown[]).length, 0);
  log('comments post and the page owner can remove them');
  console.log('workouts: all checks passed');
} finally {
  srv.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
