// End-to-end MLS check against a real server process (real HTTP, real SQLite).
// auth.ts and servers.ts are still stubs on main, so users, devices, servers and channels are seeded directly.
// Run with: npm run test:e2e -w @chatward/server
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import * as mls from '../../client/src/renderer/src/crypto/mls';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const CHANNEL = 'general';
const serverDir = path.resolve(import.meta.dirname, '..');
// Under out/ (gitignored) so a failed run leaves nothing to commit.
const dataDir = path.join(serverDir, 'out', `e2e-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });

interface Dev {
  id: string;
  user: string;
  token: string;
  /** KeyPackage wire string -> our private package, for every KeyPackage we uploaded. */
  pool: Map<string, mls.MemberKeys>;
  /** Our MLS state per channel. */
  state: Map<string, Awaited<ReturnType<typeof mls.createMlsGroup>>>;
}

const log = (msg: string) => console.log(`  ok  ${msg}`);

async function api(token: string | null, method: string, p: string, body?: unknown) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

async function startServer(): Promise<ChildProcess> {
  const child = spawn('node', ['dist/index.js'], {
    cwd: serverDir,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'inherit',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return child;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function uploadPool(dev: Dev, singleUse: number) {
  const items: { kp: string; lastResort?: boolean }[] = [];
  const made: [string, mls.MemberKeys][] = [];
  for (let i = 0; i <= singleUse; i++) {
    const keys = await mls.newMemberKeys(dev.id);
    const kp = await mls.encodeKeyPackage(keys);
    items.push({ kp, lastResort: i === singleUse });
    made.push([kp, keys]);
  }
  const r = await api(dev.token, 'POST', '/api/devices/keypackages', { deviceId: dev.id, keyPackages: items });
  assert.equal(r.status, 200, 'upload KeyPackages');
  for (const [kp, keys] of made) dev.pool.set(kp, keys);
}

/** Claim one KeyPackage per device of `targetUser`, as a decoded KeyPackage per device. */
async function claim(by: Dev, targetUser: string) {
  const r = await api(by.token, 'GET', `/api/users/u-${targetUser}/keypackages`);
  assert.equal(r.status, 200, `claim ${targetUser}`);
  return (r.json.keyPackages as { deviceId: string; kp: string }[]).map((k) => ({
    deviceId: k.deviceId,
    kp: mls.decodeKeyPackage(k.kp),
  }));
}

/** Post our commit; returns the HTTP result. Caller updates local state only on 200. */
async function postCommit(by: Dev, epoch: number, step: mls.GroupStep, members: string[], welcomeFor: string[]) {
  const welcomes = welcomeFor.map((toDeviceId) => ({ toDeviceId, welcome: b64(step.welcome!) }));
  const r = await api(by.token, 'POST', `/api/groups/${CHANNEL}/commits`, {
    deviceId: by.id, epoch, commit: b64(step.commit!), members, welcomes,
  });
  if (r.status === 200) mls.settle(step);
  return r;
}

/** Join from the Welcome the server holds for this device, trying each KeyPackage we still have. */
async function joinFromServer(dev: Dev) {
  const r = await api(dev.token, 'GET', `/api/groups/${CHANNEL}/welcomes`);
  const mine = (r.json.welcomes as { toDeviceId: string; welcome: string }[]).filter((w) => w.toDeviceId === dev.id);
  assert.ok(mine.length > 0, `${dev.id} has a Welcome`);
  const welcome = unb64(mine[mine.length - 1].welcome);
  for (const keys of dev.pool.values()) {
    try {
      dev.state.set(CHANNEL, await mls.joinFromWelcome(welcome, keys));
      return;
    } catch { /* not the KeyPackage this Welcome was made for */ }
  }
  throw new Error(`${dev.id} could not join`);
}

async function catchUp(dev: Dev, from: number) {
  const r = await api(dev.token, 'GET', `/api/groups/${CHANNEL}/commits?from=${from}`);
  let state = dev.state.get(CHANNEL)!;
  for (const c of r.json.commits as { commit: string }[]) state = (await mls.receive(state, unb64(c.commit))).state;
  dev.state.set(CHANNEL, state);
  return r.json.epoch as number;
}

async function main() {
  const server = await startServer();
  let failed = false;
  try {
    // Seed users, devices, one server with all three users, and one text channel. Use the server's own schema.
    const db = new Database(path.join(dataDir, 'chatward.db'));
    const secret = fs.readFileSync(path.join(dataDir, 'jwt-secret'), 'utf8');
    const now = Date.now();
    const addUser = (name: string) =>
      db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)')
        .run(`u-${name}`, name, name, 'x', now);
    const addDevice = (name: string, n: number) => {
      const id = `d-${name}-${n}`;
      db.prepare('INSERT INTO devices (device_id, user_id, ecdh_public, sign_public, created_at) VALUES (?,?,?,?,?)')
        .run(id, `u-${name}`, 'x', 'x', now);
      return id;
    };
    for (const n of ['alice', 'bob', 'carol']) addUser(n);
    db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?,?,?,?)').run('s1', 'S', 'u-alice', now);
    for (const [n, role] of [['alice', 'owner'], ['bob', 'member'], ['carol', 'member']] as const) {
      db.prepare('INSERT INTO members (server_id, user_id, role, joined_at) VALUES (?,?,?,?)').run('s1', `u-${n}`, role, now);
    }
    db.prepare("INSERT INTO channels (id, server_id, name, kind, created_at) VALUES (?,?,?,?,?)").run(CHANNEL, 's1', 'general', 'text', now);

    const mk = (name: string, n: number): Dev => ({
      id: addDevice(name, n), user: name, token: jwt.sign({ sub: `u-${name}` }, secret, { expiresIn: '1h' }),
      pool: new Map(), state: new Map(),
    });
    const alice = mk('alice', 1);
    const bob = mk('bob', 1);
    const carol = mk('carol', 1);
    for (const d of [alice, bob, carol]) await uploadPool(d, 4);
    log('seeded users, devices, server and channel; uploaded KeyPackage pools');

    // 1. First group creation, then add bob.
    alice.state.set(CHANNEL, await mls.createMlsGroup(CHANNEL, await mls.newMemberKeys(alice.id)));
    const [bobKp] = (await claim(alice, 'bob')).filter((k) => k.deviceId === bob.id);
    const add1 = await mls.addMembers(alice.state.get(CHANNEL)!, [bobKp.kp]);
    const r1 = await postCommit(alice, 0, add1, [alice.id, bob.id], [bob.id]);
    assert.equal(r1.status, 200, 'first commit accepted');
    assert.equal(r1.json.epoch, 1);
    alice.state.set(CHANNEL, add1.state);
    await joinFromServer(bob);
    assert.deepEqual(await mls.voiceKey(bob.state.get(CHANNEL)!), await mls.voiceKey(alice.state.get(CHANNEL)!));
    log('first group creation and add of bob via Welcome (epoch 0 to 1)');

    // 2. Race: alice and bob both add carol from epoch 1. Exactly one commit wins.
    const [carolKpA] = (await claim(alice, 'carol')).filter((k) => k.deviceId === carol.id);
    const [carolKpB] = (await claim(bob, 'carol')).filter((k) => k.deviceId === carol.id);
    const stepA = await mls.addMembers(alice.state.get(CHANNEL)!, [carolKpA.kp]);
    const stepB = await mls.addMembers(bob.state.get(CHANNEL)!, [carolKpB.kp]);
    const [ra, rb] = await Promise.all([
      postCommit(alice, 1, stepA, [alice.id, bob.id, carol.id], [carol.id]),
      postCommit(bob, 1, stepB, [alice.id, bob.id, carol.id], [carol.id]),
    ]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, [200, 409], 'one commit wins, the other gets 409');
    const loser = ra.status === 409 ? alice : bob;
    const winnerStep = ra.status === 200 ? stepA : stepB;
    assert.equal((ra.status === 409 ? ra : rb).json.currentEpoch, 2);
    assert.equal(winnerStep.commit !== undefined, true);
    // The loser drops its own pending add and applies the winning commit instead.
    const epoch = await catchUp(loser, 1);
    assert.equal(epoch, 2);
    const winner = loser === alice ? bob : alice;
    winner.state.set(CHANNEL, winnerStep.state);
    assert.equal(ra.status === 200 ? alice.id : bob.id, winner.id);
    await joinFromServer(carol);
    assert.deepEqual(await mls.voiceKey(carol.state.get(CHANNEL)!), await mls.voiceKey(loser.state.get(CHANNEL)!));
    log('concurrent commit race: one 200, one 409 with currentEpoch 2; loser caught up; carol joined');

    // 3. A second device for bob joins by Welcome.
    const bob2 = mk('bob', 2);
    await uploadPool(bob2, 4);
    const [bob2Kp] = (await claim(alice, 'bob')).filter((k) => k.deviceId === bob2.id);
    const add3 = await mls.addMembers(alice.state.get(CHANNEL)!, [bob2Kp.kp]);
    const r3 = await postCommit(alice, 2, add3, [alice.id, bob.id, carol.id, bob2.id], [bob2.id]);
    assert.equal(r3.status, 200, 'add bob second device');
    alice.state.set(CHANNEL, add3.state);
    bob.state.set(CHANNEL, (await mls.receive(bob.state.get(CHANNEL)!, unb64(b64(add3.commit!)))).state);
    carol.state.set(CHANNEL, (await mls.receive(carol.state.get(CHANNEL)!, add3.commit!)).state);
    await joinFromServer(bob2);
    log('second device of bob joined through its Welcome (epoch 3)');

    // 4. Message round trip, sealed in the current epoch and carried as keyVersion = epoch + 1.
    const enc = await mls.encryptMessage(alice.state.get(CHANNEL)!, new TextEncoder().encode('hello team'));
    alice.state.set(CHANNEL, enc.state);
    const sent = await api(alice.token, 'POST', `/api/channels/${CHANNEL}/messages`, { ciphertext: b64(enc.ciphertext), keyVersion: 4 });
    assert.equal(sent.status, 201, 'message accepted');
    const hist = await api(bob2.token, 'GET', `/api/channels/${CHANNEL}/messages`);
    const list = (Array.isArray(hist.json) ? hist.json : hist.json.messages) as { ciphertext: string }[];
    const got = await mls.receive(bob2.state.get(CHANNEL)!, unb64(list[list.length - 1].ciphertext));
    assert.equal(new TextDecoder().decode(got.plaintext!), 'hello team');
    bob2.state.set(CHANNEL, got.state);
    log('message round trip: alice to bob second device');

    // 5. Kick carol: the server removes her membership, then a remaining device commits the Remove.
    db.prepare('DELETE FROM members WHERE server_id=? AND user_id=?').run('s1', 'u-carol');
    const pending = await api(alice.token, 'GET', '/api/servers/s1/pending-removals');
    assert.deepEqual(pending.json.pending, [{ channelId: CHANNEL, epoch: 3, removedDeviceIds: [carol.id] }]);
    const carolLeaf = mls.memberLeaves(alice.state.get(CHANNEL)!).find((m) => m.deviceId === carol.id)!.leafIndex;
    const remove = await mls.removeMembers(alice.state.get(CHANNEL)!, [carolLeaf]);
    const r5 = await postCommit(alice, 3, remove, [alice.id, bob.id, bob2.id], []);
    assert.equal(r5.status, 200, 'remove carol');
    alice.state.set(CHANNEL, remove.state);
    bob.state.set(CHANNEL, (await mls.receive(bob.state.get(CHANNEL)!, remove.commit!)).state);
    bob2.state.set(CHANNEL, (await mls.receive(bob2.state.get(CHANNEL)!, remove.commit!)).state);
    assert.equal((await api(alice.token, 'GET', '/api/servers/s1/pending-removals')).json.pending.length, 0);
    log('kick: pending removal listed for carol, Remove committed, pending list now empty');

    // 6. Carol is out: a fresh message is unreadable to her, and her commits are refused.
    const after = await mls.encryptMessage(alice.state.get(CHANNEL)!, new TextEncoder().encode('secret after kick'));
    alice.state.set(CHANNEL, after.state);
    await assert.rejects(mls.receive(carol.state.get(CHANNEL)!, after.ciphertext), 'removed carol must not decrypt');
    const carolPost = await api(carol.token, 'POST', `/api/groups/${CHANNEL}/commits`, {
      deviceId: carol.id, epoch: 4, commit: b64(add1.commit!), members: [], welcomes: [],
    });
    assert.equal(carolPost.status, 404, 'removed carol cannot commit');
    const bobRead = await mls.receive(bob.state.get(CHANNEL)!, after.ciphertext);
    assert.equal(new TextDecoder().decode(bobRead.plaintext!), 'secret after kick');
    log('removed carol cannot decrypt or commit; remaining members still can');

    // 7. Stale commit at an old epoch is refused with the current epoch.
    const stale = await postCommit(bob, 0, add1, [alice.id, bob.id], [bob.id]);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.currentEpoch, 4);
    log('stale commit at epoch 0 refused with 409 and currentEpoch 4');

    console.log('\nE2E MLS: all checks passed');
  } catch (err) {
    failed = true;
    console.error('\nE2E MLS FAILED:', err);
  } finally {
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (failed) process.exitCode = 1;
  }
}

main();
