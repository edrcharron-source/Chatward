Chatward server (PC-only, local test). Not for cloud servers.
WARNING: do not port-forward this server on your router. It uses plain HTTP, so passwords and login tokens would travel unencrypted to anyone on the internet. Friends outside this PC need the cloud setup below, which uses HTTPS.
1. Install and start Docker Desktop (docker.com/products/docker-desktop).
2. Double-click start-server.bat. First run builds the server (a few minutes).
3. Make a sign-up code: open a terminal in this folder and run  chatward invite
   Install Chatward-Setup.exe, open it, choose Create account and enter the code. Server address: http://localhost:3000
   The first account owns the server. Run chatward invite again for each extra account (chatward help lists the other commands).
4. stop-server.bat stops it. Your chats are kept in a Docker volume.
Optional: put a Klipy API key in .env (copy .env.example) for GIFs, then run start-server.bat again.

Cloud server (AWS Lightsail) for friends outside this PC: use the repo's deploy/ folder, not this bundle.
- Run deploy/docker-compose.yml with DOMAIN set in deploy/.env. It needs a DOMAIN pointing at the server. See deploy/Caddyfile.
- Open only these firewall ports on the instance: TCP 80, 443 and 7881, and UDP 50000-50100.
- This bundle has no HTTPS and is for this PC only.
