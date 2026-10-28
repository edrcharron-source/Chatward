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
  try {
    await alice.call('init', { serverUrl: BASE });
    await bob.call('init', { serverUrl: BASE });

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

    console.log('\nE2E client: all checks passed');
  } catch (err) {
    failed = true;
    console.error('\nE2E client FAILED:', err);
  } finally {
    alice.stop();
    bob.stop();
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (failed) process.exitCode = 1;
  }
}

main();
