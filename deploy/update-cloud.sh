#!/usr/bin/env bash
# Cloud server (AWS Lightsail, HTTPS): updates the Chatward server in place. Run it on the server, in the repo's deploy/ folder.
# Usage: ./update-cloud.sh [version]
# First put the new code in the checkout (git pull, or git checkout v0.2.0). The version defaults to the tag on HEAD.
# deploy/.env, deploy/updates/ (desktop installers from the release workflow) and deploy/backups/ are kept.
#
# 1. Checks deploy/.env (DOMAIN and the LiveKit keys).
# 2. Stops the server and backs up the data volume (database, avatars, uploads) to backups/. Only the newest 3 backups are kept.
# 3. Refreshes the LiveKit and Caddy images, rebuilds the server image and starts everything.
# 4. Waits for the server to answer inside Docker. If it does not, the rollback steps are printed.
set -euo pipefail
cd "$(dirname "$0")"

read_env() { grep -E "^$1=" .env 2>/dev/null | cut -d= -f2- || true; }

# The server refuses to start with the public LiveKit defaults, so check .env before touching the running server.
DOMAIN=$(read_env DOMAIN)
LIVEKIT_KEY=$(read_env LIVEKIT_API_KEY)
LIVEKIT_SECRET=$(read_env LIVEKIT_API_SECRET)
if [ -z "$DOMAIN" ] || [ -z "$LIVEKIT_KEY" ] || [ -z "$LIVEKIT_SECRET" ] || [ "$LIVEKIT_KEY" = devkey ] || [ "$LIVEKIT_SECRET" = secret ] || [ "${#LIVEKIT_SECRET}" -lt 32 ]; then
  echo "Set DOMAIN, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in deploy/.env first (secret: 32+ random characters). See docs/UPDATES.md." >&2
  exit 1
fi

TAG=$(git -C .. describe --tags --exact-match 2>/dev/null || true)
VERSION=${1:-${TAG#v}}
VERSION=${VERSION:-dev}
STAMP=$(date -u +%Y%m%d-%H%M%S)
mkdir -p backups updates

trap 'echo "Update failed. The server is stopped; start the previous one with: docker compose start server" >&2' ERR

# Backup names carry a UTC timestamp, so sorting by name sorts by age. Keep the newest $KEEP_BACKUPS.
KEEP_BACKUPS=3
prune_backups() {
  local files=() count i
  shopt -s nullglob
  files=(backups/chatward-data-*.tar.gz)
  shopt -u nullglob
  count=${#files[@]}
  for ((i = 0; i < count - KEEP_BACKUPS; i++)); do
    echo "==> Removing old backup ${files[$i]}"
    rm -f -- "${files[$i]}"
  done
}

# The backup sits on the same disk as the data. Refuse to start if there is not room for a full copy plus 1 GB spare,
# checked before the server stops, so a full disk leaves the running server alone.
check_backup_space() {
  local used_kb avail_kb
  used_kb=$(docker run --rm -v "$VOLUME":/data:ro alpine du -sk /data | cut -f1)
  avail_kb=$(df -Pk backups | awk 'NR==2 {print $4}')
  if [ "$avail_kb" -lt $((used_kb + 1048576)) ]; then
    echo "Not enough free disk for a backup: the data is $((used_kb / 1024)) MB and $((avail_kb / 1024)) MB is free. Free some space, or delete old files in deploy/backups/, then run this again." >&2
    exit 1
  fi
}

echo "==> Installing Chatward server $VERSION"
SERVER_ID=$(docker compose ps -a -q server)
if [ -n "$SERVER_ID" ]; then
  VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$SERVER_ID")
  check_backup_space

  docker compose stop server
  echo "==> Backing up volume $VOLUME to backups/chatward-data-$STAMP.tar.gz"
  docker run --rm -v "$VOLUME":/data:ro -v "$PWD/backups":/backup alpine \
    tar czf "/backup/chatward-data-$STAMP.tar.gz" -C /data .
  prune_backups
else
  echo "==> No server container yet (first install), so there is nothing to back up."
fi

echo "==> Refreshing LiveKit and Caddy, then rebuilding the server image"
docker compose pull livekit caddy
CHATWARD_VERSION="$VERSION" docker compose up -d --build

echo "==> Waiting for the server to answer"
for _ in $(seq 1 30); do
  if docker compose exec -T server node -e "fetch('http://localhost:3000/api/version').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then
    echo "Chatward server $VERSION is up at https://$DOMAIN. Backup: backups/chatward-data-$STAMP.tar.gz"
    trap - ERR
    exit 0
  fi
  sleep 2
done

echo "Server did not answer. Check: docker compose logs server" >&2
echo "To roll back:" >&2
echo "  1. docker compose down" >&2
echo "  2. Check out the previous version (git checkout vX.Y.Z)" >&2
echo "  3. Only if the database was changed: docker run --rm -v $VOLUME:/data -v \"\$PWD/backups\":/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/chatward-data-$STAMP.tar.gz -C /data'" >&2
echo "  4. ./update-cloud.sh vX.Y.Z" >&2
exit 1
