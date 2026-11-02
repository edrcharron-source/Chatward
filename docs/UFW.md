# Locking down the home server with ufw

Run these on the server yourself (they need sudo). Nothing here is applied by the repo. Replace the placeholders:
`LAN_IP` is the server's fixed LAN address, `LAN_NET` is your LAN range (for example `192.168.1.0/24`), and
`chat.example.com` is your Chatward domain.

## What should be reachable from where

| Port | Service | Who may reach it |
|---|---|---|
| 443/tcp | Chatward (Caddy) | Internet |
| 7881/tcp, 7882/udp | LiveKit voice | Internet |
| 22/tcp | SSH | LAN and Tailscale only |
| anything else | Other services on the box | LAN and Tailscale only, or the box itself |

Tailscale is `100.64.0.0/10` (or the `tailscale0` interface). Services without a login of their own should listen on
`127.0.0.1` only.

## Important: Docker ignores ufw

Docker publishes ports by writing its own iptables rules that run before ufw's. A rule like `ufw deny 8000` does
**nothing** for a port published by a container (LiveKit and Caddy included). Host services (sshd, nginx and so on) are
filtered normally.

For container ports, use one of these:
1. **Bind them to the right address** in the compose file (best). Example: `LAN_IP:8000:8000`, or `127.0.0.1:8000:8000`
   if only the box itself needs it. Chatward's home profile already binds Caddy and LiveKit to `LAN_IP`.
2. **Filter in the `DOCKER-USER` chain**, which Docker leaves alone. Example that blocks everything but the LAN from
   reaching container port 8000:
   ```
   sudo iptables -I DOCKER-USER -p tcp --dport 8000 ! -s LAN_NET -j DROP
   ```
   This does not survive reboot unless you save it (`sudo apt install iptables-persistent`, then
   `sudo netfilter-persistent save`). The `DOCKER-USER` match is on the container's port after address translation, so
   use the port inside the container.

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
   sudo ufw allow from LAN_NET to any port 22 proto tcp
   sudo ufw allow in on tailscale0 to any port 22 proto tcp
   ```
4. Allow the internet-facing ports (443 and the voice ports are container ports, so these rules are only for
   documentation):
   ```
   sudo ufw allow 443/tcp
   sudo ufw allow 7881/tcp
   sudo ufw allow 7882/udp
   ```
5. Allow each other host service the LAN uses, from the LAN and Tailscale only:
   ```
   sudo ufw allow from LAN_NET to any port <port> proto tcp
   sudo ufw allow in on tailscale0 to any port <port> proto tcp
   ```
6. Remove rules you no longer want (list with `sudo ufw status numbered`, then delete by number, highest first):
   ```
   sudo ufw delete <number>
   ```
   In particular delete any old `50000:50100/udp` voice rule; Chatward now uses 7882/udp only.
7. Turn it on and check:
   ```
   sudo ufw enable
   sudo ufw status verbose
   ```
   Then test: `https://chat.example.com/api/health`, a Chatward call, SSH from your PC, and each LAN service you allowed.

If anything breaks and you can't tell why, `sudo ufw disable` puts you back where you were (Docker's rules stay).

## The router

ufw can't protect you from a wrong port forward. Forward only:

- 443/tcp to `LAN_IP`
- 7881/tcp to `LAN_IP` (check it is TCP, not UDP)
- 7882/udp to `LAN_IP`

Also check that **no** other forward exists (22 and 80 especially), and that remote access to the router itself is off
on the WAN side (test from your phone on cellular).

## SSH hardening

cloud-init can switch password logins back on after you turned them off. Check the effective setting:
```
sudo sshd -T | grep -Ei 'passwordauthentication|permitrootlogin|pubkeyauthentication'
```
You want `passwordauthentication no` and `permitrootlogin no`. If a file in `/etc/ssh/sshd_config.d/` (for example
`50-cloud-init.conf`) says otherwise, change it there, then `sudo systemctl reload ssh`. Keep a session open while you
test a fresh login.

## Optional extras

- **fail2ban** for sshd: `sudo apt install fail2ban`. Low priority while SSH is not forwarded.
- **Unattended upgrades:** `sudo apt install unattended-upgrades` keeps the host patched.
