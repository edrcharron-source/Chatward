# Chatward E2EE (crypto module)

Everything here is WebCrypto (`crypto.subtle`). No hand-rolled primitives.

## Primitives
- Device identity: ECDH P-256 (key agreement) and ECDSA P-256 (signing), one pair per device, created on first run.
- Private keys live in `window.chatward.secureStore` as JWK. The main process encrypts that file with Electron `safeStorage`. They are re-imported as non-extractable keys.
- Channel key: random AES-256-GCM key per channel and version.
- Key wrap: ephemeral-static ECDH, HKDF-SHA-256 (salt = ephemeral pub || recipient pub, info = envelope header), then AES-256-GCM. The header binds channel, version, sender and recipient device ids.
- Envelope signature: ECDSA P-256 over the header and wrapped bytes. A receiver accepts an envelope only if the sender device is in the member directory and the signature verifies.
- Messages: AES-256-GCM, random 12-byte IV, AAD = `channelId|keyVersion|authorId`. Wire format is base64(iv || ciphertext+tag).
- Attachments: a fresh AES-256-GCM key and IV per blob. The key and IV travel inside the encrypted message payload.
- Voice: LiveKit E2EE key = HKDF-SHA-256 of the latest channel key, info `chatward-voice`, salt = channel id.
- Safety number: SHA-256 over the sorted device signing keys, shown as six groups of five digits.

## Key lifecycle
1. The first device to sync a channel with no server key creates version 1 and wraps it for every member device.
2. Any device that holds the latest version wraps it (and older versions) for member devices the server reports as missing it. A new device therefore gets full history from any online member.
3. When a device leaves the server, the next sync by a device that holds the latest version rotates the channel to version N+1 and wraps it only for remaining devices. Removed devices keep the old keys they already had.

## Threat model (v1, honest)
Protects message and attachment contents, and voice media, from the server and from anyone without a member device's keys. The server still sees metadata: channel ids, author ids, timestamps, message sizes, who is in which voice channel.

Known limits:
- **Trust on first use for devices.** The server relays each member's device list. A compromised server could add an attacker device to a member and receive the channel keys. Verify the safety number out of band to detect this. Nothing in the client detects it automatically.
- **No forward secrecy for history.** A removed member keeps the keys they already had, so they can still read messages from before their removal. Rotation only protects future messages.
- **Concurrent first key.** If two devices create version 1 at the same moment, the server may store two different version-1 keys. Messages sealed under one will not open for the other. Retry by reloading after the envelopes settle.
- **Voice uses only the latest version.** A participant still on an older version cannot join voice until it syncs.
- **New devices wait for a sync.** A brand-new device cannot read history until an online member syncs and wraps the keys for it.
- Soundboard clips and avatars are not E2EE in v1 (per CONTRACT).
- v2 plan: migrate group key management to MLS (OpenMLS), which adds forward secrecy and authenticated membership changes.

## Tests
`npm run test:crypto -w @chatward/client` runs `crypto.test.ts` with `node --test` (round trip, AAD and tamper detection, envelope signatures and addressing, rotation, voice key separation, safety number).
