# Auto-update and version checks

The app updates itself from your own server, because the repo is private and friends can't download from GitHub Releases.

## How it works
- **Client:** on start, and every 4 hours, the app asks the server for `/updates/latest.yml`. If a newer build is there, it downloads it in the background, checks its signature, and only then shows "Chatward x.y.z is ready. Restart to update". A download whose signature does not match is deleted and never installed.
- **Version handshake:** `GET /api/version` (public) returns `serverVersion`, `minClientVersion` and `latestClientVersion`.
  - If the app is older than `minClientVersion`, it shows a full-screen "Update required" screen and waits for the download. It does not open the chat.
  - If the server is older than the app, a yellow strip warns that the server should be updated.
- **Release:** the Release workflow builds `Chatward-Setup.exe` and `latest.yml`, signs the installer (`Chatward-Setup.exe.sig`), then copies them to `updates/` on the server over SSH. It refuses to publish if the signing key is missing.
- **Server update:** unzip the new `chatward-server.zip` over the server folder and run `./update-server.sh`. It backs up the database volume to `backups/`, rebuilds the server and prints rollback steps if it does not come back.

## Update signing (one-time setup)
Updates are signed with a private key that only GitHub holds, and each app checks that signature with a public key built into the app. A server or network attacker can therefore block an update, but cannot slip in their own program. No paid code-signing certificate is needed.

1. On any computer with Node.js, in the repo folder, run `node scripts/update-signing.mjs keygen`. It creates `update-keys/update-private.pem` and `update-keys/update-public.pem`.
2. Open `update-keys/update-private.pem` in Notepad and copy everything into a GitHub secret named `UPDATE_SIGNING_KEY` (Settings → Secrets and variables → Actions).
3. Paste the contents of `update-public.pem` into `packages/client/src/main/updateKey.ts` (replacing the empty string) and merge that change.
4. Delete the `update-keys` folder from your computer after copying the private key. Never commit it or paste it anywhere else.

Until step 3 is done, the app refuses every update. Until step 2 is done, the Release workflow refuses to publish.

**Lost or leaked key:** make a new key, repeat the steps above, and ship a new app build. Apps built with the old public key cannot verify the new key, so those people must install the new build by hand.

**Apps built before signing was added** (before the version that contains this change) do not check signatures. Install the first signed release by hand; auto-update works from then on.

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
- The app only fetches updates over HTTPS (plain HTTP is allowed only for localhost testing). Put a reverse proxy with HTTPS (e.g. Caddy) in front of the server, or friends will not get auto-updates. HTTPS keeps the feed private and stops a network attacker from blocking updates. Tampering is stopped by the update signature, not by HTTPS.
- The installer is not code-signed by Windows, so SmartScreen still warns on install. Update signing above is separate: it only proves the update came from this project's release process.
- Updates install when you press Restart. They no longer install silently when you quit the app, because only a verified update may install.
- The version check runs when the app starts and when the server address is saved. A client that logs in before the check finishes may briefly show the chat.
- Demo mode skips all of this.
