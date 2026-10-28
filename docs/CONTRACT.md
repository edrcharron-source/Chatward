# Chatward contract (read before touching code)

Auth: `Authorization: Bearer <jwt>` on every REST call except register/login. WS: `ws://host/ws?token=<jwt>`.
All JSON. Errors: `{ "error": "message" }` with 4xx. Types live in `@chatward/shared`.

## REST (server owns; client `api/` wraps)
Auth (module `auth`)
- POST /api/auth/register {username, displayName, password, inviteCode?, device: DeviceKeys} -> {token, user}
  First user ever registered needs no invite and is allowed (becomes owner of first server). Later users need a valid invite code.
- POST /api/auth/login {username, password, device: DeviceKeys} -> {token, user}  (upserts the device keys)
- GET  /api/me -> {user}
- PATCH /api/me {displayName} -> {user}
- PUT  /api/me/avatar (raw image bytes, Content-Type image/png|jpeg|webp, <=AVATAR_MAX_BYTES) -> {user}
- GET  /api/avatars/:userId -> image bytes (public to authed users)

Servers/channels/invites (module `servers`)
- POST /api/servers {name} -> {server, channels}   (creates #general text + General voice)
- GET  /api/servers -> {servers: [{server, channels, members: Member[]}]}
- POST /api/servers/:id/channels {name, kind} (admin) -> {channel}
- POST /api/servers/:id/invites -> {code, expiresAt}  (admin; 7d, single use by default; body {maxUses?})
- POST /api/invites/:code/join {} -> {server}
- DELETE /api/servers/:id/members/:userId (admin) kicks.

Messages + keys (module `messages`)
- GET  /api/channels/:id/messages?before=<id>&limit=50 -> {messages: Message[]} (newest last)
- POST /api/channels/:id/messages {ciphertext, keyVersion} -> {message}   (server verifies membership, size)
- PATCH /api/messages/:id {ciphertext, keyVersion} (author) -> {message}
- DELETE /api/messages/:id (author or admin)
- POST /api/channels/:id/keys {envelopes: KeyEnvelope[]} -> {ok}   store + push `key.envelope` over WS
- GET  /api/channels/:id/keys?deviceId=... -> {envelopes: KeyEnvelope[]} (all versions for that device)
- GET  /api/channels/:id/key-status -> {latestVersion, devicesMissing: string[]}  (devices w/o envelope for latest)

Uploads (module `uploads`) — blobs are client-encrypted, server never sees plaintext
- POST /api/uploads (raw bytes, Content-Type application/octet-stream) -> {uploadId}
- GET  /api/uploads/:id -> bytes
Disk path: `config.uploadsDir` (env UPLOADS_DIR, default ./data/uploads) — must stay one movable directory.

Soundboard (module `soundboard`)
- GET  /api/servers/:id/sounds -> {sounds}
- POST /api/servers/:id/sounds?name=&emoji=&durationMs= (raw audio bytes, <=SOUND_MAX_BYTES; Content-Type audio/*) -> {sound}
- DELETE /api/sounds/:id (owner or admin)
- GET  /api/sounds/:id/file -> audio bytes
- POST /api/channels/:id/sound-play {soundId} -> {ok}  (broadcasts `sound.play`)

GIFs (module `gifs`) — provider KLIPY (key env KLIPY_API_KEY); no key => returns {results: [], disabled: true}
- GET /api/gifs/search?q=&pos= -> {results: [{id,url,previewUrl,title,width,height}], next?: string, disabled?: boolean}
- GET /api/gifs/trending?pos= -> same shape

Link previews (module `linkpreview`) — SSRF-safe fetch proxy used by the SENDER client only
- GET /api/linkpreview?url= -> {url,title?,description?,image?(data URL, <=300KB),siteName?}
  Must: allow http/https only, resolve DNS and block private/loopback/link-local ranges, 5s timeout, 1MB body cap, no cookies, max 3 redirects (re-validated each hop).

Desktop updates (module `updates`), public, no auth
- GET /api/version -> {serverVersion, minClientVersion, latestClientVersion}  (`MIN_CLIENT_VERSION`, `CHATWARD_VERSION`; latest from `latest.yml` in `UPDATES_DIR`)
- GET /updates/* -> static release files (latest.yml, Chatward-Setup.exe, blockmap) from `UPDATES_DIR`. See docs/UPDATES.md.

Voice (module `voice`)
- POST /api/voice/token {channelId} -> {url, token}   LiveKit JWT (room = channelId, identity = userId). Env LIVEKIT_URL (default ws://localhost:7880), optional LIVEKIT_API_URL for the server's own calls to LiveKit (kicks; default LIVEKIT_URL as http://), LIVEKIT_API_KEY, LIVEKIT_API_SECRET. Outside production the keys default to devkey/secret; with NODE_ENV=production the server refuses to start unless both are set, the secret is 32+ characters, and neither is a default.
- POST /api/voice/leave {channelId} -> {ok}
- POST /api/voice/state {channelId, muted, deafened} -> {ok}  (client reports its own mic/speaker state; muted or deafened users get 409 on sound-play)
- GET  /api/servers/:id/voice-state -> {channels: Record<channelId, userId[]>}   who is in each voice channel
  Server tracks occupancy in memory: token request = join (and leaving any other voice channel first), /leave or WS disconnect (ctx.onDisconnect) = leave.
  Every change broadcasts `voice.state` {serverId, channelId, userIds} so all members see who is in VC.
- (do not implement) GET  /api/voice/e2ee-seed/:channelId -> {key: base64}  per-channel voice media key; derived from the channel's current message key client-side instead — server returns 404 (clients must NOT rely on this).

`member.leave` {serverId,userId}: after a kick, send to remaining members AND to the kicked user (sendToUser) so their client drops the server.

`channel.update` {channel}: a channel's settings changed (voice bitrateKbps). PATCH /api/servers/:id/channels/:channelId {bitrateKbps} (admin; one of 8/16/32/64/96/128, default 64) broadcasts it; live calls re-publish at the new bitrate.

WS fan-out: server pushes ServerFrame events to every connected socket whose user is a member of the relevant server.
Server exposes `ctx.broadcastToServer(serverId, frame)` and `ctx.sendToUser(userId, frame)`.

## E2EE model (v2: MLS group + per-epoch history keys)
- Each device generates ECDH P-256 + ECDSA P-256 keypairs on first run; private keys stored in Electron safeStorage-encrypted file (renderer asks main via preload `window.chatward.secureStore`). These keys wrap history keys for new devices.
- Each text channel is one MLS group (RFC 9420, ts-mls, suite MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519). Group id = channel id. MLS identity = deviceId, so membership is per device.
- Membership changes are Commits: a kick is a Remove by a remaining member, and new devices are added by Commit with a Welcome. The server orders Commits by epoch (409 on mismatch), which gives one winner when two members commit at once. Pending removals are listed at `GET /api/servers/:id/pending-removals`.
- KeyPackages: single-use pool per device (`POST /api/devices/keypackages`, claimed with `GET /api/users/:id/keypackages`), plus one last-resort package.
- Message key for epoch E is a history key derived from the MLS exporter: `keyVersion = E + 1`. Messages: AES-GCM, random 12-byte IV, AAD = channelId|keyVersion|authorId. Wire = base64(iv||ct). The key never goes on the wire.
- History for new devices: a device that joins by Welcome gets the current key from the Welcome. Older history keys reach it as v1 envelopes (`POST /api/channels/:id/keys`) from members who already hold them. Envelope wrap is ECDH ephemeral-static → HKDF → AES-GCM, signed with ECDSA.
- Attachments: random per-file AES key, blob uploaded encrypted, key+iv inside the message payload.
- Voice/video/screen: LiveKit E2EE key = MLS exporter of the server's first text channel (label `chatward-voice`). Voice has no group of its own.
- Device verification: safety number = SHA-256 over sorted device signPublic keys, shown as 6x5 digit groups.
- Soundboard clips and avatars are NOT E2EE.

Tradeoffs (honest):
- Removal stops new messages and new epoch keys for the removed device. It does not revoke history the device already has: a removed member keeps every history key they held.
- History keys are shared with new devices, so a member who joins can read history from before they joined. That is the requested behavior.
- Trust on first use for devices: the server relays device keys. Verify safety numbers out of band to detect a substituted device.
- ts-mls has not had a formal security audit.

## Layout / ownership
packages/shared      types (lead)
packages/server/src  index.ts, db.ts, ctx.ts, ws.ts (lead); modules/<name>.ts each export `register(app: Express, ctx: Ctx): void`
packages/client/src/renderer/src
  api/        http.ts + ws.ts (lead); per-feature wrappers live beside their feature
  crypto/     E2EE module
  state/      zustand stores
  components/ one folder per feature
