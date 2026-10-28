#!/usr/bin/env bash
# Cloud server (AWS Lightsail, HTTPS): updates the Chatward server in place. Run it on the server, in the repo's deploy/ folder.
# Usage: ./update-cloud.sh [version]
# First put the new code in the checkout (git pull, or git checkout v0.2.0). The version defaults to the tag on HEAD.
# deploy/.env, deploy/updates/ (desktop installers from the release workflow) and deploy/backups/ are kept.
#
# 1. Checks deploy/.env (DOMAIN and the LiveKit keys).
# 2. Stops the server and backs up the data volume (database, avatars, uploads) to backups/.
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

echo "==> Installing Chatward server $VERSION"
SERVER_ID=$(docker compose ps -a -q server)
if [ -n "$SERVER_ID" ]; then
  docker compose stop server

  VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$SERVER_ID")
  echo "==> Backing up volume $VOLUME to backups/chatward-data-$STAMP.tar.gz"
  docker run --rm -v "$VOLUME":/data:ro -v "$PWD/backups":/backup alpine \
    tar czf "/backup/chatward-data-$STAMP.tar.gz" -C /data .
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
