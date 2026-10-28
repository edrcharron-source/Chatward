// Two-device end-to-end test of the real client crypto. Starts the built server, runs two device processes
// (device.ts), and drives them over JSON lines. Run with: npm run test:e2e-client -w @chatward/client
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
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

    // 1. Device A registers as the first user and creates a server. Its sync creates the channel group.
    await alice.call('register', { username: 'alice' });
    const { serverId, channelId } = await alice.call('createServer', { name: 'S' });
    await alice.call('sync');
    assert.equal((await alice.call('status', { channelId })).epoch, 1, 'alice creates the group at epoch 1');
    log('alice registers, creates the server, and the channel group is created (epoch 1)');

    // 2. A sends a message before bob exists. Bob must read it later from history.
    await alice.call('send', { channelId, text: 'hello from alice' });
    log('alice sends a message before bob joins');

    // 3. Bob joins through an invite, receives the Welcome, and reads A's older message via history sharing.
    const { code } = await alice.call('invite', { serverId });
    const { userId: bobId } = await bob.call('register', { username: 'bob', inviteCode: code });
    await bob.call('sync'); // uploads bob's KeyPackages; no group yet
    await alice.call('sync'); // adds bob with a Commit and Welcome, then shares history keys with him
    await bob.call('sync'); // joins from the Welcome and accepts the history envelopes
    assert.equal((await alice.call('status', { channelId })).epoch, 2, 'bob added at epoch 2');
    assert.equal((await bob.call('status', { channelId })).epoch, 2, 'bob joined at epoch 2');
    const bobSees = (await bob.call('read', { channelId })).texts;
    assert.ok(bobSees.includes('hello from alice'), `bob reads alice's older message: ${JSON.stringify(bobSees)}`);
    log('bob joins through an invite and a Welcome, and reads the older message through history sharing');

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

    // 5. A kicks B. A remaining device commits the Remove, and B can no longer decrypt A's next message.
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

    // 5b. Alice re-invites bob. His device still holds the group state from before the kick. He must rejoin from the new
    // Welcome, not replay the Commits he missed (which would fail and make him ask the server to drop the re-add).
    const reinvite = await alice.call('invite', { serverId });
    await bob.call('joinInvite', { code: reinvite.code });
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
    log('bob is re-invited after a kick; he rejoins from the Welcome and both sides read each other again');

    // 5c. Bob leaves and rejoins while alice is offline, so no Remove is ever committed. Bob's device keeps its group
    // state across the leave. Rejoining from the new Welcome must still work, or bob is locked out of the channel.
    await alice.call('kick', { serverId, userId: bobId });
    const leaveReinvite = await alice.call('invite', { serverId });
    await bob.call('joinInvite', { code: leaveReinvite.code });
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
    const erinInvite = await alice.call('invite', { serverId });
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
    const daveInvite = await alice.call('invite', { serverId });
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

    // Ten devices join a channel that already has a group. They are added four at a time, one Commit per batch, so no
    // Commit grows past the server's body limit. Alice's Commits (1 -> 4) go out in three batches.
    const big = await alice.call('createServer', { name: 'Big' });
    await alice.call('sync');
    // Each crowd member is its own device process, so alice keeps her session token.
    for (let i = 0; i < 10; i++) {
      const username = `pal${i}`;
      const { code } = await alice.call('invite', { serverId: big.serverId });
      const pal = new Device(username);
      crowd.push(pal);
      await pal.call('init', { serverUrl: BASE, username });
      await pal.call('register', { username, inviteCode: code });
      await pal.call('sync'); // uploads this device's KeyPackages; the group already exists, so it does not wait for a Welcome
    }
    await alice.call('sync');
    assert.equal((await alice.call('status', { channelId: big.channelId })).epoch, 4, 'ten devices are added in three Commits');
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
    const carolInvite = await alice.call('invite', { serverId });
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
