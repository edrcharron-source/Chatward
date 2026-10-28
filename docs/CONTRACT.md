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

Voice (module `voice`)
- POST /api/voice/token {channelId} -> {url, token}   LiveKit JWT (room = channelId, identity = userId). Env LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (defaults devkey/secret/ws://localhost:7880).
- POST /api/voice/leave {channelId} -> {ok}
- GET  /api/servers/:id/voice-state -> {channels: Record<channelId, userId[]>}   who is in each voice channel
  Server tracks occupancy in memory: token request = join (and leaving any other voice channel first), /leave or WS disconnect (ctx.onDisconnect) = leave.
  Every change broadcasts `voice.state` {serverId, channelId, userIds} so all members see who is in VC.
- (do not implement) GET  /api/voice/e2ee-seed/:channelId -> {key: base64}  per-channel voice media key; derived from the channel's current message key client-side instead — server returns 404 (clients must NOT rely on this).

WS fan-out: server pushes ServerFrame events to every connected socket whose user is a member of the relevant server.
Server exposes `ctx.broadcastToServer(serverId, frame)` and `ctx.sendToUser(userId, frame)`.

## E2EE model (v1, honest)
- Each device generates ECDH P-256 + ECDSA P-256 keypairs on first run; private keys stored in Electron safeStorage-encrypted file (renderer asks main via preload `window.chatward.secureStore`).
- Each text channel has a random AES-256-GCM key (versioned). Any member device holding the key can create a new version and wrap it for every member device (ECDH ephemeral-static → HKDF → AES-GCM wrap), signed with ECDSA. Rotate on member kick.
- Messages: AES-GCM, random 12-byte IV, AAD = channelId|keyVersion|authorId. Wire = base64(iv||ct).
- Attachments: random per-file AES key, blob uploaded encrypted, key+iv inside the message payload.
- Voice/video/screen: LiveKit E2EE with a key derived from the channel key (HKDF info "chatward-voice").
- Device verification: safety number = SHA-256 over sorted device signPublic keys, shown as 6x5 digit groups.
- Planned v2: migrate group key mgmt to MLS (OpenMLS). Soundboard clips + avatars are NOT E2EE in v1.

## Layout / ownership
packages/shared      types (lead)
packages/server/src  index.ts, db.ts, ctx.ts, ws.ts (lead); modules/<name>.ts each export `register(app: Express, ctx: Ctx): void`
packages/client/src/renderer/src
  api/        http.ts + ws.ts (lead); per-feature wrappers live beside their feature
  crypto/     E2EE module
  state/      zustand stores
  components/ one folder per feature
