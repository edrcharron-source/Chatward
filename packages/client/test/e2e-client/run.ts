// Two-device end-to-end test of the real client crypto. Starts the built server, runs two device processes
// (device.ts), and drives them over JSON lines. Run with: npm run test:e2e-client -w @chatward/client
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const here = import.meta.dirname;
const serverDir = path.resolve(here, '../../../server');
const dataDir = path.join(here, `data-${Date.now()}`);

class Device {
  private next = 1;
  private pending = new Map<number, (r: { ok: boolean; result?: any; error?: string }) => void>();
  private child: ChildProcess;

  constructor(readonly name: string) {
    this.child = spawn('node', [path.join(here, 'device.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
    readline.createInterface({ input: this.child.stdout! }).on('line', (line) => {
      const msg = JSON.parse(line) as { id: number; ok: boolean; result?: any; error?: string };
      this.pending.get(msg.id)?.(msg);
      this.pending.delete(msg.id);
    });
  }

  async call(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
    const id = this.next++;
    const reply = new Promise<{ ok: boolean; result?: any; error?: string }>((resolve) => this.pending.set(id, resolve));
    this.child.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n');
    const r = await reply;
    if (!r.ok) throw new Error(`${this.name}.${cmd}: ${r.error}`);
    return r.result;
  }

  stop(): void {
    this.child.kill();
  }
}

async function startServer(): Promise<ChildProcess> {
  fs.mkdirSync(dataDir, { recursive: true });
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

const log = (msg: string) => console.log(`  ok  ${msg}`);

/** Runs the chatward admin command against the test server. */
const chatward = (...args: string[]): string =>
  execFileSync('node', ['dist/cli.js', ...args], { cwd: serverDir, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });

/** A one-time sign-up code from `chatward invite`. */
function invite(): { code: string } {
  const m = /New sign-up code: ([A-Z0-9-]{14})/.exec(chatward('invite'));
  if (!m) throw new Error('chatward invite printed no code');
  return { code: m[1] };
}

async function main() {
  const server = await startServer();
  const alice = new Device('alice');
  const bob = new Device('bob');
  let failed = false;
  const crowd: Device[] = [];
  // Devices removed mid-scenario. They are no longer in the channel, so they stay out of crowd.
  const removed: Device[] = [];
  try {
    await alice.call('init', { serverUrl: BASE, username: 'alice' });
    await bob.call('init', { serverUrl: BASE, username: 'bob' });

    // 1. Device A signs up first, so it gets the server. Its sync creates the channel group.
    await alice.call('register', { username: 'alice', inviteCode: invite().code });
    const { serverId, channelId } = await alice.call('server');
    await alice.call('sync');
    assert.equal((await alice.call('status', { channelId })).epoch, 1, 'alice creates the group at epoch 1');
    log('alice signs up first, gets the server, and the channel group is created (epoch 1)');

    // 2. A sends a message before bob exists. Bob must read it later from history.
    await alice.call('send', { channelId, text: 'hello from alice' });
    log('alice sends a message before bob joins');

    // 3. Bob signs up with a code, receives the Welcome, and reads A's older message via history sharing.
    const { userId: bobId } = await bob.call('register', { username: 'bob', inviteCode: invite().code });
    await bob.call('sync'); // uploads bob's KeyPackages; no group yet
    await alice.call('sync'); // adds bob with a Commit and Welcome, then shares history keys with him
    await bob.call('sync'); // joins from the Welcome and accepts the history envelopes
    assert.equal((await alice.call('status', { channelId })).epoch, 2, 'bob added at epoch 2');
    assert.equal((await bob.call('status', { channelId })).epoch, 2, 'bob joined at epoch 2');
    const bobSees = (await bob.call('read', { channelId })).texts;
    assert.ok(bobSees.includes('hello from alice'), `bob reads alice's older message: ${JSON.stringify(bobSees)}`);
    log('bob signs up with a code, joins from a Welcome, and reads the older message through history sharing');

    // 4. B replies and A decrypts it.
    await bob.call('send', { channelId, text: 'hi from bob' });
    await alice.call('sync');
    const aliceSees = (await alice.call('read', { channelId })).texts;
    assert.ok(aliceSees.includes('hi from bob'), `alice reads bob's reply: ${JSON.stringify(aliceSees)}`);
    log("bob replies and alice decrypts it");

    // 4b. B posts a Commit that nobody can apply. A keeps its group, has the server drop the Commit, and the channel keeps working.
    await bob.call('junkCommit', { channelId, serverId });
    await alice.call('sync');
    assert.equal((await alice.call('status', { channelId })).epoch, 2, 'alice keeps her group at epoch 2 after the junk Commit');
    await alice.call('send', { channelId, text: 'still here after junk' });
    await bob.call('sync');
    const afterJunk = (await bob.call('read', { channelId })).texts;
    assert.ok(afterJunk.includes('still here after junk'), `bob reads after the junk Commit is dropped: ${JSON.stringify(afterJunk)}`);
    log('a junk Commit from a member is dropped by the server, and the channel keeps working');

    // 6 (before the kick, while bob is still a member). A 5 MB attachment round-trips through encryptBlob/decryptBlob.
    const sent = await alice.call('sendAttachment', { channelId, sizeBytes: 5 * 1024 * 1024 });
    const got = await bob.call('fetchAttachment', { channelId });
    assert.equal(got.size, sent.size, 'attachment size');
    assert.equal(got.sha256, sent.sha256, 'attachment bytes match');
    log('a 5 MB attachment round-trips through encryptBlob and decryptBlob');

    // 5. A removes B, which turns his account off. A remaining device commits the Remove, and B can no longer decrypt A's next message.
    const epochBefore = (await alice.call('status', { channelId })).epoch;
    await alice.call('kick', { serverId, userId: bobId });
    await alice.call('sync');
    assert.equal((await alice.call('status', { channelId })).epoch, epochBefore + 1, 'the kick commits a Remove');
    await alice.call('send', { channelId, text: 'secret after kick' });
    const { raw } = await alice.call('read', { channelId });
    const secret = raw[raw.length - 1];
    assert.equal((await alice.call('decrypt', { message: secret })).text, 'secret after kick', 'alice reads her own message');
    const bobDecrypt = await bob.call('decrypt', { message: secret });
    assert.equal(bobDecrypt.text, null, 'the kicked bob cannot decrypt the new message');
    log('alice kicks bob; a Remove is committed, and bob cannot decrypt the next message');

    // 5b. Bob's account is turned back on and he signs in again. His device still holds the group state from before the
    // kick. He must rejoin from the new Welcome, not replay the Commits he missed (which would fail and make him ask the
    // server to drop the re-add).
    chatward('restore', 'bob');
    await bob.call('login', { username: 'bob' });
    await alice.call('sync'); // re-adds bob's device with a Commit and a Welcome
    await bob.call('sync'); // bob joins from the Welcome
    const aliceEpochAfterReadd = (await alice.call('status', { channelId })).epoch;
    assert.equal((await bob.call('status', { channelId })).epoch, aliceEpochAfterReadd, 'bob rejoins at alice\'s epoch');
    await alice.call('send', { channelId, text: 'welcome back bob' });
    await bob.call('sync');
    const bobBack = (await bob.call('read', { channelId })).texts;
    assert.ok(bobBack.includes('welcome back bob'), `bob reads after rejoining: ${JSON.stringify(bobBack)}`);
    await bob.call('send', { channelId, text: 'bob is back' });
    await alice.call('sync');
    const aliceBack = (await alice.call('read', { channelId })).texts;
    assert.ok(aliceBack.includes('bob is back'), `alice reads bob after he rejoins: ${JSON.stringify(aliceBack)}`);
    log('bob is turned back on after a kick; he rejoins from the Welcome and both sides read each other again');

    // 5c. Bob is removed and restored while alice is offline, so no Remove is ever committed. Bob's device keeps its group
    // state across the leave. Rejoining from the new Welcome must still work, or bob is locked out of the channel.
    await alice.call('kick', { serverId, userId: bobId });
    chatward('restore', 'bob');
    await bob.call('login', { username: 'bob' });
    await alice.call('sync'); // alice commits the add for bob's device
    await bob.call('sync'); // bob joins from the Welcome, or applies the Commits he has not seen
    const aliceEpochAfterLeave = (await alice.call('status', { channelId })).epoch;
    assert.equal((await bob.call('status', { channelId })).epoch, aliceEpochAfterLeave, 'bob rejoins at alice\'s epoch after leaving while alice was offline');
    await alice.call('send', { channelId, text: 'after the leave and rejoin' });
    await bob.call('sync');
    const bobAfterLeave = (await bob.call('read', { channelId })).texts;
    assert.ok(bobAfterLeave.includes('after the leave and rejoin'), `bob reads after leaving and rejoining: ${JSON.stringify(bobAfterLeave)}`);
    await bob.call('send', { channelId, text: 'bob can talk again' });
    await alice.call('sync');
    const aliceAfterLeave = (await alice.call('read', { channelId })).texts;
    assert.ok(aliceAfterLeave.includes('bob can talk again'), `alice reads bob after he leaves and rejoins: ${JSON.stringify(aliceAfterLeave)}`);
    log('bob leaves and rejoins while alice is offline; he reads and sends again without being locked out');

    // 5c2. Bob stays offline while alice adds erin and then removes her, sending a message in each epoch. Bob catches up
    // through both Commits. The middle-epoch message is only readable if catch-up keeps every epoch's key, not just the last.
    const erin = new Device('erin');
    removed.push(erin);
    await erin.call('init', { serverUrl: BASE, username: 'erin' });
    const erinInvite = invite();
    const { userId: erinId } = await erin.call('register', { username: 'erin', inviteCode: erinInvite.code });
    await erin.call('sync'); // uploads erin's KeyPackages
    await alice.call('sync'); // commit: add erin
    await alice.call('send', { channelId, text: 'middle epoch message' });
    await alice.call('kick', { serverId, userId: erinId });
    await alice.call('sync'); // commit: remove erin
    await alice.call('send', { channelId, text: 'latest epoch message' });
    await bob.call('sync');
    const bobCaughtUp = (await bob.call('read', { channelId })).texts;
    assert.ok(bobCaughtUp.includes('middle epoch message'), `bob reads a message from an epoch he passed through: ${JSON.stringify(bobCaughtUp)}`);
    assert.ok(bobCaughtUp.includes('latest epoch message'), `bob reads the latest message: ${JSON.stringify(bobCaughtUp)}`);
    log('bob is offline while two Commits pass; after catching up he reads a message sent in the epoch between them');

    // 5d. Dave's KeyPackage upload reaches the server, but its reply is lost. Alice then adds dave using one of the packages
    // the server now holds. Dave must still join from that Welcome, so his device has to have saved the private parts first.
    await bob.call('init', { serverUrl: BASE, username: 'dave' });
    const daveInvite = invite();
    await bob.call('register', { username: 'dave', inviteCode: daveInvite.code });
    await bob.call('dropNextKeyPackageReply');
    await bob.call('sync'); // the upload lands on the server; the failure is logged and retried later
    await alice.call('sync'); // alice claims one of dave's packages and adds his device with a Commit and a Welcome
    await bob.call('sync'); // dave joins from the Welcome
    const aliceEpochAfterDave = (await alice.call('status', { channelId })).epoch;
    assert.equal((await bob.call('status', { channelId })).epoch, aliceEpochAfterDave, 'dave joins at alice\'s epoch after a lost upload reply');
    await alice.call('send', { channelId, text: 'hello dave' });
    await bob.call('sync');
    const daveSees = (await bob.call('read', { channelId })).texts;
    assert.ok(daveSees.includes('hello dave'), `dave reads after joining: ${JSON.stringify(daveSees)}`);
    await bob.call('send', { channelId, text: 'dave is here' });
    await alice.call('sync');
    const aliceSeesDave = (await alice.call('read', { channelId })).texts;
    assert.ok(aliceSeesDave.includes('dave is here'), `alice reads dave: ${JSON.stringify(aliceSeesDave)}`);
    log('dave\'s KeyPackage upload loses its reply; he still joins from the Welcome and both sides read each other');

    // 5e. Frank's device is added while alice's Commit reply is lost. The Commit did reach the server, so alice must
    // recognise it as her own and move on to the new epoch instead of stalling behind it.
    await bob.call('init', { serverUrl: BASE, username: 'frank' });
    const frankInvite = invite();
    await bob.call('register', { username: 'frank', inviteCode: frankInvite.code });
    await bob.call('sync');
    await alice.call('dropNextCommitReply');
    await alice.call('sync');
    const aliceEpochAfterFrank = (await alice.call('status', { channelId })).epoch;
    assert.equal(aliceEpochAfterFrank, aliceEpochAfterDave + 1, 'alice moves on after her Commit reply is lost');
    await alice.call('send', { channelId, text: 'hello frank' });
    await bob.call('sync');
    const frankSees = (await bob.call('read', { channelId })).texts;
    assert.ok(frankSees.includes('hello frank'), `frank reads after joining: ${JSON.stringify(frankSees)}`);
    log('alice\'s Commit reply is lost; she recognises the stored Commit as hers and carries on');

    // 5f. Grace's device is added, and alice's Commit is held back so she gets no answer and gives up on it. The Commit
    // then reaches the server late. Alice must adopt the step she kept, not replay her own Commit and get stuck.
    await bob.call('init', { serverUrl: BASE, username: 'grace' });
    const graceInvite = invite();
    await bob.call('register', { username: 'grace', inviteCode: graceInvite.code });
    await bob.call('sync');
    const epochBeforeGrace = (await alice.call('status', { channelId })).epoch;
    await alice.call('holdNextCommit');
    await alice.call('sync'); // alice's Commit adds grace; she waits for an answer that never comes, then keeps the step
    assert.equal((await alice.call('status', { channelId })).epoch, epochBeforeGrace, 'alice stays at her epoch while the Commit is held');
    await alice.call('sendHeldCommit'); // the Commit reaches the server late
    await alice.call('sync');
    assert.equal((await alice.call('status', { channelId })).epoch, epochBeforeGrace + 1, 'alice adopts her late Commit and moves on');
    await alice.call('send', { channelId, text: 'hello grace' });
    await bob.call('sync');
    await bob.call('sync');
    const graceSees = (await bob.call('read', { channelId })).texts;
    assert.ok(graceSees.includes('hello grace'), `grace reads after a late Commit: ${JSON.stringify(graceSees)}`);
    log('alice\'s Commit arrives after she gave up on it; she adopts the step she kept and grace can read');

    // 5g. Alice adds a channel, and the Commit that creates its group is held back, so she gives up on it. No Welcome
    // will ever come for her own group. When the Commit reaches the server late, alice must adopt the group from the
    // step she kept instead of waiting forever.
    const late = await alice.call('createChannel', { serverId, name: 'late' });
    await alice.call('holdNextCommit');
    await alice.call('sync'); // the group-creating Commit gets no answer and is kept
    assert.equal((await alice.call('status', { channelId: late.channelId })).epoch, null, 'alice has no group while the create Commit is held');
    await alice.call('sendHeldCommit'); // the create Commit reaches the server late
    await alice.call('sync');
    assert.ok((await alice.call('status', { channelId: late.channelId })).epoch >= 1, 'alice adopts her late create Commit');
    await alice.call('send', { channelId: late.channelId, text: 'creator after a late create' });
    const lateSees = (await alice.call('read', { channelId: late.channelId })).texts;
    assert.ok(lateSees.includes('creator after a late create'), `alice reads after adopting a late create: ${JSON.stringify(lateSees)}`);
    log('alice\'s create Commit arrives after she gave up on it; she adopts the group and reads her channel');

    // Ten devices join a channel that already has a group. They are added four at a time, one Commit per batch, so no
    // Commit grows past the server's body limit. Alice's Commits go out in three batches.
    const big = await alice.call('createChannel', { serverId, name: 'big' });
    await alice.call('sync');
    const bigStart = (await alice.call('status', { channelId: big.channelId })).epoch as number;
    // Each crowd member is its own device process, so alice keeps her session token.
    for (let i = 0; i < 10; i++) {
      const username = `pal${i}`;
      const { code } = invite();
      const pal = new Device(username);
      crowd.push(pal);
      await pal.call('init', { serverUrl: BASE, username });
      await pal.call('register', { username, inviteCode: code });
      await pal.call('sync'); // uploads this device's KeyPackages; the group already exists, so it does not wait for a Welcome
    }
    await alice.call('sync');
    assert.equal((await alice.call('status', { channelId: big.channelId })).epoch, bigStart + 3, 'ten devices are added in three Commits');
    await alice.call('send', { channelId: big.channelId, text: 'hello crowd' });
    for (const pal of crowd) {
      await pal.call('sync'); // joins from the Welcome
      const seen = (await pal.call('read', { channelId: big.channelId })).texts;
      assert.ok(seen.includes('hello crowd'), `${pal.name} reads after joining: ${JSON.stringify(seen)}`);
    }
    log('ten devices join one channel in batches of four and each reads the message');

    // A second account on the same PC gets its own device, and alice's group state is still there when she switches back.
    const epochOnPc = (await alice.call('status', { channelId })).epoch;
    await alice.call('init', { serverUrl: BASE, username: 'carol' });
    const carolInvite = invite();
    await alice.call('register', { username: 'carol', inviteCode: carolInvite.code });
    log('a second account on the same PC registers with its own device');
    await alice.call('init', { serverUrl: BASE, username: 'alice' });
    assert.equal((await alice.call('status', { channelId })).epoch, epochOnPc, "alice's group state survives switching accounts");
    log("switching back to the first account on the same PC keeps its group state");

    console.log('\nE2E client: all checks passed');
  } catch (err) {
    failed = true;
    console.error('\nE2E client FAILED:', err);
  } finally {
    alice.stop();
    bob.stop();
    crowd.forEach((pal) => pal.stop());
    removed.forEach((d) => d.stop());
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (failed) process.exitCode = 1;
  }
}

main();
