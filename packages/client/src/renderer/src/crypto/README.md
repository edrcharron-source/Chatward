# Chatward E2EE (crypto module)

Group membership and epoch keys use MLS (RFC 9420) via `mls.ts`, which wraps [ts-mls](https://www.npmjs.com/package/ts-mls). Everything else is WebCrypto (`crypto.subtle`). The contract with the server and the full model are in `docs/CONTRACT.md`.

## Files
- `mls.ts`: pure MLS group functions over ts-mls: create, add, remove, Welcome join, application messages, per-epoch history key, voice key, state and KeyPackage (de)serialization.
- `index.ts`: the app-facing API (`syncChannelKeys`, `encryptPayload`, `decryptMessage`, `voiceKey`, ...). Keeps the state in a vault saved through `window.chatward.secureStore`.
- `envelope.ts`: wraps history keys for a device (ECDH ephemeral-static → HKDF → AES-GCM, signed with ECDSA).
- `primitives.ts`, `safety.ts`: WebCrypto helpers and safety numbers.

## Primitives
- Device identity: ECDH P-256 and ECDSA P-256, one pair per device. Private keys in `secureStore` as JWK.
- MLS suite: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. ts-mls is not audited.
- Message key for epoch E: `keyVersion = E + 1`, derived from the MLS exporter (label `chatward-history`). Messages: AES-256-GCM, random 12-byte IV, AAD = `channelId|keyVersion|authorId`.
- Voice: LiveKit E2EE key = MLS exporter (label `chatward-voice`) of the server's first text channel.
- Attachments: a fresh AES-256-GCM key and IV per blob, inside the message payload.
- Safety number: SHA-256 over the sorted device signing keys, six groups of five digits.

## Lifecycle
1. **Keys**: each device keeps a pool of single-use KeyPackages on the server (refilled below 5), plus one last-resort package. Private parts stay in the vault.
2. **Group**: a channel's group is created by the first device that finds no commits and no Welcome. The creator commits at epoch 0 and adds every other member device it can claim a KeyPackage for. A 409 means another device won, so this device joins by Welcome.
3. **Join**: a device with a Welcome for its KeyPackage joins at that epoch and derives the current history key.
4. **Follow**: every sync applies Commits from the local epoch on. Commits are checked against every device that has ever been in the group, so a member who left still verifies. A Commit that will not apply is dropped with `/reset`, unless another device has already built on it. If the server reports an epoch behind ours, the local group is forgotten and rebuilt from a Welcome.
5. **Reconcile**: a device removes group members the server no longer lists, then adds server devices the group lacks. Each change is one Commit.
6. **History**: members send every history key they hold to devices that have not received them yet, as v1 envelopes. Devices that left the server are forgotten.
7. **Kick**: `handleMemberLeave` runs the sync without the removed user, so a remaining member commits the Remove.

## Threat model (v2, honest)
- Protects message and attachment contents, and voice media, from the server and from anyone without a member device's keys.
- Forward secrecy for new messages: after a Remove, the removed device gets no new epoch keys.
- Removal does not revoke history. A removed member keeps every history key they already had, so they can read messages from before their removal.
- New devices read history from before they joined, by design. Members share history keys with them, so any member who holds a key can help a new device read it.
- Trust on first use for devices: a compromised server could substitute a device. Verify safety numbers out of band.
- The server still sees metadata: channel ids, author ids, timestamps, message sizes, and who is in which voice channel.
- ts-mls has not had a formal security audit.

## Tests
- `npm run test:crypto -w @chatward/client`: `crypto.test.ts` (primitives, envelopes, safety number) and `mls.test.ts` (join, Commit from a non-creator, removed member cannot decrypt, voice key rotates per epoch).
- The server side is covered by `npm run test:e2e -w @chatward/server`, which runs the real HTTP API: race, second device by Welcome, message round trip, kick, stale commit.
- The client flow in `index.ts` (sync, reconcile, history sharing) is not covered by an automated test yet.
