# Auto-update and version checks

The app updates itself from your own server, because the repo is private and friends can't download from GitHub Releases.

## How it works
- **Client:** on start, and every 4 hours, the app asks the server for `/updates/latest.yml`. If a newer build is there, it downloads it in the background and shows "Chatward x.y.z is ready. Restart to update".
- **Version handshake:** `GET /api/version` (public) returns `serverVersion`, `minClientVersion` and `latestClientVersion`.
  - If the app is older than `minClientVersion`, it shows a full-screen "Update required" screen and waits for the download. It does not open the chat.
  - If the server is older than the app, a yellow strip warns that the server should be updated.
- **Release:** the Release workflow builds `Chatward-Setup.exe` and `latest.yml`, then copies them to `updates/` on the server over SSH.
- **Server update:** unzip the new `chatward-server.zip` over the server folder and run `./update-server.sh`. It backs up the database volume to `backups/`, rebuilds the server and prints rollback steps if it does not come back.

## Server setup: LiveKit keys (required)
Voice, video and screen share use LiveKit, which signs every call with a key pair. The old `devkey` / `secret` pair is public, so anyone could join your calls with it. The server now refuses to start with those values.
- **Windows test server:** `start-server.bat` creates the keys in `.env` by itself on first run. Nothing to do.
- **Linux server (Lightsail):** before the first start, or before `./update-server.sh`, edit `.env` in the server folder and set:
  - `LIVEKIT_API_KEY`: any short ID, e.g. `API` followed by 12 random characters.
  - `LIVEKIT_API_SECRET`: at least 32 random characters. Make one with `openssl rand -hex 32`.

  Keep `.env` private. Changing the keys restarts LiveKit, so a call in progress drops and must be rejoined.

## Server setup: setup code for the first account
The first account on a new server becomes its owner, so the server asks for a setup code before it makes that account. Anyone who reaches a fresh server first would otherwise take it. Later accounts still need an invite code.
- **Windows test server:** `start-server.bat` fills `SETUP_CODE` in `.env` on first run and prints the code. Copy it into the Register screen's **Setup code** box.
- **Linux server (Lightsail):** either set `SETUP_CODE` in `deploy/.env` yourself (`openssl rand -hex 12` makes a good one), or leave it blank. If blank, the server makes a code on first start and prints it in its log: run `docker compose -f deploy/docker-compose.yml logs server` and look for `First account setup code`. The code is removed from the server once the first account exists.
- Register the first account before you send anyone the server address. Changing `SETUP_CODE` later does not affect accounts that already exist.

## One-time setup (GitHub repo secrets)
Settings → Secrets and variables → Actions:
- `UPDATE_SSH_HOST`: the server's address, e.g. the Lightsail static IP.
- `UPDATE_SSH_USER`: the SSH user on the server, e.g. `ubuntu`.
- `UPDATE_SSH_KEY`: a private SSH key that can log in as that user. Its public key goes in `~/.ssh/authorized_keys` on the server.
- `UPDATE_DEPLOY_DIR`: the folder that holds `docker-compose.yml` on the server, e.g. `/home/ubuntu/chatward`.

If `UPDATE_SSH_HOST` is not set, the release still publishes to GitHub and the upload step is skipped.

## Releasing a new version
1. Run the Release workflow with a new tag, e.g. `v0.2.0`. Never reuse a tag.
2. Wait for it to finish. Clients pick the build up on their next start or within 4 hours.

To force everyone onto a version, set `MIN_CLIENT_VERSION=0.2.0` in the server's `.env` and run `docker compose up -d`.

## Known limits
- The app only fetches updates over HTTPS (plain HTTP is allowed only for localhost testing). Put a reverse proxy with HTTPS (e.g. Caddy) in front of the server, or friends will not get auto-updates. This is because the installer is unsigned and an attacker on the network could otherwise swap it.
- The installer is not code-signed, so Windows SmartScreen warns on install and the updater cannot check the publisher.
- The version check runs when the app starts and when the server address is saved. A client that logs in before the check finishes may briefly show the chat.
- Demo mode skips all of this.
