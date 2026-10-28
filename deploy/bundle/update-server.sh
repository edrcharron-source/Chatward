#!/usr/bin/env bash
# PC-only, local test server. Not for cloud servers: a cloud server (AWS Lightsail) runs the
# HTTPS setup in deploy/ (deploy/docker-compose.yml with DOMAIN set, see deploy/Caddyfile).
# Installs a new server bundle in place. Unzip the new chatward-server.zip over this folder first.
# Your .env, updates/ (desktop installers) and backups/ are kept. Usage: ./update-server.sh
#
# 1. Stops the server and backs up the data volume (database, avatars, uploads) to backups/. Only the newest 3 backups are kept.
# 2. Refreshes the LiveKit image and rebuilds the server image from the new files.
# 3. Waits for the server to answer. If it does not, the rollback steps are printed.
set -euo pipefail
cd "$(dirname "$0")"

# The server refuses to start with the public LiveKit defaults, so check .env before touching the running server.
LIVEKIT_KEY=$(grep -E '^LIVEKIT_API_KEY=' .env 2>/dev/null | cut -d= -f2- || true)
LIVEKIT_SECRET=$(grep -E '^LIVEKIT_API_SECRET=' .env 2>/dev/null | cut -d= -f2- || true)
if [ -z "$LIVEKIT_KEY" ] || [ -z "$LIVEKIT_SECRET" ] || [ "$LIVEKIT_KEY" = devkey ] || [ "$LIVEKIT_SECRET" = secret ] || [ "${#LIVEKIT_SECRET}" -lt 32 ]; then
  echo "Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env first (secret: 32+ random characters). See docs/UPDATES.md." >&2
  exit 1
fi

VERSION=$(cat VERSION 2>/dev/null || echo dev)
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)
PORT=${PORT:-3000}
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

echo "==> Installing Chatward server $VERSION"
docker compose stop server

VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$(docker compose ps -a -q server)")
echo "==> Backing up volume $VOLUME to backups/chatward-data-$STAMP.tar.gz"
docker run --rm -v "$VOLUME":/data:ro -v "$PWD/backups":/backup alpine \
  tar czf "/backup/chatward-data-$STAMP.tar.gz" -C /data .
prune_backups

echo "==> Refreshing LiveKit and rebuilding the server image"
docker compose pull livekit
CHATWARD_VERSION="$VERSION" docker compose up -d --build

echo "==> Waiting for the server on port $PORT"
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/api/version" >/dev/null 2>&1; then
    echo "Chatward server $VERSION is up. Backup: backups/chatward-data-$STAMP.tar.gz"
    trap - ERR
    exit 0
  fi
  sleep 2
done

echo "Server did not answer. Check: docker compose logs server" >&2
echo "To roll back:" >&2
echo "  1. docker compose down" >&2
echo "  2. Unzip the previous chatward-server.zip over this folder" >&2
echo "  3. Only if the database was changed: docker run --rm -v $VOLUME:/data -v \"\$PWD/backups\":/backup alpine sh -c 'rm -rf /data/* && tar xzf /backup/chatward-data-$STAMP.tar.gz -C /data'" >&2
echo "  4. docker compose up -d --build" >&2
exit 1
