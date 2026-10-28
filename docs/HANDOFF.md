# Integrator handoff (as of v0.1.6)

## State
- `main` is green: `npm run typecheck`, `npm run test:crypto -w @chatward/client` (19), `npm run test:e2e -w @chatward/server` (8), `npm run test:e2e-client -w @chatward/client` (6 steps).
- Latest release: v0.1.6 (Chatward-Setup.exe + chatward-server.zip). Releases are cut with the "Release" workflow (`workflow_dispatch`, input `tag`); it builds the Windows installer and server bundle and publishes a GitHub Release. Cut a new tag every time; never reuse one.
- Repo is private. Ed downloads from the Releases page while logged in.
- No open PRs at handoff.

## How to integrate
1. Merge each PR locally first (`git merge pr`), run typecheck + tests, build the client (`npm run build -w @chatward/client`), then merge on GitHub (squash).
2. Test the demo in headless Chromium: serve `packages/client/out/renderer`, shim `window.chatward` (secureStore/getScreenSources/selectScreenSource), click "Try demo". No console errors expected.
3. Release only after merging everything that's ready; a release published before the last PR landed needs a new tag.

## Open items
- **Bitrate per voice channel**: shared types (`Channel.bitrateKbps`, `channel.update`) and App handling are on main; demo + admin dialog (#26, #27) merged. Still to land: server PATCH `/api/servers/:id/channels/:channelId` + DB column (server-auth), and the client publish side using `bitrateKbps` (voice-core). Both were waiting on Ed's push-branch decision.
- **Auto-update and version checks** (proposed to Ed, he said yes): server serves `/updates` (electron-updater generic provider, `latest.yml` + installer), `/api/version` handshake with minimum client version, release workflow uploads artifacts to the server, update script with DB backup and rollback. Nothing exists yet; there is no updater and no version check.
- **Real-server mode in the packaged app is untested** on Windows: LiveKit voice, camera, screen share, soundboard into a call, system audio loopback, MLS in Electron. Only the demo was exercised, in headless Chromium.
- **Docker server bundle untested**: `deploy/bundle` (`start-server.bat`, compose, Dockerfile) was never run with a real Docker daemon. `npm ci` for the server workspace was verified outside Docker.
- **Production hosting (AWS Lightsail, Ohio, Ubuntu 24.04, 2 GB)**: use `deploy/docker-compose.yml` (Caddy HTTPS, LiveKit public IP via `use_external_ip`; open only 80, 443, 7881/tcp, 50000-50100/udp). Still needed: TURN/TLS, real LiveKit keys (see the key-rotation PR), a server `.env` with a strong `JWT_SECRET`, uploads dir on a mountable path (`UPLOADS_DIR`), swap file. `deploy/bundle` is PC-only and local.
- **Security notes**: MLS uses ts-mls (not independently audited). Removed members keep history keys they already held (documented in CONTRACT.md and crypto/README.md). App is not code-signed (SmartScreen warning). Soundboard clips and avatars are not E2EE.
- **Klipy GIFs**: demo reads the key from Settings → Privacy; the server reads `KLIPY_API_KEY`. The response mapping was fixed in #25 but never checked against a key on the real server path.
- Cosmetic/known: none open at handoff beyond the above.

## Conventions
- Contracts: `docs/CONTRACT.md` (REST/WS/E2EE), `docs/FEATURES.md` (ownership), `docs/DEMO.md`, `docs/LOCAL_TEST.md`.
- Integrator-owned files: `App.tsx`, `main/`, `preload/`, `api/`, `state/session.ts`, `state/settings.ts`, `deploy/`, `.github/`, `packages/shared`.
- Never spread byte arrays into `String.fromCharCode` or `push` (stack overflow on large payloads); use `toB64`/`fromB64`.
