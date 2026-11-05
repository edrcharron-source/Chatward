# Chatward web app (iPhone)

The server can also serve Chatward as a web app. It's the desktop app's page built for a browser, and an iPhone can add it to the home screen, where it opens full screen like a normal app.

## How it is built and served

- `npm run build:web -w @chatward/client` builds `packages/client/out/web` (`vite.web.config.ts`).
- The server serves that folder at `/` when `CHATWARD_WEB_DIR` points at it (`packages/server/src/web.ts`). The Docker image (`deploy/Dockerfile.server`) builds it and sets `CHATWARD_WEB_DIR=/app/web`, so `update-home.sh` deploys it with the server. Nothing changes in Caddy: it already passes everything except `/rtc` to the server.
- The page is same-origin with the API, so no CORS is needed. Its files get their own Content-Security-Policy, which only lets the page connect to this server.

## How it differs from the desktop app

- **Keys** (device keys and the message vault) live in the browser's IndexedDB. Each value is encrypted with an AES-GCM key that the browser created as non-extractable, which stands in for Windows safeStorage. Each browser or home-screen app is its own device. If Safari's website data is cleared, that device is gone and the app signs in as a new device.
- **Server address:** always the address the page was opened from, so the sign-in screen has no server field and no demo mode.
- **Not available:** screen sharing on iPhone (Safari can't share a screen), Spotify, and installer updates (the page updates with the server).
- **Phone layout:** at 700px wide or narrower, the tabs layout shows one tab at a time with the tab bar along the bottom, and the member list, your status and the call controls in a "People" drawer.

## Installing on an iPhone

Open the server address in Safari, tap Share, then **Add to Home Screen**.
