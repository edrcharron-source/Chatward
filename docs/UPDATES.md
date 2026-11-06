# Auto-update and version checks

The app updates itself from your own server. The server fills its update folder from the newest GitHub release, and the app checks a signature on every installer before it installs it.

## How it works
- **Release:** the Release workflow builds `Chatward-Setup.exe`, signs it with the `UPDATE_SIGNING_KEY` secret, and attaches `Chatward-Setup.exe`, `Chatward-Setup.exe.sig`, `Chatward-Setup.exe.blockmap` and `latest.yml` to the GitHub release.
- **Server:** the home server's `update-home.sh` downloads those four files from the newest release into its update folder (`/srv/chatward/updates`), which it serves at `/updates`. A failed download only means members keep their current app; the server update carries on. Set `UPDATES_REPO=owner/name` in `deploy/home/.env` to fetch from a different repo.
- **Client:** on start, and every 4 hours, the app asks the server for `/updates/latest.yml`. If a newer build is there, it downloads it in the background, then checks its signature against the public key built into the app. Only then does the bar show "Chatward x.y.z is ready" with an **Update** button. Update installs it silently and opens the new version. **Later** installs it the next time the app quits.
- **Signature check:** the signature covers the version and the installer. A missing or wrong signature deletes the download and shows "failed the safety check". So a broken-into server or network can stop updates but cannot install its own program, and cannot pass off an old installer as a new one.
- **Version handshake:** `GET /api/version` (public) returns `serverVersion`, `minClientVersion` and `latestClientVersion`.
  - If the app is older than `minClientVersion`, it shows a full-screen "Update required" screen and waits for the download. It does not open the chat.
  - If the server is older than the app, a yellow strip warns that the server should be updated.
- **Optional SSH push:** if the `UPDATE_SSH_*` secrets below are set, the Release workflow also copies the files straight to a server over SSH. The home server does not need this.
- **Server update:** unzip the new `chatward-server.zip` over the server folder and run `./update-server.sh`. It backs up the database volume to `backups/`, rebuilds the server and prints rollback steps if it does not come back. Before it stops the server it checks that the disk holding `backups/` has room for a full copy of the data plus 2 GB. The image pull and build use Docker's own disk space, which this check does not measure, so keep some room free there too. The backups are on the same disk as the data, and only the newest 3 are kept, so with a large upload folder they can take up to three times its size.

## Server setup: LiveKit keys (required)
Voice, video and screen share use LiveKit, which signs every call with a key pair. The old `devkey` / `secret` pair is public, so anyone could join your calls with it. The server now refuses to start with those values.
- **Windows test server:** `start-server.bat` creates the keys in `.env` by itself on first run. Nothing to do.
- **Linux server (Lightsail):** before the first start, or before `./update-server.sh`, edit `.env` in the server folder and set:
  - `LIVEKIT_API_KEY`: any short ID, e.g. `API` followed by 12 random characters.
  - `LIVEKIT_API_SECRET`: at least 32 random characters. Make one with `openssl rand -hex 32`.

  Keep `.env` private. Changing the keys restarts LiveKit, so a call in progress drops and must be rejoined.

## Server setup: sign-up codes
Every account, the first one included, is made with a one-time sign-up code from the `chatward` admin command on the
server. The first account made with a code owns the server, so make that one yourself before you share the address.
- **Home server:** `chatward invite` (see docs/HOME_SERVER.md, section 4).
- **Windows test server:** open a terminal in the `chatward-server` folder and run `chatward invite`.
- **Linux server (Lightsail):** `docker compose -f deploy/docker-compose.yml exec server node packages/server/dist/cli.js invite`.

A code works once and expires after 48 hours. `SETUP_CODE` in old `.env` files is no longer read and can be deleted.

## One-time setup: the update signing key (required)
The Release workflow refuses to run without it, because an app built without the key refuses every update.
1. On any computer with Node.js, in a copy of this repo, run `node scripts/update-signing.mjs keygen`. It writes `update-keys/update-private.pem`.
2. GitHub → the repo → Settings → Secrets and variables → Actions → New repository secret. Name: `UPDATE_SIGNING_KEY`. Value: the whole contents of that file, including the `BEGIN` and `END` lines.
3. Delete the file, or keep it somewhere private and offline. Never commit, email or paste it anywhere else. Anyone with it, or with write access to the repo's secrets, can sign updates, so turn on two-step login for the GitHub account.

The public half is worked out from the secret during the release and built into the app, so there is nothing else to set. If you ever replace the key, apps built with the old key refuse updates signed with the new one, so members must install that one release by hand.

Apps from before signatures existed (1.0.0) don't check them; they install the next release like any update. Every release after that is checked.

## Optional: SSH upload (GitHub repo secrets)
Settings → Secrets and variables → Actions:
- `UPDATE_SSH_HOST`: the server's address, e.g. the Lightsail static IP.
- `UPDATE_SSH_USER`: the deploy user on the server, `chatward-deploy` (set up below). Do not use `ubuntu`, which is an admin account.
- `UPDATE_SSH_KEY`: the private key for the deploy user. Its public key goes in the deploy user's `authorized_keys` (below).
- `UPDATE_SSH_HOST_KEY`: the server's SSH host key, so the release refuses to talk to any other machine. Put in the whole line `ssh-ed25519 AAAA…` copied from the server (step 4 below).
- `UPDATE_DEPLOY_DIR`: the folder that holds `docker-compose.yml` on the server, e.g. `/home/ubuntu/chatward`.

If `UPDATE_SSH_HOST` is not set, the release still publishes to GitHub and the upload step is skipped. If `UPDATE_SSH_HOST` is set but `UPDATE_SSH_HOST_KEY` is not, the upload fails on purpose.

### Set up the deploy user on the server (plain steps)
This user can only put files into the `updates/` folder. It cannot run Docker, change the server or log in as an admin.
1. Log in to the server over SSH as `ubuntu`.
2. Create the user with no password: `sudo adduser --disabled-password --gecos "" chatward-deploy`
3. Make a new key on your PC, with no passphrase: `ssh-keygen -t ed25519 -f chatward-deploy -N ""`. Paste the whole contents of the file `chatward-deploy` (the private key, no `.pub`) into `UPDATE_SSH_KEY`.
   Then on the server, put the public key (the contents of `chatward-deploy.pub`) in the deploy user's list of allowed keys:
   `sudo mkdir -p /home/chatward-deploy/.ssh && sudo tee -a /home/chatward-deploy/.ssh/authorized_keys` (paste the line, press Enter, then Ctrl+D), then `sudo chown -R chatward-deploy:chatward-deploy /home/chatward-deploy/.ssh && sudo chmod 700 /home/chatward-deploy/.ssh && sudo chmod 600 /home/chatward-deploy/.ssh/authorized_keys`.
4. Get the host key: `cat /etc/ssh/ssh_host_ed25519_key.pub`. Paste the whole line into `UPDATE_SSH_HOST_KEY`. Check it once: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` should show the same fingerprint you see the first time you connect from your PC.
5. Let the deploy user into the folder and give it only the `updates/` folder: `sudo chmod o+x /home/ubuntu` (only if `ls -ld /home/ubuntu` shows no `x` for others; this lets it pass through, not look inside), then `sudo chown chatward-deploy:chatward-deploy /home/ubuntu/chatward/deploy/updates` (use your `UPDATE_DEPLOY_DIR`/`updates`). Do not give it ownership of anything else.
6. Test from your PC: `ssh -i chatward-deploy chatward-deploy@SERVER_ADDRESS "ls /home/ubuntu/chatward/deploy/updates"` should list the files and log you in without a password.
7. Set the `UPDATE_SSH_USER` secret to `chatward-deploy`. Ubuntu's own login stays for you to manage the server; just do not put it in any GitHub secret.
8. Turn on two-step login for the GitHub account that owns the repo, since anyone with access to its secrets can publish updates.

### Backups are secrets
`update-cloud.sh` backs up the database, avatars and uploads to `deploy/backups/`. The backup holds the login-signing secret and password hashes, so anyone with a copy can sign in as any member. The script makes the folder private (`chmod 700`) and the archive private (`umask 077`). Do not copy a backup off the server to a PC, email or cloud storage unless you protect it, and delete old ones you no longer need.

## Releasing a new version
1. Run the Release workflow with a new tag, e.g. `v0.2.0`. Never reuse a tag.
2. Wait for it to finish. The server picks it up the next time `update-home.sh` runs; apps then offer it on their next start or within 4 hours.

To force everyone onto a version, set `MIN_CLIENT_VERSION=0.2.0` in the server's `.env` and run `docker compose up -d`.

## Known limits
- The app only fetches updates over HTTPS (plain HTTP is allowed only for localhost testing). Put a reverse proxy with HTTPS (e.g. Caddy) in front of the server, or friends will not get auto-updates. This is because the installer is unsigned and an attacker on the network could otherwise swap it.
- The installer is not code-signed, so Windows SmartScreen warns on a manual install. The update signature above is what proves an update came from us.
- Only real releases reach members. Test builds from develop never update themselves and are never put in the feed.
- The version check runs when the app starts and when the server address is saved. A client that logs in before the check finishes may briefly show the chat.
- Demo mode skips all of this.
