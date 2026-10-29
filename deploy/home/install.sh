#!/usr/bin/env bash
# First install of the Chatward home server. Run from a checkout on the box:
#   sudo ./deploy/home/install.sh
# Safe to run again: it keeps an existing .env and data, and only fills in what is missing.
#
# 1. Checks Docker, the LAN address and that port 443 is free there.
# 2. Creates .env (mode 600) with random LiveKit keys and a setup code, and asks for the Cloudflare token.
# 3. Creates the data folders (database on the NVMe, uploads and backups on the RAID).
# 4. Points the DNS record at this home (ddns-update.sh) and installs the 5-minute DDNS timer.
# 5. Builds and starts the stack, waits for HTTPS, and prints the setup code.
# It does not touch the firewall or the router: it prints what to add (see docs/HOME_SERVER.md).
set -Eeuo pipefail
umask 077
cd "$(dirname "$0")"
DEPLOY_DIR=$(pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi
OWNER=${SUDO_USER:-root}
# The server container runs as the image's "node" user.
NODE_UID=1000

command -v docker >/dev/null || { echo "Docker is not installed." >&2; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose v2 is not installed." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is needed by ddns-update.sh." >&2; exit 1; }

read_env() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
set_env() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
rand() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

# ---- .env ----
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created deploy/home/.env"
fi
chown "$OWNER" .env
chmod 600 .env
[ -n "$(read_env LIVEKIT_API_KEY)" ] || set_env LIVEKIT_API_KEY "API$(rand 12)"
[ -n "$(read_env LIVEKIT_API_SECRET)" ] || set_env LIVEKIT_API_SECRET "$(rand 48)"
if [ -z "$(read_env SETUP_CODE)" ]; then
  C=$(head -c 64 /dev/urandom | tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' | head -c 12)
  set_env SETUP_CODE "${C:0:4}-${C:4:4}-${C:8:4}"
fi
if [ -z "$(read_env CF_API_TOKEN)" ]; then
  if [ -t 0 ]; then
    read -r -s -p "Cloudflare API token (Zone > DNS > Edit and Zone > Zone > Read on your zone): " TOKEN; echo
    [ -n "$TOKEN" ] && set_env CF_API_TOKEN "$TOKEN"
  fi
  [ -n "$(read_env CF_API_TOKEN)" ] || { echo "Put CF_API_TOKEN in deploy/home/.env, then run this again." >&2; exit 1; }
fi

DOMAIN=$(read_env DOMAIN)
LAN_IP=$(read_env LAN_IP)
DATA_PATH=$(read_env DATA_PATH); DATA_PATH=${DATA_PATH:-/srv/chatward/data}
UPDATES_PATH=$(read_env UPDATES_PATH); UPDATES_PATH=${UPDATES_PATH:-/srv/chatward/updates}
UPLOADS_PATH=$(read_env UPLOADS_PATH); UPLOADS_PATH=${UPLOADS_PATH:-/mnt/storage/chatward/uploads}
BACKUP_PATH=$(read_env BACKUP_PATH); BACKUP_PATH=${BACKUP_PATH:-/mnt/storage/chatward/backups}
[ -n "$DOMAIN" ] || { echo "Set DOMAIN in deploy/home/.env." >&2; exit 1; }

# ---- network checks ----
if ! ip -4 -o addr show | grep -q " $LAN_IP/"; then
  echo "LAN_IP=$LAN_IP is not an address of this machine. Addresses here:" >&2
  ip -4 -o addr show | awk '{ print "  " $2 " " $4 }' >&2
  exit 1
fi
CHATWARD_RUNNING=$(docker compose ps -q caddy 2>/dev/null || true)
if [ -z "$CHATWARD_RUNNING" ] && ss -Hltn "( sport = :443 )" | grep -qE "($LAN_IP|0\.0\.0\.0|\*|\[::\]):443"; then
  echo "Something already listens on port 443:" >&2
  ss -Hltnp "( sport = :443 )" >&2
  exit 1
fi

# ---- folders ----
mkdir -p "$DATA_PATH" "$UPLOADS_PATH" "$UPDATES_PATH" "$BACKUP_PATH"
chown "$NODE_UID:$NODE_UID" "$DATA_PATH" "$UPLOADS_PATH"
chmod 700 "$DATA_PATH" "$UPLOADS_PATH"
chown "$OWNER" "$UPDATES_PATH" "$BACKUP_PATH"
chmod 755 "$UPDATES_PATH"
chmod 700 "$BACKUP_PATH"
echo "==> Data in $DATA_PATH, uploads in $UPLOADS_PATH, backups in $BACKUP_PATH"

# ---- DNS ----
echo "==> Pointing $DOMAIN at this home's public IP"
./ddns-update.sh
for unit in chatward-ddns.service chatward-ddns.timer; do
  sed "s|@DEPLOY_DIR@|$DEPLOY_DIR|g" "systemd/$unit" > "/etc/systemd/system/$unit"
  chmod 644 "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now chatward-ddns.timer
echo "==> DDNS timer installed (systemctl list-timers chatward-ddns.timer)"

# ---- start ----
echo "==> Building and starting Chatward (the first build takes a few minutes)"
TAG=$(git -C ../.. describe --tags --exact-match 2>/dev/null || true)
VERSION=${TAG#v}
CHATWARD_VERSION=${VERSION:-dev} docker compose up -d --build

echo "==> Waiting for the server"
up=0
for _ in $(seq 1 60); do
  if docker compose exec -T server node -e "fetch('http://localhost:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then up=1; break; fi
  sleep 2
done
[ "$up" = 1 ] || { echo "The server did not start. Check: docker compose logs server" >&2; exit 1; }

# The certificate can take a minute on the first start. --resolve skips DNS, which may not have spread yet.
echo "==> Waiting for the HTTPS certificate"
https=0
for _ in $(seq 1 45); do
  if curl -fsS --max-time 5 --resolve "$DOMAIN:443:$LAN_IP" "https://$DOMAIN/api/health" >/dev/null 2>&1; then https=1; break; fi
  sleep 4
done

cat <<MSG

Chatward is running.
  Address for the app:  https://$DOMAIN
  HTTPS from the LAN:   $([ "$https" = 1 ] && echo ok || echo "not yet; check: docker compose logs caddy")
  First account setup code: $(read_env SETUP_CODE)
Register the first (owner) account now, before you share the address.

Still to do by hand (docs/HOME_SERVER.md):
  - UniFi port forwards to $LAN_IP: 443/tcp, 7881/tcp, 50000-50100/udp. Nothing else.
  - A fixed IP for this box in UniFi, so the forwards keep working.
  - Firewall: this script did not change it. Current state:
MSG
if command -v ufw >/dev/null; then ufw status verbose | sed 's/^/      /'; else echo "      (ufw not installed)"; fi
cat <<'MSG'
    If ufw is active, add:  sudo ufw allow 443/tcp && sudo ufw allow 7881/tcp && sudo ufw allow 50000:50100/udp
    If it is inactive, leave it: turning it on with a default deny would cut off Samba, Jellyfin and the game servers.
MSG
