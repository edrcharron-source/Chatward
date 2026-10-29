# Locking down lebserver with ufw

Written after the port review in #246. Run these on lebserver yourself (they need sudo). Nothing here is applied by the repo.

## What should be reachable from where

| Port | Service | Who may reach it |
|---|---|---|
| 443/tcp | Chatward (Caddy) | Internet |
| 7881/tcp, 7882/udp | LiveKit voice | Internet (after the single-port change #299; before it, 50000-50100/udp instead of 7882) |
| 22/tcp | SSH | LAN and Tailscale only |
| 80/tcp | Pelican panel (nginx) | LAN and Tailscale only |
| 8080/tcp, 2022/tcp | Pelican Wings API and SFTP | LAN and Tailscale only |
| 139, 445/tcp, 137, 138/udp | Samba | LAN and Tailscale only |
| 3000/tcp | lebai | LAN and Tailscale only |
| 3001, 4000/tcp | Grafana, TeslaMate | LAN and Tailscale only |
| 8096/tcp | Jellyfin | LAN and Tailscale only |
| 11434/tcp | Ollama (no login) | LAN only, ideally nobody but the box itself |
| 7777/udp | Game server | Only if friends play from outside; otherwise LAN and Tailscale |
| 7778/udp | Game status port | LAN and Tailscale only. Never forward it |

LAN is `192.168.1.0/24`. Tailscale is `100.64.0.0/10` (or the `tailscale0` interface).

## Important: Docker ignores ufw

Docker publishes ports by writing its own iptables rules that run before ufw's. A rule like `ufw deny 11434` does **nothing** for a port published by a container (Ollama, LiveKit, Caddy, Portainer, TeslaMate). Host services (sshd, nginx, smbd, Wings if it runs on the host) are filtered normally.

For container ports, use one of these:
1. **Bind them to the right address** in the compose file (best). Example: `192.168.1.228:11434:11434`, or `127.0.0.1:11434:11434` if only the box itself needs it. #299 does this for LiveKit.
2. **Filter in the `DOCKER-USER` chain**, which Docker leaves alone. Example that blocks everything but the LAN from reaching container port 11434:
   ```
   sudo iptables -I DOCKER-USER -p tcp --dport 11434 ! -s 192.168.1.0/24 -j DROP
   ```
   This does not survive reboot unless you save it (`sudo apt install iptables-persistent`, then `sudo netfilter-persistent save`). The `DOCKER-USER` match is on the container's port after address translation, so use the port inside the container.

## Step by step (host services)

Do this with a second SSH session open, so a mistake can't lock you out.

1. Look at what is there first:
   ```
   sudo ufw status verbose numbered
   ```
2. Set the defaults:
   ```
   sudo ufw default deny incoming
   sudo ufw default allow outgoing
   ```
3. Allow SSH **before** enabling anything (LAN and Tailscale only):
   ```
   sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
   sudo ufw allow in on tailscale0 to any port 22 proto tcp
   ```
4. Allow the internet-facing ports (443 is a container port, so this rule is only for documentation; the voice ports likewise):
   ```
   sudo ufw allow 443/tcp
   sudo ufw allow 7881/tcp
   sudo ufw allow 7882/udp
   ```
5. Allow the LAN-only services from the LAN and Tailscale:
   ```
   for p in 80 8080 2022 3000 3001 4000 8096 139 445; do
     sudo ufw allow from 192.168.1.0/24 to any port $p proto tcp
     sudo ufw allow in on tailscale0 to any port $p proto tcp
   done
   for p in 137 138; do
     sudo ufw allow from 192.168.1.0/24 to any port $p proto udp
     sudo ufw allow in on tailscale0 to any port $p proto udp
   done
   sudo ufw allow from 192.168.1.0/24 to any port 7777 proto udp
   sudo ufw allow in on tailscale0 to any port 7777 proto udp
   ```
   Add `sudo ufw allow 7777/udp` instead if friends outside the house play on the game server.
6. Remove rules you no longer want (list with `sudo ufw status numbered`, then delete by number, highest first):
   ```
   sudo ufw delete <number>
   ```
   In particular delete any `50000:50100/udp` rule once #299 is deployed and the router forward is swapped.
7. Turn it on and check:
   ```
   sudo ufw enable
   sudo ufw status verbose
   ```
   Then test: `https://chat.lebserver.com/api/health`, a Chatward call, SSH from your PC, the Pelican panel and Jellyfin from your PC.

If anything breaks and you can't tell why, `sudo ufw disable` puts you back where you were (Docker's rules stay).

## Container ports to bind or filter

| Port | Container | Fix |
|---|---|---|
| 11434 | Ollama | Bind to `127.0.0.1` or the Docker network once LebBot talks to it internally. Until then, `DOCKER-USER` rule above |
| 7881, 7882 | LiveKit | Bound to the LAN address by #299, so Tailscale and IPv6 no longer reach them |
| 9443 | Portainer | Already `127.0.0.1` only |
| 3001, 4000 | TeslaMate | Bind to the Tailscale address if you don't want LAN access |

## The router

ufw can't protect you from a wrong port forward. In UniFi, forward only:

- 443/tcp to 192.168.1.228
- 7881/tcp to 192.168.1.228 (check it is TCP, not UDP)
- 7882/udp to 192.168.1.228 (after the single-port PR; replaces 50000-50100/udp)

Also check that **no** forward exists for 22, 80, 8080, 2022, 11434, 7778, and that remote access to the gateway itself is off on the WAN side (test from your phone on cellular).

## SSH hardening

cloud-init can switch password logins back on after you turned them off. Check the effective setting:
```
sudo sshd -T | grep -Ei 'passwordauthentication|permitrootlogin|pubkeyauthentication'
```
You want `passwordauthentication no` and `permitrootlogin no`. If a file in `/etc/ssh/sshd_config.d/` (for example `50-cloud-init.conf`) says otherwise, change it there, then `sudo systemctl reload ssh`. Keep a session open while you test a fresh login.

## Optional extras

- **fail2ban** for sshd: `sudo apt install fail2ban`. Low priority while SSH is not forwarded.
- **Unattended upgrades:** `sudo apt install unattended-upgrades` keeps the host patched.
