# Test Chatward on one Windows PC

You need: [Node.js 22 LTS](https://nodejs.org), [Git](https://git-scm.com), and [Docker Desktop](https://www.docker.com/products/docker-desktop) (only for voice/video, which needs the LiveKit server).

## 1. Get the code and install
```powershell
git clone https://github.com/edrcharron-source/Chatward.git
cd Chatward
npm install
npm run build -w @chatward/shared
```

## 2. Start the voice server (LiveKit)
```powershell
docker compose -f deploy/docker-compose.yml up -d livekit
```
Text chat works without it; voice, camera and screen share need it.

## 3. Start the Chatward server
```powershell
npm run dev:server
```
It listens on http://localhost:3000 and keeps its data in `./data` (database, uploads, avatars).
Optional GIFs: get a Klipy API key and run `$env:KLIPY_API_KEY="your-key"` before this command. Without a key the GIF picker says GIFs are not configured.

## 4. Start the app
```powershell
npm run dev:client
```
A Chatward window opens. Server URL stays `http://localhost:3000`.

## 5. Try it with two "people"
1. In window 1: **Register** (the first account needs no invite), create a server, open Server menu → create an invite code.
2. Open a second instance with its own profile: in another terminal run
   `npx electron packages/client --user-data-dir=%TEMP%\chatward-second` (after `npm run build -w @chatward/client`), or use the installed app: `Chatward.exe --user-data-dir=C:\cw2`.
3. In window 2: Register with the invite code. Both windows can now chat, join the voice channel, share screens, use the soundboard and start a watch party.
4. Use headphones, otherwise the two windows will echo each other through the same speakers.

## Windows installer (.exe)
GitHub → Actions → "Build Windows app" → Run workflow. When it finishes, download the `chatward-windows` artifact. It contains an installer and a portable `.exe`. Windows SmartScreen will warn about an unknown publisher (the build is unsigned): More info → Run anyway.

## Known gaps in this test build
- Not yet exercised on a real Windows machine with a real LiveKit server (camera, screen share, system audio, soundboard-into-call are untested).
- Text/voice encryption is the v1 protocol; the MLS upgrade is in progress.
- Docker image for the server (`deploy/Dockerfile.server`) is untested; use step 3 for now.
