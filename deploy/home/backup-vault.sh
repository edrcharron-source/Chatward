#!/usr/bin/env bash
# Home server: snapshots the Vault together with the database. Run on the box; needs docker, not sudo.
#   ./deploy/home/backup-vault.sh
# Every Vault file is encrypted with a key that only exists inside the database, so the two are only useful together.
#
# 1. Copies the live database with SQLite's online backup (the server keeps running).
# 2. Makes a dated snapshot folder in VAULT_BACKUP_PATH holding that database copy and the Vault folder. Snapshots
#    hard-link files that did not change since the previous one, so each extra snapshot only costs the new photos.
# 3. Keeps the newest VAULT_BACKUP_KEEP snapshots (default 7).
#
# Set VAULT_BACKUP_PATH in deploy/home/.env. A second disk is best; a folder on the RAID still protects against
# deletion and damage, but not against losing the array. Run it nightly with the chatward-vault-backup timer
# (see docs/HOME_SERVER.md).
set -Eeuo pipefail
umask 077
cd "$(dirname "$0")"

read_env() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
DATA_PATH=$(read_env DATA_PATH); DATA_PATH=${DATA_PATH:-/srv/chatward/data}
VAULT_PATH=$(read_env VAULT_PATH); VAULT_PATH=${VAULT_PATH:-/mnt/storage/chatward/vault}
DEST=$(read_env VAULT_BACKUP_PATH)
KEEP=$(read_env VAULT_BACKUP_KEEP); KEEP=${KEEP:-7}
if [ -z "$DEST" ]; then
  echo "Set VAULT_BACKUP_PATH in deploy/home/.env first (for example /mnt/backup/chatward-vault)." >&2
  exit 1
fi
if [ ! -d "$DEST" ]; then
  echo "$DEST does not exist. Create it once: sudo mkdir -p $DEST && sudo chown $(id -u):$(id -g) $DEST" >&2
  exit 1
fi
if [ -z "$(docker compose ps -q server)" ]; then
  echo "The Chatward server is not running, so the database cannot be copied safely. Start it first." >&2
  exit 1
fi

STAMP=$(date -u +%Y%m%d-%H%M%S)
SNAP="vault-$STAMP"
DB_COPY=".backup-chatward-$STAMP.db"
cleanup() { docker run --rm -v "$DATA_PATH":/data alpine rm -f "/data/$DB_COPY" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> Copying the database"
docker compose exec -T server node -e "
  const Database = require('/app/node_modules/better-sqlite3');
  new Database('/data/chatward.db', { readonly: true }).backup('/data/$DB_COPY')
    .then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });"

# Newest earlier snapshot, for hard links. Names carry a UTC timestamp, so sorting by name sorts by age.
shopt -s nullglob
earlier=("$DEST"/vault-*)
shopt -u nullglob
LINK=""
[ ${#earlier[@]} -gt 0 ] && LINK="--link-dest=/backup/$(basename "${earlier[-1]}")/vault"

echo "==> Snapshotting the Vault into $DEST/$SNAP"
# The files belong to the server container's user, so copy them from a container.
docker run --rm -v "$VAULT_PATH":/vault:ro -v "$DATA_PATH":/data:ro -v "$DEST":/backup alpine sh -c "
  set -e
  apk add -q --no-cache rsync >/dev/null
  mkdir -p '/backup/$SNAP.partial'
  rsync -a --delete --exclude=.incoming $LINK /vault/ '/backup/$SNAP.partial/vault/'
  cp '/data/$DB_COPY' '/backup/$SNAP.partial/chatward.db'
  mv '/backup/$SNAP.partial' '/backup/$SNAP'
  chown -R $(id -u):$(id -g) '/backup/$SNAP'"

shopt -s nullglob
snaps=("$DEST"/vault-*)
shopt -u nullglob
for ((i = 0; i < ${#snaps[@]} - KEEP; i++)); do
  case "${snaps[$i]}" in *.partial) continue ;; esac
  echo "==> Removing old snapshot ${snaps[$i]}"
  rm -rf -- "${snaps[$i]}"
done
du -sh "$DEST/$SNAP" 2>/dev/null | sed 's/^/==> Snapshot size (shared files counted once per snapshot): /' || true
echo "Done: $DEST/$SNAP"
