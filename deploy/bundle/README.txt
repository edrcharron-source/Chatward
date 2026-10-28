Chatward server (local test)
1. Install and start Docker Desktop (docker.com/products/docker-desktop).
2. Double-click start-server.bat. First run builds the server (a few minutes).
3. Install Chatward-Setup.exe, open it, register, and you're in. Server address: http://localhost:3000
4. stop-server.bat stops it. Your chats are kept in a Docker volume.
Optional: put a Klipy API key in .env (copy .env.example) for GIFs, then run start-server.bat again.
