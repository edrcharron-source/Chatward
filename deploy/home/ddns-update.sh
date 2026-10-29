#!/usr/bin/env bash
# Dynamic DNS for the home server: points the Cloudflare A record for $DOMAIN at the home's current public IP.
# Runs every 5 minutes from chatward-ddns.timer (install.sh sets it up). Safe to run by hand: ./ddns-update.sh
# Needs CF_API_TOKEN (Zone > DNS > Edit on the zone only) and DOMAIN in .env. The zone defaults to the last two labels
# of DOMAIN (chat.lebserver.com -> lebserver.com); set CF_ZONE in .env to override.
# The record is DNS only (not proxied): Cloudflare's proxy does not carry voice and video.
# When the IP changes, LiveKit is restarted, since it reads the public IP only at startup.
set -Eeuo pipefail
cd "$(dirname "$0")"

read_env() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
DOMAIN=$(read_env DOMAIN)
TOKEN=$(read_env CF_API_TOKEN)
ZONE=$(read_env CF_ZONE)
ZONE=${ZONE:-$(echo "$DOMAIN" | awk -F. '{ print $(NF-1) "." $NF }')}
if [ -z "$DOMAIN" ] || [ -z "$TOKEN" ]; then
  echo "Set DOMAIN and CF_API_TOKEN in deploy/home/.env first." >&2
  exit 1
fi

api() {
  local method=$1 path=$2 body=${3:-}
  curl -fsS -X "$method" "https://api.cloudflare.com/client/v4$path" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" ${body:+--data "$body"}
}
# Prints one field of the first result of a Cloudflare list response, or nothing.
first() { python3 -c 'import json,sys; r=json.load(sys.stdin).get("result") or [{}]; print((r[0] if isinstance(r, list) else r).get(sys.argv[1], "") if r else "")' "$1"; }

IP=$(curl -fsS --max-time 10 https://1.1.1.1/cdn-cgi/trace | sed -n 's/^ip=//p')
if ! [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Could not find the public IPv4 address (got '$IP')." >&2
  exit 1
fi

ZONE_ID=$(api GET "/zones?name=$ZONE" | first id)
if [ -z "$ZONE_ID" ]; then
  echo "Cloudflare has no zone $ZONE for this token. Check CF_API_TOKEN and CF_ZONE." >&2
  exit 1
fi
RECORDS=$(api GET "/zones/$ZONE_ID/dns_records?type=A&name=$DOMAIN")
RECORD_ID=$(echo "$RECORDS" | first id)
CURRENT=$(echo "$RECORDS" | first content)
BODY="{\"type\":\"A\",\"name\":\"$DOMAIN\",\"content\":\"$IP\",\"ttl\":300,\"proxied\":false,\"comment\":\"Chatward home server (ddns-update.sh)\"}"

if [ "$CURRENT" = "$IP" ]; then
  exit 0
elif [ -z "$RECORD_ID" ]; then
  api POST "/zones/$ZONE_ID/dns_records" "$BODY" >/dev/null
  echo "Created $DOMAIN -> $IP"
else
  api PUT "/zones/$ZONE_ID/dns_records/$RECORD_ID" "$BODY" >/dev/null
  echo "Updated $DOMAIN from $CURRENT to $IP"
fi

# Only restart a LiveKit that is already running; a first install starts it afterwards.
if [ -n "$(docker compose ps -q livekit 2>/dev/null)" ]; then
  echo "Restarting LiveKit so it advertises the new address"
  docker compose restart livekit
fi
