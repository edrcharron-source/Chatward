// End-to-end MLS check against a real server process (real HTTP, real SQLite) using the public API only:
// register with invites, login for a second device, server and channel creation, kick, and Commit delivery.
// Run with: npm run test:e2e -w @chatward/server
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as mls from '../../client/src/renderer/src/crypto/mls';
import { exportRawPublic, generateEcdh, generateSigning, toB64 } from '../../client/src/renderer/src/crypto/primitives';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct-horse-1';
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
    const keys = await newKeys(dev.id);
    const kp = await mls.encodeKeyPackage(keys);
    items.push({ kp, lastResort: i === singleUse });
    made.push([kp, keys]);
  }
  const r = await api(dev.token, 'POST', '/api/devices/keypackages', { deviceId: dev.id, keyPackages: items });
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
  const server = await startServer();
  let failed = false;
  try {
    // Accounts go through the real API. The first user needs no invite and owns the server.
    const aliceKeys = await makeDeviceKeys();
    const reg = (await api(null, 'POST', '/api/auth/register', {
      username: 'alice', displayName: 'Alice', password: PASSWORD, device: aliceKeys,
    })).json;
    const alice = await newDev('alice', { id: reg.user.id, token: reg.token }, aliceKeys);
    const srv = (await api(alice.token, 'POST', '/api/servers', { name: 'S' })).json;
    const channel = (srv.channels as { id: string; name: string; kind: string }[]).find((c) => c.name === 'general' && c.kind === 'text')!;
    const serverId: string = srv.server.id;
    CHANNEL = channel.id;
    const invite = async (uses: number) => (await api(alice.token, 'POST', `/api/servers/${serverId}/invites`, { maxUses: uses })).json.code as string;

    const bobKeys = await makeDeviceKeys();
    const bobReg = (await api(null, 'POST', '/api/auth/register', {
      username: 'bob', displayName: 'Bob', password: PASSWORD, device: bobKeys, inviteCode: await invite(1),
    })).json;
    const bob = await newDev('bob', { id: bobReg.user.id, token: bobReg.token }, bobKeys);

    const carolKeys = await makeDeviceKeys();
    const carolReg = (await api(null, 'POST', '/api/auth/register', {
      username: 'carol', displayName: 'Carol', password: PASSWORD, device: carolKeys, inviteCode: await invite(1),
    })).json;
    const carol = await newDev('carol', { id: carolReg.user.id, token: carolReg.token }, carolKeys);
    for (const d of [alice, bob, carol]) await uploadPool(d, 4);
    log('registered alice (owner), bob and carol through invites; uploaded KeyPackage pools');

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
    const login = await api(null, 'POST', '/api/auth/login', { username: 'bob', password: PASSWORD, device: bob2Keys });
    assert.equal(login.status, 200, 'bob logs in on a second device');
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

    // 5. Kick carol: the server removes her membership, then a remaining device commits the Remove.
    const kick = await api(alice.token, 'DELETE', `/api/servers/${serverId}/members/${carol.user}`);
    assert.equal(kick.status, 200, 'owner kicks carol');
    const pending = await api(alice.token, 'GET', `/api/servers/${serverId}/pending-removals`);
    assert.deepEqual(pending.json.pending, [{ channelId: CHANNEL, epoch: 3, removedDeviceIds: [carol.id] }]);
    const carolLeaf = mls.memberLeaves(alice.state.get(CHANNEL)!).find((m) => m.deviceId === carol.id)!.leafIndex;
    const remove = await mls.removeMembers(alice.state.get(CHANNEL)!, [carolLeaf]);
    const r5 = await postCommit(alice, 3, remove, [alice.id, bob.id, bob2.id], []);
    assert.equal(r5.status, 200, 'remove carol');
    alice.state.set(CHANNEL, remove.state);
    bob.state.set(CHANNEL, (await mls.receive(bob.state.get(CHANNEL)!, remove.commit!)).state);
    bob2.state.set(CHANNEL, (await mls.receive(bob2.state.get(CHANNEL)!, remove.commit!)).state);
    assert.equal((await api(alice.token, 'GET', `/api/servers/${serverId}/pending-removals`)).json.pending.length, 0);
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

    // 8. Moderation: revoked invites stop working, bans block rejoin until lifted.
    const revoked = await invite(1);
    const revokeRes = await api(alice.token, 'DELETE', `/api/servers/${serverId}/invites/${revoked}`);
    assert.equal(revokeRes.status, 200, 'owner revokes an invite');
    const listed = (await api(alice.token, 'GET', `/api/servers/${serverId}/invites`)).json.invites as { code: string }[];
    assert.ok(!listed.some((i) => i.code === revoked), 'revoked invite is no longer listed');
    const lateReg = await api(null, 'POST', '/api/auth/register', {
      username: 'erin', displayName: 'Erin', password: PASSWORD, device: await makeDeviceKeys(), inviteCode: revoked,
    });
    assert.equal(lateReg.status, 403, 'revoked invite cannot be redeemed');
    log('revoked invite listed as gone and refused on register');

    const daveReg = (await api(null, 'POST', '/api/auth/register', {
      username: 'dave', displayName: 'Dave', password: PASSWORD, device: await makeDeviceKeys(), inviteCode: await invite(5),
    })).json;
    const dave = { id: daveReg.user.id as string, token: daveReg.token as string };
    const banRes = await api(alice.token, 'POST', `/api/servers/${serverId}/bans`, { userId: dave.id });
    assert.equal(banRes.status, 200, 'owner bans dave');
    const daveServers = (await api(dave.token, 'GET', '/api/servers')).json.servers as { server: { id: string } }[];
    assert.ok(!daveServers.some((b) => b.server.id === serverId), 'banned dave is removed from the server');
    const rejoin = await api(dave.token, 'POST', `/api/invites/${await invite(5)}/join`, {});
    assert.equal(rejoin.status, 403, 'banned dave cannot rejoin with a fresh invite');
    const bans = (await api(alice.token, 'GET', `/api/servers/${serverId}/bans`)).json.bans as { user: { id: string } }[];
    assert.ok(bans.some((b) => b.user.id === dave.id), 'ban is listed');
    log('ban removes dave and blocks a fresh invite; ban listed for admins');

    const unban = await api(alice.token, 'DELETE', `/api/servers/${serverId}/bans/${dave.id}`);
    assert.equal(unban.status, 200, 'owner lifts the ban');
    const back = await api(dave.token, 'POST', `/api/invites/${await invite(5)}/join`, {});
    assert.equal(back.status, 200, 'dave can join again after unban');
    log('unban lets dave rejoin with an invite');

    // Ownership transfer: only the owner can hand it over, and the old owner drops to admin.
    const notOwner = await api(bob.token, 'POST', `/api/servers/${serverId}/transfer`, { userId: bob.user });
    assert.equal(notOwner.status, 403, 'a non-owner cannot transfer');
    const handOver = await api(alice.token, 'POST', `/api/servers/${serverId}/transfer`, { userId: bob.user });
    assert.equal(handOver.status, 200, 'owner hands the server to bob');
    const aliceAgain = await api(alice.token, 'POST', `/api/servers/${serverId}/transfer`, { userId: alice.user });
    assert.equal(aliceAgain.status, 403, 'former owner can no longer transfer');
    const handBack = await api(bob.token, 'POST', `/api/servers/${serverId}/transfer`, { userId: alice.user });
    assert.equal(handBack.status, 200, 'new owner can hand it back');
    log('ownership transfer is owner-only, moves the owner role, and can be handed back');

    // 9. A junk Commit at epoch 4 is accepted (the server cannot verify MLS) but nobody can apply it.
    // The stuck device drops it through reset, and a valid Commit then takes its place.
    const junk = await api(bob.token, 'POST', `/api/groups/${CHANNEL}/commits`, {
      deviceId: bob.id, epoch: 4, commit: b64(new Uint8Array([1, 2, 3, 4])), members: [alice.id, bob.id, bob2.id], welcomes: [],
    });
    assert.equal(junk.status, 200, 'server accepts a junk Commit it cannot verify');
    await assert.rejects(mls.receive(alice.state.get(CHANNEL)!, new Uint8Array([1, 2, 3, 4])), 'alice cannot apply the junk');
    const carolReset = await api(carol.token, 'POST', `/api/groups/${CHANNEL}/reset`, { deviceId: carol.id, epoch: 4 });
    assert.equal(carolReset.status, 404, 'removed carol cannot reset the group');
    const otherDevice = await api(alice.token, 'POST', `/api/groups/${CHANNEL}/reset`, { deviceId: bob.id, epoch: 4 });
    assert.equal(otherDevice.status, 403, 'reset needs one of the caller\'s own devices');
    const ahead = await api(alice.token, 'POST', `/api/groups/${CHANNEL}/reset`, { deviceId: alice.id, epoch: 9 });
    assert.equal(ahead.status, 409, 'cannot reset past the current epoch');
    assert.equal(ahead.json.currentEpoch, 5);
    const reset = await api(alice.token, 'POST', `/api/groups/${CHANNEL}/reset`, { deviceId: alice.id, epoch: 4 });
    assert.equal(reset.status, 200, 'alice drops the junk Commit');
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

    // Deleting a server removes its soundboard audio from disk, not just the database rows.
    const doomedId = (await api(alice.token, 'POST', '/api/servers', { name: 'Doomed' })).json.server.id as string;
    const oggFile = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)]);
    const upload = await fetch(`${BASE}/api/servers/${doomedId}/sounds?name=boop&emoji=x&durationMs=500`, {
      method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'audio/ogg' }, body: oggFile,
    });
    const soundId = (await upload.json()).sound.id as string;
    const soundFile = path.join(dataDir, 'sounds', soundId);
    assert.ok(fs.existsSync(soundFile), 'sound file written for the doomed server');
    assert.equal((await api(alice.token, 'DELETE', `/api/servers/${doomedId}`)).status, 200);
    assert.ok(!fs.existsSync(soundFile), 'sound file removed when its server is deleted');
    log('deleting a server removes its soundboard files from disk');

    // A server keeps at least one text channel, since voice calls take their key from the first one.
    const chanServer = (await api(alice.token, 'POST', '/api/servers', { name: 'Chan' })).json;
    const chanBase = `/api/servers/${chanServer.server.id as string}/channels`;
    const onlyText = chanServer.channels.find((c: { kind: string }) => c.kind === 'text').id as string;
    assert.equal((await api(alice.token, 'DELETE', `${chanBase}/${onlyText}`)).status, 409, 'last text channel is kept');
    const extraText = (await api(alice.token, 'POST', chanBase, { name: 'extra', kind: 'text' })).json.channel.id as string;
    assert.equal((await api(alice.token, 'DELETE', `${chanBase}/${onlyText}`)).status, 200, 'a text channel can go while another remains');
    assert.equal((await api(alice.token, 'DELETE', `${chanBase}/${extraText}`)).status, 409, 'the new last text channel is kept');
    log('deleting the last text channel is refused');

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
