// End-to-end MLS check against a real server process (real HTTP, real SQLite) using the public API only:
// sign-up codes from the chatward command, login for a second device, channels, removing accounts, and Commit delivery.
// Run with: npm run test:e2e -w @chatward/server
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as mls from '../../client/src/renderer/src/crypto/mls';
import { exportRawPublic, generateEcdh, generateSigning, toB64 } from '../../client/src/renderer/src/crypto/primitives';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct-horse-1';
const LIVEKIT_PORT = 3998;
// A stand-in for LiveKit's Twirp API, so a voice rejoin can ask whether a user is in a room. Members are "room:identity".
// mode 'down' answers 500 and 'hang' answers late, to check how a lookup LiveKit cannot answer is reported.
const fakeLiveKit = { members: new Set<string>(), removals: [] as string[], mode: 'up' as 'up' | 'down' | 'hang' };
const liveKitServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    if (fakeLiveKit.mode === 'down') { send(500, { code: 'internal', msg: 'down' }); return; }
    if (fakeLiveKit.mode === 'hang') { setTimeout(() => send(200, {}), 4_000); return; }
    const { room, identity } = JSON.parse(raw || '{}') as { room: string; identity: string };
    const key = `${room}:${identity}`;
    if (req.url?.endsWith('/GetParticipant')) {
      if (fakeLiveKit.members.has(key)) send(200, { identity, room });
      else send(404, { code: 'not_found', msg: 'participant not found' });
      return;
    }
    if (req.url?.endsWith('/RemoveParticipant')) {
      fakeLiveKit.removals.push(key);
      fakeLiveKit.members.delete(key);
      send(200, {});
      return;
    }
    send(404, { code: 'bad_route', msg: 'unknown method' });
  });
});
const serverDir = path.resolve(import.meta.dirname, '..');
// Under out/ (gitignored) so a failed run leaves nothing to commit.
const dataDir = path.join(serverDir, 'out', `e2e-data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });

interface Dev {
  id: string;
  user: string;
  name: string;
  token: string;
  /** KeyPackage wire string -> our private package, for every KeyPackage we uploaded. */
  pool: Map<string, mls.MemberKeys>;
  /** Our MLS state per channel. */
  state: Map<string, Awaited<ReturnType<typeof mls.createMlsGroup>>>;
}

interface DeviceKeys { deviceId: string; ecdhPublic: string; signPublic: string }

/** Each device's ECDSA signing private key, which signs its MLS credentials. */
const signPrivates = new Map<string, CryptoKey>();
/** Stands in for the server's device list that clients check MLS credentials against. */
const registeredSignKeys = new Map<string, string>();
const devices: mls.DeviceDirectory = (deviceId) => registeredSignKeys.get(deviceId);

async function makeDeviceKeys(): Promise<DeviceKeys> {
  const ecdh = await generateEcdh();
  const sign = await generateSigning();
  const deviceId = crypto.randomUUID();
  const signPublic = toB64(await exportRawPublic(sign.publicKey));
  signPrivates.set(deviceId, sign.privateKey);
  registeredSignKeys.set(deviceId, signPublic);
  return { deviceId, ecdhPublic: toB64(await exportRawPublic(ecdh.publicKey)), signPublic };
}

const newKeys = (deviceId: string) => mls.newMemberKeys({ deviceId, signPrivate: signPrivates.get(deviceId)! });

/** The text channel under test, set once the server exists. */
let CHANNEL = '';

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
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), HOST: '127.0.0.1', LIVEKIT_API_URL: `http://127.0.0.1:${LIVEKIT_PORT}` },
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

/** Runs the chatward admin command against the test server, as the server login "tester". Throws on a non-zero exit. */
function cli(...args: string[]): string {
  return execFileSync('node', ['dist/cli.js', ...args], {
    cwd: serverDir, env: { ...process.env, DATA_DIR: dataDir, CHATWARD_ADMIN: 'tester' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The chatward command's output and exit status, for commands expected to fail. */
function cliFails(...args: string[]): string {
  try {
    cli(...args);
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? '');
  }
  throw new Error(`chatward ${args.join(' ')} should have failed`);
}

/** A fresh one-time sign-up code from `chatward invite`. */
function signupCode(): string {
  const m = /New sign-up code: ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(cli('invite'));
  assert.ok(m, 'chatward invite prints a code');
  return m[1];
}

const inviteLog = () => fs.readFileSync(path.join(dataDir, 'invites.log'), 'utf8');

async function uploadPool(dev: Dev, singleUse: number, replace = false) {
  const items: { kp: string; lastResort?: boolean }[] = [];
  const made: [string, mls.MemberKeys][] = [];
  for (let i = 0; i <= singleUse; i++) {
    const keys = await newKeys(dev.id);
    const kp = await mls.encodeKeyPackage(keys);
    items.push({ kp, lastResort: i === singleUse });
    made.push([kp, keys]);
  }
  const path = replace ? '/api/devices/keypackages/replace' : '/api/devices/keypackages';
  const r = await api(dev.token, 'POST', path, { deviceId: dev.id, keyPackages: items });
  assert.equal(r.status, 200, 'upload KeyPackages');
  for (const [kp, keys] of made) dev.pool.set(kp, keys);
}

/** Claim one KeyPackage per device of `targetUser`, as a decoded KeyPackage per device. */
async function claim(by: Dev, targetUserId: string) {
  const r = await api(by.token, 'GET', `/api/users/${targetUserId}/keypackages`);
  assert.equal(r.status, 200, `claim ${targetUserId}`);
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
      dev.state.set(CHANNEL, await mls.joinFromWelcome(welcome, keys, devices));
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

async function newDev(name: string, user: { id: string; token: string }, keys: DeviceKeys): Promise<Dev> {
  return { id: keys.deviceId, user: user.id, name, token: user.token, pool: new Map(), state: new Map() };
}

async function main() {
  await new Promise<void>((resolve) => liveKitServer.listen(LIVEKIT_PORT, '127.0.0.1', resolve));
  let server = await startServer();
  let failed = false;
  try {
    // Accounts go through the real API with codes from the chatward command. The first account owns the server.
    const aliceKeys = await makeDeviceKeys();
    const noCode = await api(null, 'POST', '/api/auth/register', { name: 'alice', password: PASSWORD, device: aliceKeys });
    assert.equal(noCode.status, 403, 'sign-up is refused without a code');
    const wrongCode = await api(null, 'POST', '/api/auth/register', {
      name: 'alice', password: PASSWORD, device: aliceKeys, inviteCode: 'AAAA-BBBB-CCCC',
    });
    assert.equal(wrongCode.status, 403, 'sign-up is refused with a made-up code');
    const aliceCode = signupCode();
    assert.match(cli('invites'), new RegExp(`…${aliceCode.slice(-4)}\\s+tester`), 'the unused code is listed with who made it');
    for (const [name, password, why] of [['alice', 'short12', 'shorter than 8'], ['alice', 'password123', 'a common password'], ['alicealice', 'AliceAlice', 'the name']]) {
      const weak = await api(null, 'POST', '/api/auth/register', { name, password, device: aliceKeys, inviteCode: aliceCode });
      assert.equal(weak.status, 400, `a password that is ${why} is refused`);
    }
    // Lowercase, spaces and no dashes still match: codes are typed by hand.
    const reg = (await api(null, 'POST', '/api/auth/register', {
      name: 'alice', password: PASSWORD, device: aliceKeys, inviteCode: ` ${aliceCode.toLowerCase().replace(/-/g, ' ')} `,
    })).json;
    assert.equal(reg.user.username, 'alice');
    assert.equal(reg.user.displayName, 'alice', 'the name is the display name');
    const alice = await newDev('alice', { id: reg.user.id, token: reg.token }, aliceKeys);
    const reused = await api(null, 'POST', '/api/auth/register', {
      name: 'mallory', password: PASSWORD, device: await makeDeviceKeys(), inviteCode: aliceCode,
    });
    assert.equal(reused.status, 403, 'a code works once');
    assert.match(cli('invites'), /No unused codes/, 'a used code is deleted');
    assert.match(inviteLog(), new RegExp(`created\\s+code …${aliceCode.slice(-4)}\\s+by=tester`), 'the log records who made the code');
    assert.match(inviteLog(), new RegExp(`used\\s+code …${aliceCode.slice(-4)}\\s+by=tester\\s+account=alice\\s+id=${reg.user.id as string}`), 'the log ties the code to the account');
    assert.ok(!inviteLog().includes(aliceCode) && !inviteLog().includes(aliceCode.replace(/-/g, '')), 'the log never holds a whole code');
    log('sign-up needs a one-time code from chatward invite; weak passwords are refused; the code is deleted and logged against the account');

    const servers = (await api(alice.token, 'GET', '/api/servers')).json.servers as { server: { id: string; ownerId: string }; channels: { id: string; name: string; kind: string }[] }[];
    assert.equal(servers.length, 1, 'there is one server');
    assert.equal(servers[0].server.ownerId, alice.user, 'the first account owns it');
    const serverId = servers[0].server.id;
    CHANNEL = servers[0].channels.find((c) => c.name === 'general' && c.kind === 'text')!.id;
    assert.equal((await api(alice.token, 'POST', '/api/servers', { name: 'S2' })).status, 404, 'servers cannot be created');
    assert.equal((await api(alice.token, 'POST', `/api/servers/${serverId}/invites`, { maxUses: 1 })).status, 404, 'in-app invites are gone');
    log('the first account gets the one server with #general; creating servers and in-app invites are gone');

    const bobKeys = await makeDeviceKeys();
    const bobReg = (await api(null, 'POST', '/api/auth/register', {
      name: 'bob', password: PASSWORD, device: bobKeys, inviteCode: signupCode(),
    })).json;
    const bob = await newDev('bob', { id: bobReg.user.id, token: bobReg.token }, bobKeys);
    // An older app sends username and a display name; the display name is ignored.
    const carolKeys = await makeDeviceKeys();
    const carolReg = (await api(null, 'POST', '/api/auth/register', {
      username: 'carol', displayName: 'Carol C', password: PASSWORD, device: carolKeys, inviteCode: signupCode(),
    })).json;
    assert.equal(carolReg.user.displayName, 'carol', 'an older app\'s display name is ignored');
    const carol = await newDev('carol', { id: carolReg.user.id, token: carolReg.token }, carolKeys);
    const members = (await api(bob.token, 'GET', '/api/servers')).json.servers[0].members as unknown[];
    assert.equal(members.length, 3, 'everyone who signs up is in the server');
    assert.equal((await api(null, 'POST', '/api/auth/register', {
      name: 'BOB', password: PASSWORD, device: await makeDeviceKeys(), inviteCode: signupCode(),
    })).status, 409, 'names are unique regardless of case');
    for (const d of [alice, bob, carol]) await uploadPool(d, 4);
    // Accounts without a password: sign-up needs only a name and a code, and sign-in uses this PC's device key.
    const danaKeys = await makeDeviceKeys();
    const danaReg = await api(null, 'POST', '/api/auth/register', { name: 'dana', device: danaKeys, inviteCode: signupCode() });
    assert.equal(danaReg.status, 200, 'signs up with only a name and a code');
    assert.equal(danaReg.json.user.displayName, 'dana', 'the display name is the name');
    assert.equal(danaReg.json.user.hasPassword, false, 'the account has no password');
    // A proof is a signature over a one-time nonce, made with the device's private key, like the PC does.
    const proofFor = async (deviceId: string) => {
      const { nonce } = (await api(null, 'GET', '/api/auth/challenge')).json as { nonce: string };
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signPrivates.get(deviceId)!, new TextEncoder().encode(`chatward-proof:${nonce}`));
      return { deviceId, nonce, signature: b64(new Uint8Array(sig)) };
    };
    const danaSignIn = await api(null, 'POST', '/api/auth/login', { name: 'dana', device: danaKeys, proof: await proofFor(danaKeys.deviceId) });
    assert.equal(danaSignIn.status, 200, 'a linked PC signs in with its key and no password');
    const danaProofOnce = await proofFor(danaKeys.deviceId);
    assert.equal((await api(null, 'POST', '/api/auth/login', { name: 'dana', device: danaKeys, proof: danaProofOnce })).status, 200);
    const replay = await api(null, 'POST', '/api/auth/login', { name: 'dana', device: danaKeys, proof: danaProofOnce });
    assert.equal(replay.status, 401, 'a proof cannot be used twice');
    const noProof = await api(null, 'POST', '/api/auth/login', { name: 'dana', device: danaKeys });
    assert.equal(noProof.status, 401, 'typing only the name is not enough');
    const strangerKeys = await makeDeviceKeys();
    const strangerSignIn = await api(null, 'POST', '/api/auth/login', { name: 'dana', device: strangerKeys, proof: await proofFor(strangerKeys.deviceId) });
    assert.equal(strangerSignIn.status, 401, 'a PC that is not linked to the account cannot sign in with a proof');
    const passwordTry = await api(null, 'POST', '/api/auth/login', { name: 'dana', password: PASSWORD, device: danaKeys });
    assert.equal(passwordTry.status, 401, 'an account without a password cannot sign in with one');
    // The first password is set from a linked PC, and it has to pass the same rules as any other password.
    const weakFirst = await api(danaSignIn.json.token, 'POST', '/api/me/password', { newPassword: 'password', deviceId: danaKeys.deviceId, proof: await proofFor(danaKeys.deviceId) });
    assert.equal(weakFirst.status, 400, 'a common first password is refused');
    const setPw = await api(danaSignIn.json.token, 'POST', '/api/me/password', { newPassword: PASSWORD, deviceId: danaKeys.deviceId, proof: await proofFor(danaKeys.deviceId) });
    assert.equal(setPw.status, 200, 'a linked PC can set the first password');
    assert.equal((await api(null, 'POST', '/api/auth/login', { name: 'dana', password: PASSWORD, device: danaKeys })).status, 200, 'the new password signs in');
    log('dana signs up with a name and a code; device-key sign-in, replay, unlinked PC and first password checked');

    log('bob and carol signed up into the server; uploaded KeyPackage pools');
    // A replace drops the unclaimed packages the device already had: carol still has 4, not 8.
    await uploadPool(carol, 4, true);
    const carolCount = await api(carol.token, 'GET', `/api/devices/${carol.id}/keypackages/count`);
    assert.equal(carolCount.json.available, 4, 'replace drops unclaimed packages before adding the new ones');
    log('replacing a pool drops the unclaimed packages it held');
    const aliceCount = await api(alice.token, 'GET', `/api/devices/${alice.id}/keypackages/count`);
    assert.equal(aliceCount.json.available, 4, 'count reports the single-use packages');
    assert.equal(typeof aliceCount.json.lastResort, 'string', 'count reports the current last-resort package');
    log('the server reports which last-resort KeyPackage it holds');

    // 1. First group creation, then add bob.
    alice.state.set(CHANNEL, await mls.createMlsGroup(CHANNEL, await newKeys(alice.id), devices));
    const [bobKp] = (await claim(alice, bob.user)).filter((k) => k.deviceId === bob.id);
    const add1 = await mls.addMembers(alice.state.get(CHANNEL)!, [bobKp.kp]);
    const r1 = await postCommit(alice, 0, add1, [alice.id, bob.id], [bob.id]);
    assert.equal(r1.status, 200, 'first commit accepted');
    assert.equal(r1.json.epoch, 1);
    alice.state.set(CHANNEL, add1.state);
    await joinFromServer(bob);
    assert.deepEqual(await mls.voiceKey(bob.state.get(CHANNEL)!), await mls.voiceKey(alice.state.get(CHANNEL)!));
    log('first group creation and add of bob via Welcome (epoch 0 to 1)');
    // 2. Race: alice and bob both add carol from epoch 1. Exactly one commit wins.
    const [carolKpA] = (await claim(alice, carol.user)).filter((k) => k.deviceId === carol.id);
    const [carolKpB] = (await claim(bob, carol.user)).filter((k) => k.deviceId === carol.id);
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
    // A second device is bound to bob's account by logging in with new device keys.
    const bob2Keys = await makeDeviceKeys();
    // Bob's first device stays connected, so it should hear about the new device as it signs in.
    const bobFrames: { t: string; deviceId?: string }[] = [];
    const bobWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(bob.token)}`);
    bobWs.onmessage = (ev) => bobFrames.push(JSON.parse(String(ev.data)));
    await new Promise<void>((resolve, reject) => {
      bobWs.onopen = () => resolve();
      bobWs.onerror = () => reject(new Error('bob could not open a socket'));
    });
    const login = await api(null, 'POST', '/api/auth/login', { username: 'bob', password: PASSWORD, device: bob2Keys });
    assert.equal(login.status, 200, 'bob logs in on a second device');
    const alerts = () => bobFrames.filter((f) => f.t === 'device.added' && f.deviceId === bob2Keys.deviceId).length;
    for (let i = 0; i < 30 && alerts() === 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alerts(), 1, 'the first device is told when a new device signs in');
    // Signing in again on the same device is not a new device, so no second alert.
    await api(null, 'POST', '/api/auth/login', { username: 'bob', password: PASSWORD, device: bob2Keys });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(alerts(), 1, 'a repeat sign-in on a known device does not alert again');
    bobWs.close();
    const bob2 = await newDev('bob2', { id: bob.user, token: login.json.token }, bob2Keys);
    await uploadPool(bob2, 4);
    const [bob2Kp] = (await claim(alice, bob.user)).filter((k) => k.deviceId === bob2.id);
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

    // `after` pages forward from a known message, oldest first, so a reconnecting client can walk up to the newest.
    for (let i = 0; i < 4; i++) {
      const r = await api(alice.token, 'POST', `/api/channels/${CHANNEL}/messages`, { ciphertext: b64(new Uint8Array([i + 1])), keyVersion: 4 });
      assert.equal(r.status, 201, 'filler message accepted');
    }
    const all = (await api(bob2.token, 'GET', `/api/channels/${CHANNEL}/messages`)).json.messages as { id: string }[];
    const page1 = (await api(bob2.token, 'GET', `/api/channels/${CHANNEL}/messages?after=${all[0].id}&limit=2`)).json.messages as { id: string }[];
    const page2 = (await api(bob2.token, 'GET', `/api/channels/${CHANNEL}/messages?after=${page1[1].id}&limit=2`)).json.messages as { id: string }[];
    assert.deepEqual([...page1, ...page2].map((m) => m.id), all.slice(1).map((m) => m.id), 'after pages through every newer message');
    assert.equal((await api(bob2.token, 'GET', `/api/channels/${CHANNEL}/messages?after=${all[0].id}&before=${all[0].id}`)).status, 400, 'after and before cannot be combined');
    log('history paging with after walks forward oldest first');

    // A resend with the same clientId returns the first copy and stores nothing new, even though its attachments are used up.
    const clientId = 'resend-check-0001';
    const first = await api(alice.token, 'POST', `/api/channels/${CHANNEL}/messages`, { ciphertext: b64(new Uint8Array([9])), keyVersion: 4, clientId });
    const again = await api(alice.token, 'POST', `/api/channels/${CHANNEL}/messages`, { ciphertext: b64(new Uint8Array([9])), keyVersion: 4, clientId });
    assert.equal(first.status, 201, 'first send accepted');
    assert.equal(again.status, 200, 'resend answered with the stored copy');
    assert.equal(again.json.message.id, first.json.message.id, 'resend returns the same message');
    const countAfter = (await api(bob2.token, 'GET', `/api/channels/${CHANNEL}/messages`)).json.messages as { id: string }[];
    assert.equal(countAfter.filter((m) => m.id === first.json.message.id).length, 1, 'the message is stored once');
    assert.equal((await api(bob2.token, 'POST', `/api/channels/${CHANNEL}/messages`, { ciphertext: b64(new Uint8Array([9])), keyVersion: 4, clientId })).status, 201, 'another author may use the same clientId');
    assert.equal((await api(alice.token, 'POST', `/api/channels/${CHANNEL}/messages`, { ciphertext: b64(new Uint8Array([9])), keyVersion: 4, clientId: 'bad id!' })).status, 400, 'malformed clientId refused');
    log('resend with the same clientId is stored once');

    // 5. Remove carol: her account is turned off and she leaves the server, then a remaining device commits the Remove.
    const kick = await api(alice.token, 'DELETE', `/api/servers/${serverId}/members/${carol.user}`);
    assert.equal(kick.status, 200, 'owner removes carol');
    assert.equal((await api(carol.token, 'GET', '/api/me')).status, 401, 'carol is signed out');
    const carolLogin = await api(null, 'POST', '/api/auth/login', { name: 'carol', password: PASSWORD, device: carolKeys });
    assert.equal(carolLogin.status, 403, 'a turned-off account cannot sign in');
    const carolLeaf = mls.memberLeaves(alice.state.get(CHANNEL)!).find((m) => m.deviceId === carol.id)!.leafIndex;
    const remove = await mls.removeMembers(alice.state.get(CHANNEL)!, [carolLeaf]);
    const r5 = await postCommit(alice, 3, remove, [alice.id, bob.id, bob2.id], []);
    assert.equal(r5.status, 200, 'remove carol');
    alice.state.set(CHANNEL, remove.state);
    bob.state.set(CHANNEL, (await mls.receive(bob.state.get(CHANNEL)!, remove.commit!)).state);
    bob2.state.set(CHANNEL, (await mls.receive(bob2.state.get(CHANNEL)!, remove.commit!)).state);
    log('kick: Remove committed for carol');

    // 6. Carol is out: a fresh message is unreadable to her, and her commits are refused.
    const after = await mls.encryptMessage(alice.state.get(CHANNEL)!, new TextEncoder().encode('secret after kick'));
    alice.state.set(CHANNEL, after.state);
    await assert.rejects(mls.receive(carol.state.get(CHANNEL)!, after.ciphertext), 'removed carol must not decrypt');
    const carolPost = await api(carol.token, 'POST', `/api/groups/${CHANNEL}/commits`, {
      deviceId: carol.id, epoch: 4, commit: b64(add1.commit!), members: [], welcomes: [],
    });
    assert.equal(carolPost.status, 401, 'removed carol cannot commit');
    const bobRead = await mls.receive(bob.state.get(CHANNEL)!, after.ciphertext);
    assert.equal(new TextDecoder().decode(bobRead.plaintext!), 'secret after kick');
    log('removed carol cannot decrypt or commit; remaining members still can');

    // 7. Stale commit at an old epoch is refused with the current epoch.
    const stale = await postCommit(bob, 0, add1, [alice.id, bob.id], [bob.id]);
    assert.equal(stale.status, 409);
    assert.equal(stale.json.currentEpoch, 4);
    log('stale commit at epoch 0 refused with 409 and currentEpoch 4');

    // 8. Moderation: revoked codes stop working; turning an account off and on, from the app and from the terminal.
    const revoked = signupCode();
    assert.match(cli('revoke', revoked.slice(-4)), /Cancelled/, 'chatward revoke takes the last 4 characters');
    assert.match(cliFails('revoke', revoked), /no unused code/, 'a revoked code is gone');
    const lateReg = await api(null, 'POST', '/api/auth/register', {
      name: 'erin', password: PASSWORD, device: await makeDeviceKeys(), inviteCode: revoked,
    });
    assert.equal(lateReg.status, 403, 'revoked code cannot be redeemed');
    assert.match(inviteLog(), new RegExp(`revoked\\s+code …${revoked.slice(-4)}\\s+by=tester`), 'the revoke is logged');
    log('a revoked code is deleted, logged and refused on sign-up');

    const daveKeys = await makeDeviceKeys();
    const daveReg = (await api(null, 'POST', '/api/auth/register', {
      name: 'dave', password: PASSWORD, device: daveKeys, inviteCode: signupCode(),
    })).json;
    const dave = { id: daveReg.user.id as string, token: daveReg.token as string };
    assert.equal((await api(bob.token, 'POST', `/api/servers/${serverId}/bans`, { userId: dave.id })).status, 403, 'a member cannot remove anyone');
    const banRes = await api(alice.token, 'POST', `/api/servers/${serverId}/bans`, { userId: dave.id });
    assert.equal(banRes.status, 200, 'owner bans dave');
    assert.equal((await api(dave.token, 'GET', '/api/servers')).status, 401, 'banned dave is signed out');
    const bans = (await api(alice.token, 'GET', `/api/servers/${serverId}/bans`)).json.bans as { user: { id: string } }[];
    assert.ok(bans.some((b) => b.user.id === dave.id), 'ban is listed');
    const unban = await api(alice.token, 'DELETE', `/api/servers/${serverId}/bans/${dave.id}`);
    assert.equal(unban.status, 200, 'owner lifts the ban');
    const daveBack = await api(null, 'POST', '/api/auth/login', { name: 'dave', password: PASSWORD, device: daveKeys });
    assert.equal(daveBack.status, 200, 'dave can sign in again after the unban');
    assert.equal((await api(daveBack.json.token, 'GET', '/api/servers')).json.servers.length, 1, 'and is back in the server');
    log('a ban turns the account off and signs it out; lifting it lets dave back in');

    assert.match(cli('remove', 'dave'), /turned off/);
    assert.equal((await api(daveBack.json.token, 'GET', '/api/me')).status, 401, 'chatward remove signs dave out');
    assert.equal((await api(null, 'POST', '/api/auth/login', { name: 'dave', password: PASSWORD, device: daveKeys })).status, 403);
    assert.match(cliFails('remove', 'alice'), /owner/, 'the owner cannot be turned off');
    assert.match(cli('users'), /dave\s+off/, 'chatward users shows dave as off');
    assert.match(cli('restore', 'dave'), /back on/);
    assert.equal((await api(null, 'POST', '/api/auth/login', { name: 'dave', password: PASSWORD, device: daveKeys })).status, 200);
    assert.match(cli('admin', 'dave'), /now an admin/);
    assert.match(cli('users'), /dave\s+admin\s+.*tester \(code …/, 'chatward users shows the role and who invited dave');
    assert.match(cli('member', 'dave'), /now a member/);
    assert.match(cliFails('reset', 'nobody'), /no account is called nobody/);
    log('chatward remove, restore, admin, member and users work on the running server');

    assert.equal((await api(alice.token, 'POST', `/api/servers/${serverId}/transfer`, { userId: bob.user })).status, 404, 'transfer is gone');
    assert.equal((await api(bob.token, 'POST', `/api/servers/${serverId}/leave`, {})).status, 404, 'leaving is gone');
    assert.equal((await api(alice.token, 'DELETE', `/api/servers/${serverId}`)).status, 404, 'deleting the server is gone');
    assert.equal((await api(alice.token, 'POST', '/api/me/delete', { password: PASSWORD })).status, 409, 'the owner account cannot be deleted');
    log('transfer, leave and delete server are gone');

    // 9. A junk Commit at epoch 4 is accepted (the server cannot verify MLS) but nobody can apply it.
    // The stuck device drops it through reset, and a valid Commit then takes its place.
    const junk = await api(bob.token, 'POST', `/api/groups/${CHANNEL}/commits`, {
      deviceId: bob.id, epoch: 4, commit: b64(new Uint8Array([1, 2, 3, 4])), members: [alice.id, bob.id, bob2.id], welcomes: [],
    });
    assert.equal(junk.status, 200, 'server accepts a junk Commit it cannot verify');
    await assert.rejects(mls.receive(alice.state.get(CHANNEL)!, new Uint8Array([1, 2, 3, 4])), 'alice cannot apply the junk');
    const carolReset = await api(carol.token, 'POST', `/api/groups/${CHANNEL}/reset`, { deviceId: carol.id, epoch: 4 });
    assert.equal(carolReset.status, 401, 'removed carol cannot reset the group');
    const otherDevice = await api(alice.token, 'POST', `/api/groups/${CHANNEL}/reset`, { deviceId: bob.id, epoch: 4 });
    assert.equal(otherDevice.status, 403, 'reset needs one of the caller\'s own devices');
    const ahead = await api(alice.token, 'POST', `/api/groups/${CHANNEL}/reset`, { deviceId: alice.id, epoch: 9 });
    assert.equal(ahead.status, 409, 'cannot reset past the current epoch');
    assert.equal(ahead.json.currentEpoch, 5);
    // Bob sent the junk Commit, so his ack of epoch 5 is his own and must not block the reset.
    const selfAck = await api(bob.token, 'POST', `/api/groups/${CHANNEL}/epoch`, { deviceId: bob.id, epoch: 5 });
    assert.equal(selfAck.status, 200, 'bob acks the epoch his own junk Commit made');
    // Bob's second device is the same user, so its ack of that Commit is his too and must not block the reset either.
    const sameUserAck = await api(bob2.token, 'POST', `/api/groups/${CHANNEL}/epoch`, { deviceId: bob2.id, epoch: 5 });
    assert.equal(sameUserAck.status, 200, 'bob\'s second device acks the epoch the junk Commit made');
    const reset =await api(alice.token, 'POST', `/api/groups/${CHANNEL}/reset`, { deviceId: alice.id, epoch: 4 });
    assert.equal(reset.status, 200, 'alice drops the junk Commit despite the author\'s own ack');
    assert.equal(reset.json.epoch, 4);
    const afterReset = await api(alice.token, 'GET', `/api/groups/${CHANNEL}/commits?from=4`);
    assert.equal(afterReset.json.epoch, 4);
    assert.equal(afterReset.json.commits.length, 0, 'the junk Commit is gone');
    // Alice kept her own state, so a valid Commit at epoch 4 is accepted and bob follows it.
    const heal = await mls.selfUpdate(alice.state.get(CHANNEL)!);
    const r8 = await postCommit(alice, 4, heal, [alice.id, bob.id, bob2.id], []);
    assert.equal(r8.status, 200, 'valid Commit accepted at epoch 4 after the reset');
    assert.equal(r8.json.epoch, 5);
    alice.state.set(CHANNEL, heal.state);
    bob.state.set(CHANNEL, (await mls.receive(bob.state.get(CHANNEL)!, heal.commit!)).state);
    const healed = await mls.encryptMessage(alice.state.get(CHANNEL)!, new TextEncoder().encode('back in sync'));
    alice.state.set(CHANNEL, healed.state);
    assert.equal(new TextDecoder().decode((await mls.receive(bob.state.get(CHANNEL)!, healed.ciphertext)).plaintext!), 'back in sync');
    log('junk Commit at epoch 4 cannot be applied; reset refused for outsiders and future epochs; after reset a valid Commit moves the group on');

    // Epoch reports: a device that applied a Commit reports it, and a reset may not drop that Commit.
    const futureAck = await api(bob.token, 'POST', `/api/groups/${CHANNEL}/epoch`, { deviceId: bob.id, epoch: 9 });
    assert.equal(futureAck.status, 409, 'a device cannot report an epoch the group has not reached');
    const bobAck = await api(bob.token, 'POST', `/api/groups/${CHANNEL}/epoch`, { deviceId: bob.id, epoch: 5 });
    assert.equal(bobAck.status, 200, 'bob reports he applied the Commit at epoch 4');
    const rewind = await api(alice.token, 'POST', `/api/groups/${CHANNEL}/reset`, { deviceId: alice.id, epoch: 4 });
    assert.equal(rewind.status, 409, 'reset refused: bob already built on the Commit at epoch 4');
    assert.equal(rewind.json.currentEpoch, 5);
    log('a reset cannot drop a Commit another device has already applied');

    // Removed devices stay in the group device list, so Commits from before their removal still verify.
    const groupDeviceList = await api(alice.token, 'GET', `/api/groups/${CHANNEL}/devices`);
    assert.ok(groupDeviceList.json.devices.some((d: DeviceKeys) => d.deviceId === carol.id), 'removed carol is still listed');
    log('removed devices stay in the group device list with their registered keys');

    // Deleting a message frees the uploads attached to it, rows and files, so the quota comes back at once.
    const chanBase = `/api/servers/${serverId}/channels`;
    const upChannel = (await api(alice.token, 'POST', chanBase, { name: 'uploads', kind: 'text' })).json.channel.id as string;
    const blob = await fetch(`${BASE}/api/uploads?tracked=1`, {
      method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(64, 7),
    });
    const uploadId = (await blob.json()).uploadId as string;
    const blobFile = path.join(dataDir, 'uploads', uploadId);
    const posted = await api(alice.token, 'POST', `/api/channels/${upChannel}/messages`, {
      ciphertext: b64(new Uint8Array([1, 2, 3])), keyVersion: 1, attachmentIds: [uploadId],
    });
    assert.equal(posted.status, 201, 'message with an attachment is posted');
    assert.ok(fs.existsSync(blobFile), 'upload file written');
    assert.equal((await api(alice.token, 'DELETE', `/api/messages/${posted.json.message.id as string}`)).status, 200);
    assert.ok(!fs.existsSync(blobFile), 'upload file removed when its message is deleted');
    assert.equal((await api(alice.token, 'GET', `/api/uploads/${uploadId}`)).status, 404, 'upload row is gone too');
    log('deleting a message frees its attached uploads from disk');

    // A server keeps at least one text channel, since voice calls take their key from the first one.
    assert.equal((await api(alice.token, 'DELETE', `${chanBase}/${upChannel}`)).status, 200, 'a text channel can go while another remains');
    assert.equal((await api(alice.token, 'DELETE', `${chanBase}/${CHANNEL}`)).status, 409, 'the last text channel is kept');
    log('deleting the last text channel is refused');

    // A voice slot left by a previous app run must not lock the account out. The startup clear frees it.
    const voiceChan = servers[0].channels.find((c) => c.kind === 'voice')!.id;
    // Alice signs in on a real second device, so the refusal below comes from a different device than the holder.
    const aliceOtherKeys = await makeDeviceKeys();
    const aliceOther = await api(null, 'POST', '/api/auth/login', { name: 'alice', password: PASSWORD, device: aliceOtherKeys });
    assert.equal(aliceOther.status, 200, 'alice logs in on a second device');
    assert.equal((await api(alice.token, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 200, 'first join gets a token');
    assert.equal((await api(aliceOther.json.token as string, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 409, 'a second device is refused while the slot is held');
    assert.equal((await api(alice.token, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 200, 'the device holding the slot can take it again');
    assert.equal((await api(alice.token, 'POST', '/api/voice/clear', {})).status, 200, 'startup clear succeeds');
    assert.equal((await api(alice.token, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 200, 'join works again after the clear');
    assert.equal((await api(alice.token, 'POST', '/api/voice/leave', { channelId: voiceChan })).status, 200);
    assert.equal((await api(alice.token, 'DELETE', `/api/me/devices/${aliceOtherKeys.deviceId}`, { password: PASSWORD })).status, 204, 'the extra alice device is removed');
    log('a leftover voice slot is cleared on startup, and the device holding it can rejoin its own call');

    // A second device refused with 409 must not end the call its first device is still in.
    assert.equal((await api(bob.token, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 200, 'bob joins on his first device');
    assert.equal((await api(bob2.token, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 409, 'bob second device is refused');
    assert.equal((await api(bob2.token, 'POST', '/api/voice/leave', { channelId: voiceChan })).status, 409, 'the refused device cannot leave the call');
    assert.equal((await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: voiceChan })).status, 200, 'the first device still holds its slot');
    assert.equal((await api(bob.token, 'POST', '/api/voice/leave', { channelId: voiceChan })).status, 200, 'the first device leaves its own call');
    log('a refused second device cannot end the first device call');

    // A socket that dropped while bob was removed from the call must not put his slot back on reconnect. The rejoin is
    // refused until he joins again, which clears the removal.
    assert.equal((await api(bob.token, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 200, 'bob joins the call');
    assert.equal((await api(alice.token, 'POST', '/api/voice/kick', { channelId: voiceChan, userId: bob.user })).status, 200, 'alice removes bob from the call');
    assert.equal((await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: voiceChan })).status, 409, 'a rejoin after a removal is refused');
    assert.equal((await api(bob.token, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 200, 'bob can join again');
    assert.equal((await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: voiceChan })).status, 200, 'rejoin works after a fresh join');
    assert.equal((await api(bob.token, 'POST', '/api/voice/leave', { channelId: voiceChan })).status, 200);
    log('a rejoin after being removed from the call is refused until the user joins again');

    // A rejoin needs a recent token for that room. A voice channel bob never joined is refused, even though he is a member.
    const sideVoice = (await api(alice.token, 'POST', chanBase, { name: 'side call', kind: 'voice' })).json.channel.id as string;
    assert.equal((await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: sideVoice })).status, 409, 'a rejoin without a token for that room is refused');
    log('a rejoin into a voice channel the user never got a token for is refused');

    // A server restart clears the voice slot but not the call. The rejoin after it puts the slot back, and a kick after that
    // must still keep removing bob from the room, because the rejoin starts the repeat for that room.
    assert.equal((await api(bob.token, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 200, 'bob joins the call');
    fakeLiveKit.members.add(`${voiceChan}:${bob.user as string}`);
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
    server = await startServer();
    assert.equal((await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: voiceChan })).status, 200, 'after a restart bob rejoins, since LiveKit still has him');
    assert.equal((await api(alice.token, 'POST', '/api/voice/kick', { channelId: voiceChan, userId: bob.user })).status, 200, 'alice kicks bob after the restart');
    assert.equal((await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: voiceChan })).status, 409, 'bob cannot rejoin after the kick');
    // The kick removes him at once. The repeat fires 20s later, so a second removal shows it kept going.
    await new Promise((resolve) => setTimeout(resolve, 21_000));
    const bobRemovals = fakeLiveKit.removals.filter((k) => k === `${voiceChan}:${bob.user as string}`).length;
    assert.ok(bobRemovals >= 2, `the kick is repeated after a restart and a rejoin (removals: ${bobRemovals})`);
    log('a kick after a restart and rejoin keeps removing the user from the room');

    // A kick LiveKit cannot confirm is recorded at once. A restart right after it must still keep bob out, even though
    // LiveKit still has him in the room.
    assert.equal((await api(bob.token, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 200, 'bob joins the call for a kick that fails');
    fakeLiveKit.members.add(`${voiceChan}:${bob.user as string}`);
    fakeLiveKit.mode = 'down';
    assert.equal((await api(alice.token, 'POST', '/api/voice/kick', { channelId: voiceChan, userId: bob.user })).status, 200, 'alice removes bob while LiveKit is down');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const exitedAfterFailedKick = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exitedAfterFailedKick;
    fakeLiveKit.mode = 'up';
    server = await startServer();
    assert.equal((await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: voiceChan })).status, 409, 'after a restart bob is still refused');
    fakeLiveKit.members.delete(`${voiceChan}:${bob.user as string}`);
    log('a kick LiveKit could not confirm is recorded at once, so a restart keeps the user out');

    // A lookup LiveKit cannot answer is 503 and the client retries. LiveKit saying "not in the room" is 409 with a code.
    assert.equal((await api(bob.token, 'POST', '/api/voice/token', { channelId: voiceChan })).status, 200, 'bob joins the call again');
    assert.equal((await api(bob.token, 'POST', '/api/voice/leave', { channelId: voiceChan })).status, 200, 'bob leaves the slot, so the next rejoin must ask LiveKit');
    fakeLiveKit.members.add(`${voiceChan}:${bob.user as string}`);
    fakeLiveKit.mode = 'down';
    const down = await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: voiceChan });
    assert.equal(down.status, 503, 'a LiveKit error is 503, not a refusal');
    assert.equal(down.json.code, 'lookup_unavailable', 'the 503 names the reason');
    fakeLiveKit.mode = 'hang';
    const slow = await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: voiceChan });
    assert.equal(slow.status, 503, 'a lookup that takes longer than the timeout is 503');
    fakeLiveKit.mode = 'up';
    fakeLiveKit.members.delete(`${voiceChan}:${bob.user as string}`);
    const gone = await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: voiceChan });
    assert.equal(gone.status, 409, 'LiveKit says bob is not in the room: 409');
    assert.equal(gone.json.code, 'not_in_room', 'the 409 carries the not_in_room code');
    fakeLiveKit.members.add(`${voiceChan}:${bob.user as string}`);
    assert.equal((await api(bob.token, 'POST', '/api/voice/rejoin', { channelId: voiceChan })).status, 200, 'once LiveKit has bob again, the rejoin works');
    assert.equal((await api(bob.token, 'POST', '/api/voice/leave', { channelId: voiceChan })).status, 200);
    log('a rejoin reports a LiveKit failure as 503 and a missing participant as 409 not_in_room');

    // Bob can list and remove his own devices. Another user's device is not his to remove.
    const bobDevices = await api(bob.token, 'GET', '/api/me/devices');
    assert.ok(bobDevices.json.devices.some((d: { deviceId: string }) => d.deviceId === bob2.id), 'bob lists his second device');
    assert.equal((await api(alice.token, 'DELETE', `/api/me/devices/${bob2.id}`, { password: PASSWORD })).status, 404, 'alice cannot remove bob\'s device');
    assert.equal((await api(bob.token, 'DELETE', `/api/me/devices/${bob2.id}`, {})).status, 403, 'removing a device needs the password');
    assert.equal((await api(bob.token, 'DELETE', `/api/me/devices/${bob2.id}`, { password: PASSWORD })).status, 204, 'bob removes his second device');
    const afterRemove = await api(bob.token, 'GET', '/api/me/devices');
    assert.ok(!afterRemove.json.devices.some((d: { deviceId: string }) => d.deviceId === bob2.id), 'removed device is no longer listed');
    assert.equal((await api(bob.token, 'GET', '/api/me')).status, 200, 'bob\'s other device stays signed in');
    const removedCount = await api(bob2.token, 'GET', `/api/devices/${bob2.id}/keypackages/count`);
    assert.equal(removedCount.status, 401, 'removed device\'s token is refused, so it can no longer use its account keys');
    const claimAfter = await claim(alice, bob.user);
    assert.ok(!claimAfter.some((k) => k.deviceId === bob2.id), 'removed device is no longer offered for new groups');
    log('a device can be listed and removed, and is then cut off from new keys');

    // A removed device's keys stay in the group's device list, so its old Commits still verify for a peer that restarts.
    // The device itself can no longer post Commits.
    const seenAfterDelete = await api(alice.token, 'GET', `/api/groups/${CHANNEL}/devices`);
    assert.ok(seenAfterDelete.json.devices.some((d: DeviceKeys) => d.deviceId === bob2.id && d.signPublic), 'deleted bob2 is still listed with its keys');
    const bob2Commit = await api(bob2.token, 'POST', `/api/groups/${CHANNEL}/commits`, {
      deviceId: bob2.id, epoch: 0, commit: b64(new Uint8Array([1, 2, 3])), members: [], welcomes: [],
    });
    assert.equal(bob2Commit.status, 401, 'removed device cannot post a Commit (its login is revoked)');
    log('a removed device keeps its keys for old Commits, but cannot post new ones');

    // Reset codes: from the owner in the app or from chatward reset. A code dies when its account is turned off.
    const ritaReg = (await api(null, 'POST', '/api/auth/register', {
      name: 'rita', password: PASSWORD, device: await makeDeviceKeys(), inviteCode: signupCode(),
    })).json;
    const issued = await api(alice.token, 'POST', `/api/servers/${serverId}/members/${ritaReg.user.id}/reset-code`, {});
    assert.equal(issued.status, 200, 'owner issues a reset code');
    const redeemed = await api(null, 'POST', '/api/auth/reset', {
      name: 'rita', code: issued.json.code, newPassword: 'rita-new-pass-0', device: await makeDeviceKeys(),
    });
    assert.equal(redeemed.status, 200, 'a code from the owner redeems');
    const fromCli = /reset code for rita: ([A-Z0-9-]{14})/.exec(cli('reset', 'rita'));
    assert.ok(fromCli, 'chatward reset prints a code');
    assert.equal((await api(null, 'POST', '/api/auth/reset', {
      name: 'rita', code: fromCli[1], newPassword: 'password123', device: await makeDeviceKeys(),
    })).status, 400, 'a reset also refuses a common password');
    const cliRedeemed = await api(null, 'POST', '/api/auth/reset', {
      name: 'rita', code: fromCli[1], newPassword: 'rita-new-pass-1', device: await makeDeviceKeys(),
    });
    assert.equal(cliRedeemed.status, 200, 'a code from chatward reset redeems');
    const reissued = /reset code for rita: ([A-Z0-9-]{14})/.exec(cli('reset', 'rita'))!;
    cli('remove', 'rita');
    const afterRemove2 = await api(null, 'POST', '/api/auth/reset', {
      name: 'rita', code: reissued[1], newPassword: 'rita-new-pass-2', device: await makeDeviceKeys(),
    });
    assert.equal(afterRemove2.status, 403, 'a code is dead once the account is turned off');
    log('reset codes work from the app and the terminal, and die when the account is turned off');

    // Expired codes are deleted and logged on the next sweep, which chatward invites runs.
    const shortCode = /New sign-up code: ([A-Z0-9-]{14})/.exec(cli('invite', '--hours', '0.0003'))![1];
    await new Promise((r) => setTimeout(r, 1500));
    assert.doesNotMatch(cli('invites'), new RegExp(shortCode.slice(-4)), 'an expired code is not listed');
    assert.match(inviteLog(), new RegExp(`expired\\s+code …${shortCode.slice(-4)}`), 'the expiry is logged');
    assert.equal((await api(null, 'POST', '/api/auth/register', {
      name: 'late', password: PASSWORD, device: await makeDeviceKeys(), inviteCode: shortCode,
    })).status, 403, 'an expired code is refused');
    log('an expired code is deleted, logged and refused');

    // Bob signs in on a third device while none of his devices are online, so nobody gets a live alert.
    // When his first device connects again, it is told about that device, but not about the second one it already saw.
    const bob3Keys = await makeDeviceKeys();
    await new Promise((r) => setTimeout(r, 20));
    const bob3Login = await api(null, 'POST', '/api/auth/login', { name: 'bob', password: PASSWORD, device: bob3Keys });
    assert.equal(bob3Login.status, 200, 'bob signs in on a third device while his other devices are offline');
    const replayFrames: { t: string; deviceId?: string }[] = [];
    const bobBack = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(bob.token)}`);
    bobBack.onmessage = (ev) => replayFrames.push(JSON.parse(String(ev.data)));
    await new Promise<void>((resolve, reject) => {
      bobBack.onopen = () => resolve();
      bobBack.onerror = () => reject(new Error('bob could not reopen a socket'));
    });
    const replayed = (deviceId: string) => replayFrames.some((f) => f.t === 'device.added' && f.deviceId === deviceId);
    for (let i = 0; i < 30 && !replayed(bob3Keys.deviceId); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(replayed(bob3Keys.deviceId), 'the device that signed in while bob was offline is announced on his next connect');
    assert.ok(!replayed(bob2Keys.deviceId), 'a device seen before the last connection is not announced again');
    bobBack.close();
    log('a sign-in made while the owner was offline is announced when they next connect');

    console.log('\nE2E MLS: all checks passed');
  } catch (err) {
    failed = true;
    console.error('\nE2E MLS FAILED:', err);
  } finally {
    server.kill();
    liveKitServer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (failed) process.exitCode = 1;
  }
}

main();
