#!/usr/bin/env bash
# Home server: updates Chatward in place. Run on the box, from a checkout, after putting the new code in place:
#   git fetch --tags && git checkout v0.2.1 && ./deploy/home/update-home.sh
# The version defaults to the tag on HEAD. Needs docker (the admin user is in the docker group), not sudo.
#
# 1. Checks .env.
# 2. Downloads the newest desktop app release into UPDATES_PATH, so members' apps offer the Update button.
# 3. Stops the server and backs up the data folder (database, login secret, avatars, sounds) to BACKUP_PATH.
#    Uploads are not copied here: they live on the RAID and an update never rewrites them. Keeps the newest 5 backups.
# 4. Refreshes LiveKit, rebuilds Caddy and the server, and starts everything.
# 5. Waits for the server. If it does not answer, prints the rollback steps.
set -Eeuo pipefail
umask 077
cd "$(dirname "$0")"

read_env() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
DOMAIN=$(read_env DOMAIN)
LIVEKIT_SECRET=$(read_env LIVEKIT_API_SECRET)
DATA_PATH=$(read_env DATA_PATH); DATA_PATH=${DATA_PATH:-/srv/chatward/data}
BACKUP_PATH=$(read_env BACKUP_PATH); BACKUP_PATH=${BACKUP_PATH:-/mnt/storage/chatward/backups}
if [ -z "$DOMAIN" ] || [ -z "$(read_env CF_API_TOKEN)" ] || [ -z "$(read_env LIVEKIT_API_KEY)" ] || [ "${#LIVEKIT_SECRET}" -lt 32 ]; then
  echo "deploy/home/.env is incomplete. Run sudo ./install.sh first (see docs/HOME_SERVER.md)." >&2
  exit 1
fi

TAG=$(git -C ../.. describe --tags --exact-match 2>/dev/null || true)
VERSION=${1:-${TAG#v}}
# A branch checkout has no tag; use the version in package.json so clients do not see the server as older.
VERSION=${VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' ../../package.json)}
STAMP=$(date -u +%Y%m%d-%H%M%S)
ARCHIVE="$BACKUP_PATH/chatward-data-$STAMP.tar.gz"
KEEP_BACKUPS=5

# The desktop app updates itself from UPDATES_PATH, so fill it from the newest GitHub release. The app checks each
# installer's signature (the .sig file) before installing, so these downloads need no trust in GitHub or the network.
# A failure here only means members keep their current app; it never stops the server update.
fetch_desktop_update() {
  local base="https://github.com/${UPDATES_REPO}/releases/latest/download" tmp f
  command -v curl >/dev/null || { echo "curl is not installed, so the desktop update was not fetched." >&2; return 1; }
  tmp=$(mktemp -d "$UPDATES_PATH/.incoming-XXXXXX") || return 1
  # latest.yml first: if it matches the one already here, the release has not changed and nothing else is downloaded.
  if ! curl -fsSL --retry 3 -o "$tmp/latest.yml" "$base/latest.yml"; then rm -rf "$tmp"; return 1; fi
  if cmp -s "$tmp/latest.yml" "$UPDATES_PATH/latest.yml"; then
    echo "==> Desktop app update already up to date ($(sed -n 's/^version: *//p' "$tmp/latest.yml"))"
    rm -rf "$tmp"; return 0
  fi
  for f in Chatward-Setup.exe Chatward-Setup.exe.sig Chatward-Setup.exe.blockmap; do
    if ! curl -fsSL --retry 3 -o "$tmp/$f" "$base/$f"; then rm -rf "$tmp"; return 1; fi
  done
  chmod 644 "$tmp"/*
  # Installer, signature and blockmap first, latest.yml last, so apps never see a version whose files are missing.
  for f in Chatward-Setup.exe Chatward-Setup.exe.sig Chatward-Setup.exe.blockmap latest.yml; do mv -f "$tmp/$f" "$UPDATES_PATH/$f"; done
  rm -rf "$tmp"
  echo "==> Desktop app update ready for members: $(sed -n 's/^version: *//p' "$UPDATES_PATH/latest.yml")"
}
UPDATES_PATH=$(read_env UPDATES_PATH); UPDATES_PATH=${UPDATES_PATH:-/srv/chatward/updates}
UPDATES_REPO=$(read_env UPDATES_REPO); UPDATES_REPO=${UPDATES_REPO:-edrcharron-source/Chatward}
echo "==> Fetching the newest desktop app release from github.com/$UPDATES_REPO"
fetch_desktop_update || echo "Could not fetch the desktop app update; members keep their current version. The server update continues." >&2

echo "==> Installing Chatward server $VERSION"
if [ -n "$(docker compose ps -a -q server)" ]; then
  used_kb=$(docker run --rm -v "$DATA_PATH":/data:ro alpine du -sk /data | cut -f1)
  avail_kb=$(df -Pk "$BACKUP_PATH" | awk 'NR==2 {print $4}')
  if [ "$avail_kb" -lt $((used_kb + 1048576)) ]; then
    echo "Not enough room in $BACKUP_PATH for a backup ($((used_kb / 1024)) MB of data, $((avail_kb / 1024)) MB free)." >&2
    exit 1
  fi
  trap 'echo "Update failed. The server is stopped; start the previous one with: docker compose start server" >&2' ERR
  docker compose stop server
  echo "==> Backing up $DATA_PATH to $ARCHIVE"
  # The data folder belongs to the container's user, so read it from a container. A stopped server means a consistent copy.
  docker run --rm -v "$DATA_PATH":/data:ro -v "$BACKUP_PATH":/backup alpine \
    sh -c "umask 077 && tar czf '/backup/chatward-data-$STAMP.tar.gz' -C /data . && chown $(id -u):$(id -g) '/backup/chatward-data-$STAMP.tar.gz'"
  shopt -s nullglob
  files=("$BACKUP_PATH"/chatward-data-*.tar.gz)
  shopt -u nullglob
  for ((i = 0; i < ${#files[@]} - KEEP_BACKUPS; i++)); do rm -f -- "${files[$i]}"; done
else
  echo "==> No server container yet, so there is nothing to back up."
fi

echo "==> Refreshing LiveKit, rebuilding Caddy and the server"
docker compose pull livekit
CHATWARD_VERSION="$VERSION" docker compose up -d --build

echo "==> Waiting for the server to answer"
for _ in $(seq 1 30); do
  if docker compose exec -T server node -e "fetch('http://localhost:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then
    echo "Chatward server $VERSION is up at https://$DOMAIN"
    [ -f "$ARCHIVE" ] && echo "Backup: $ARCHIVE"
    # Installs from before the chatward command existed do not have it linked yet.
    command -v chatward >/dev/null || echo "Link the admin command once with: sudo ln -s $(pwd)/chatward /usr/local/bin/chatward"
    trap - ERR
    exit 0
  fi
  sleep 2
done

echo "Server did not answer. Check: docker compose logs server" >&2
echo "To roll back:" >&2
echo "  1. docker compose down" >&2
echo "  2. git checkout <previous tag>" >&2
echo "  3. Only if the database was changed: docker run --rm -v $DATA_PATH:/data -v $BACKUP_PATH:/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/chatward-data-$STAMP.tar.gz -C /data'" >&2
echo "  4. ./update-home.sh" >&2
exit 1
