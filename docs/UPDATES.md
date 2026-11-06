# Auto-update and version checks

The app updates itself from your own server, because the repo is private and friends can't download from GitHub Releases.

## How it works
- **Client:** on start, and every 4 hours, the app asks the server for `/updates/latest.yml`. If a newer build is there, it downloads it in the background and shows "Chatward x.y.z is ready. Restart to update".
- **Version handshake:** `GET /api/version` (public) returns `serverVersion`, `minClientVersion` and `latestClientVersion`.
  - If the app is older than `minClientVersion`, it shows a full-screen "Update required" screen and waits for the download. It does not open the chat.
  - If the server is older than the app, a yellow strip warns that the server should be updated.
- **Release:** the Release workflow builds `Chatward-Setup.exe` and `latest.yml`, then copies them to `updates/` on the server over SSH.
- **Server update:** on the home server, `./deploy/home/update-home.sh` (see docs/HOME_SERVER.md). It backs up the data folder first and prints rollback steps if the server does not come back.

## Server setup: LiveKit keys (required)
Voice, video and screen share use LiveKit, which signs every call with a key pair. The old `devkey` / `secret` pair is public, so anyone could join your calls with it. The server now refuses to start with those values.
- **Home server:** `deploy/home/install.sh` creates random keys in `deploy/home/.env` on first run. To set them by hand:
  - `LIVEKIT_API_KEY`: any short ID, e.g. `API` followed by 12 random characters.
  - `LIVEKIT_API_SECRET`: at least 32 random characters. Make one with `openssl rand -hex 32`.

  Keep `.env` private. Changing the keys restarts LiveKit, so a call in progress drops and must be rejoined.

## Server setup: sign-up codes
Every account, the first one included, is made with a one-time sign-up code from the `chatward` admin command on the
server. The first account made with a code owns the server, so make that one yourself before you share the address.
- **Home server:** `chatward invite` (see docs/HOME_SERVER.md, section 4).

A code works once and expires after 48 hours. `SETUP_CODE` in old `.env` files is no longer read and can be deleted.

## One-time setup (GitHub repo secrets)
Settings → Secrets and variables → Actions:
- `UPDATE_SSH_HOST`: the server's address, e.g. the server's domain or public IP.
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
`update-home.sh` backs up the database, login secret, avatars and sounds to `BACKUP_PATH` (see docs/HOME_SERVER.md). The backup holds the login-signing secret and password hashes, so anyone with a copy can sign in as any member. The script makes each archive private (`umask 077`). Do not copy a backup off the server to a PC, email or cloud storage unless you protect it, and delete old ones you no longer need.

## Releasing a new version
1. Run the Release workflow with a new tag, e.g. `v0.2.0`. Never reuse a tag.
2. Wait for it to finish. Clients pick the build up on their next start or within 4 hours.

To force everyone onto a version, set `MIN_CLIENT_VERSION=0.2.0` in the server's `.env` and run `docker compose up -d`.

## Known limits
- The app only fetches updates over HTTPS (plain HTTP is allowed only for localhost testing). Put a reverse proxy with HTTPS (e.g. Caddy) in front of the server, or friends will not get auto-updates. This is because the installer is unsigned and an attacker on the network could otherwise swap it.
- The installer is not code-signed, so Windows SmartScreen warns on install and the updater cannot check the publisher.
- The version check runs when the app starts and when the server address is saved. A client that logs in before the check finishes may briefly show the chat.
- Demo mode skips all of this.
