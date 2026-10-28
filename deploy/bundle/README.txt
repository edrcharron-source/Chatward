Chatward server (local test)
1. Install and start Docker Desktop (docker.com/products/docker-desktop).
2. Double-click start-server.bat. First run builds the server (a few minutes).
3. Install Chatward-Setup.exe, open it, register, and you're in. Server address: http://localhost:3000
4. stop-server.bat stops it. Your chats are kept in a Docker volume.
Optional: put a Klipy API key in .env (copy .env.example) for GIFs, then run start-server.bat again.

Cloud server (AWS Lightsail) for friends outside this PC:
- Use the HTTPS setup in deploy/ (Caddy, see deploy/Caddyfile and deploy/docker-compose.yml). It needs a DOMAIN pointing at the server.
- Open only these firewall ports on the instance: TCP 80, 443 and 7881, and UDP 50000-50100.
- This bundle has no HTTPS. It is for this PC only, so leave LIVEKIT_URL unset.
