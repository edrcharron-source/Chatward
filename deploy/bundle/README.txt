Chatward server (local test)
1. Install and start Docker Desktop (docker.com/products/docker-desktop).
2. Double-click start-server.bat. First run builds the server (a few minutes).
3. Install Chatward-Setup.exe, open it, register, and you're in. Server address: http://localhost:3000
4. stop-server.bat stops it. Your chats are kept in a Docker volume.
Optional: put a Klipy API key in .env (copy .env.example) for GIFs, then run start-server.bat again.

Cloud server (AWS Lightsail) for friends outside this PC:
- Open these firewall ports on the instance: TCP 7880 and 7881, UDP 50000-50100, and TCP 3000 (or 443 once HTTPS is set up).
- In .env, set LIVEKIT_URL=ws://YOUR-SERVER-PUBLIC-IP:7880 (use the public IP, not localhost).
- Voice needs those ports open. Without them, text still works but calls fail.
