// Run with: npm run test:crypto -w @chatward/client
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCommit, defaultAuthenticationService, encodeMlsMessage, type ClientState } from 'ts-mls';
import {
  addMembers, createMlsGroup, cipherSuite, encryptMessage, joinFromWelcome, newMemberKeys, receive, removeMembers, selfUpdate,
  voiceKey, type DeviceDirectory, type MemberKeys,
} from './mls';
import { exportRawPublic, generateSigning, toB64, utf8 } from './primitives';

// Stands in for the server's device list: deviceId -> registered ECDSA public key.
const registered = new Map<string, string>();
const devices: DeviceDirectory = (deviceId) => registered.get(deviceId);

// Each member keeps its own ClientState; a Commit or message is applied by every member that should see it.
interface Member { name: string; keys: MemberKeys; signPrivate: CryptoKey; state?: ClientState }

async function member(name: string): Promise<Member> {
  const { privateKey, publicKey } = await generateSigning();
  registered.set(name, toB64(await exportRawPublic(publicKey)));
  return { name, signPrivate: privateKey, keys: await newMemberKeys({ deviceId: name, signPrivate: privateKey }) };
}

async function send(from: Member, text: string, others: Member[]): Promise<void> {
  const sealed = await encryptMessage(from.state!, utf8(text));
  from.state = sealed.state;
  for (const other of others) {
    const got = await receive(other.state!, sealed.ciphertext);
    other.state = got.state;
    assert.equal(Buffer.from(got.plaintext!).toString('utf8'), text, `${other.name} reads ${from.name}`);
  }
}

describe('MLS group lifecycle', () => {
  it('adds members via Commit + Welcome and exchanges messages both ways', async () => {
    const alice = await member('alice');
    const bob = await member('bob');
    alice.state = await createMlsGroup('room-1', alice.keys, devices);

    const step = await addMembers(alice.state, [bob.keys.publicPackage]);
    alice.state = step.state;
    bob.state = await joinFromWelcome(step.welcome!, bob.keys, devices);

    await send(alice, 'hi bob', [bob]);
    await send(bob, 'hi alice', [alice]);
  });

  it('a later joiner is added by an existing member and sees only messages after joining', async () => {
    const alice = await member('alice');
    const bob = await member('bob');
    const carol = await member('carol');
    alice.state = await createMlsGroup('room-2', alice.keys, devices);
    const first = await addMembers(alice.state, [bob.keys.publicPackage]);
    alice.state = first.state;
    bob.state = await joinFromWelcome(first.welcome!, bob.keys, devices);

    await send(alice, 'before carol', [bob]);

    // Bob commits the add, so Alice has to process a Commit from a non-creator.
    const second = await addMembers(bob.state, [carol.keys.publicPackage]);
    bob.state = second.state;
    alice.state = (await receive(alice.state!, second.commit!)).state;
    carol.state = await joinFromWelcome(second.welcome!, carol.keys, devices);

    await send(bob, 'hi carol', [alice, carol]);
  });

  it('a removed member cannot decrypt anything from the epoch after removal', async () => {
    const alice = await member('alice');
    const bob = await member('bob');
    const carol = await member('carol');
    alice.state = await createMlsGroup('room-3', alice.keys, devices);
    const added = await addMembers(alice.state, [bob.keys.publicPackage, carol.keys.publicPackage]);
    alice.state = added.state;
    bob.state = await joinFromWelcome(added.welcome!, bob.keys, devices);
    carol.state = await joinFromWelcome(added.welcome!, carol.keys, devices);

    // Leaves: 0 = alice, 1 = bob, 2 = carol.
    const removal = await removeMembers(alice.state, [2]);
    alice.state = removal.state;
    bob.state = (await receive(bob.state!, removal.commit!)).state;

    await send(alice, 'carol is gone', [bob]);

    const sealed = await encryptMessage(alice.state!, utf8('secret after removal'));
    await assert.rejects(receive(carol.state!, sealed.ciphertext), 'removed member must not decrypt');
  });

  it('the voice key changes every epoch and matches across members', async () => {
    const alice = await member('alice');
    const bob = await member('bob');
    alice.state = await createMlsGroup('room-4', alice.keys, devices);
    const added = await addMembers(alice.state, [bob.keys.publicPackage]);
    alice.state = added.state;
    bob.state = await joinFromWelcome(added.welcome!, bob.keys, devices);

    const before = await voiceKey(alice.state!);
    assert.deepEqual(await voiceKey(bob.state!), before);

    const rotated = await selfUpdate(bob.state!);
    bob.state = rotated.state;
    alice.state = (await receive(alice.state!, rotated.commit!)).state;
    const after = await voiceKey(alice.state!);

    assert.equal(after.length, 32);
    assert.notDeepEqual(after, before);
    assert.deepEqual(await voiceKey(bob.state!), after);
  });
});

describe('ghost leaves', () => {
  it('blocks an honest Add of a KeyPackage that claims another device', async () => {
    const alice = await member('alice');
    const bob = await member('bob');
    const mallory = await member('mallory');
    alice.state = await createMlsGroup('room-5', alice.keys, devices);
    const first = await addMembers(alice.state, [mallory.keys.publicPackage]);
    alice.state = first.state;
    mallory.state = await joinFromWelcome(first.welcome!, mallory.keys, devices);

    // Mallory's KeyPackage names bob's device, but only bob's device key can vouch for that name.
    const ghost = await newMemberKeys({ deviceId: bob.name, signPrivate: mallory.signPrivate });
    await assert.rejects(addMembers(alice.state!, [ghost.publicPackage]), 'Add must reject a ghost leaf');
  });

  it('honest members reject a Commit that smuggles in a ghost leaf', async () => {
    const alice = await member('alice');
    const bob = await member('bob');
    const mallory = await member('mallory');
    alice.state = await createMlsGroup('room-6', alice.keys, devices);
    const added = await addMembers(alice.state, [bob.keys.publicPackage, mallory.keys.publicPackage]);
    alice.state = added.state;
    bob.state = await joinFromWelcome(added.welcome!, bob.keys, devices);
    mallory.state = await joinFromWelcome(added.welcome!, mallory.keys, devices);

    // Mallory skips her own checks, as a modified client would, and commits a ghost leaf for bob's device.
    const ghost = await newMemberKeys({ deviceId: bob.name, signPrivate: mallory.signPrivate });
    const lax = { ...mallory.state!, clientConfig: { ...mallory.state!.clientConfig, authService: defaultAuthenticationService } };
    const forged = await createCommit(
      { state: lax, cipherSuite: await cipherSuite() },
      { extraProposals: [{ proposalType: 'add', add: { keyPackage: ghost.publicPackage } }], ratchetTreeExtension: true },
    );
    await assert.rejects(receive(alice.state!, encodeMlsMessage(forged.commit)), 'alice must reject the forged Commit');
    await assert.rejects(receive(bob.state!, encodeMlsMessage(forged.commit)), 'bob must reject the forged Commit');
  });
});
