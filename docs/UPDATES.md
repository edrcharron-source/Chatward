# Auto-update and version checks

The app updates itself from your own server, because the repo is private and friends can't download from GitHub Releases.

## How it works
- **Client:** on start, and every 4 hours, the app asks the server for `/updates/latest.yml`. If a newer build is there, it downloads it in the background and shows "Chatward x.y.z is ready. Restart to update".
- **Version handshake:** `GET /api/version` (public) returns `serverVersion`, `minClientVersion` and `latestClientVersion`.
  - If the app is older than `minClientVersion`, it shows a full-screen "Update required" screen and waits for the download. It does not open the chat.
  - If the server is older than the app, a yellow strip warns that the server should be updated.
- **Release:** the Release workflow builds `Chatward-Setup.exe` and `latest.yml`, then copies them to `updates/` on the server over SSH.
- **Server update:** unzip the new `chatward-server.zip` over the server folder and run `./update-server.sh`. It backs up the database volume to `backups/`, rebuilds the server and prints rollback steps if it does not come back.

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
