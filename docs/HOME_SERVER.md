# Home server (lebserver)

Runs Chatward on a home Ubuntu box so friends can reach it from the internet at `https://chat.lebserver.com`.
Profile: `deploy/home/`. It is the cloud profile adapted for a home network: Caddy gets its certificate by Cloudflare
DNS-01 (so port 80 stays with the host's nginx), the database sits on the NVMe, uploads and backups on the RAID, and a
5-minute timer keeps the DNS record on the home's public IP.

| Container | Listens on the host | Forwarded on the router |
|---|---|---|
| caddy (HTTPS, API, `/ws`, `/rtc`, `/updates`) | `LAN_IP:443` | 443/tcp |
| livekit (voice, video, screen share) | 7881/tcp, 50000-50100/udp | 7881/tcp, 50000-50100/udp |
| server (Node) | none (Docker network only) | never |

Never forward 22, 80, 3000, 7880, Samba, Jellyfin, Ollama, Grafana or Portainer.

## 1. Before you start (once)
1. **Fixed IP.** In UniFi, Client Devices → the server → Settings → Fixed IP `192.168.1.228`.
2. **No double NAT.** UniFi → Internet: the WAN IP must match what https://1.1.1.1/cdn-cgi/trace shows as `ip=`.
3. **Cloudflare token.** Cloudflare → My Profile → API Tokens → Create Token → "Edit zone DNS" template. Add a second
   permission Zone → Zone → Read (Caddy and `ddns-update.sh` look the zone up by name), set Zone Resources = Include →
   Specific zone → `lebserver.com`, no expiry and no IP filter (the home IP changes). Copy the token; it goes in `.env` as `CF_API_TOKEN`. The A record for
   `chat` is created by the install, as DNS only (grey cloud). Do not turn the orange proxy on: it breaks voice.
4. **Router port forwards** (UniFi → Settings → Routing → Port Forwarding), all to `192.168.1.228`, from any source:
   - `Chatward HTTPS` 443 TCP → 443
   - `Chatward voice TCP` 7881 TCP → 7881
   - `Chatward voice UDP` 50000-50100 UDP → 50000-50100

## 2. Install
On the box (SSH over Tailscale):
```bash
sudo mkdir -p /opt/chatward && sudo chown "$USER" /opt/chatward
git clone https://github.com/edrcharron-source/Chatward.git /opt/chatward
cd /opt/chatward && git checkout <release tag or branch>
sudo ./deploy/home/install.sh
```
It asks for the Cloudflare token, writes `deploy/home/.env` (mode 600) with random voice keys and a setup code, creates
the folders, sets the DNS record, installs `chatward-ddns.timer`, builds and starts the stack, and prints the setup code.
Register the owner account with that code right away, before sharing the address.

The install does **not** change the firewall. It prints `ufw status`. If ufw is active, add the three Chatward rules it
shows; if it is inactive, leave it off. Note that Docker publishes ports through its own iptables rules, so the router
forwards are what actually gate the internet.

## 3. Check it with the test console
1. Install the Windows app, set the server to `https://chat.lebserver.com`, and register with the setup code.
2. Create a server, open the **🧪 Test** button at the top right (or Ctrl+Shift+T).
3. **Run all**: connection, account, servers, encrypted text, encrypted upload, GIFs, link previews (it also checks a LAN
   address is refused), soundboard, voice state. Everything should say PASS.
4. Make an invite code, register a second account on another PC (ideally one outside the house, e.g. on a phone hotspot),
   and on both: join voice, turn the camera on, share a screen, then paste a YouTube link into the watch party. The live
   socket frames list shows the other PC's actions as they arrive.

## 4. Day to day
| Task | Command (in `/opt/chatward`) |
|---|---|
| Update | `git fetch --tags && git checkout vX.Y.Z && ./deploy/home/update-home.sh` (backs up the data folder first) |
| Logs | `cd deploy/home && docker compose logs -f server` (also `journalctl -t chatward-server`) |
| Stop / start | `cd deploy/home && docker compose stop` / `docker compose up -d` |
| DNS now | `./deploy/home/ddns-update.sh` · timer: `systemctl list-timers chatward-ddns.timer` |
| Disk | The server logs free space for data and uploads at start and hourly, and warns above 85% |

Portainer shows the stack as `chatward`; use it for logs and restarts, but run updates with `update-home.sh` so the backup
happens first.

## Files
| Path | Holds |
|---|---|
| `/srv/chatward/data` (NVMe) | `chatward.db`, `jwt-secret`, avatars, banners, sounds |
| `/mnt/storage/chatward/uploads` (RAID) | encrypted attachments |
| `/mnt/storage/chatward/backups` (RAID) | `update-home.sh` backups, newest 5 |
| `/srv/chatward/updates` | desktop installer feed (`latest.yml`, `Chatward-Setup.exe`) |
| `deploy/home/.env` | domain, tokens and keys, mode 600 |

Backups hold password hashes and the login secret: anyone with a copy can sign in as any member. Keep them private.

## Not done yet
Nightly backups with retention and a restore script, pulling desktop installers from GitHub releases, a health timer,
fail2ban/CrowdSec on Caddy's log, and TURN for friends on very strict networks. See the design doc for the plan.
