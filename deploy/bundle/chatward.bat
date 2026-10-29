@echo off
rem The Chatward admin command for this PC's test server. Open a terminal in this folder and run, for example:
rem   chatward invite       make a one-time sign-up code for a new account
rem   chatward help         list every command
cd /d "%~dp0"
docker compose exec -T -e CHATWARD_ADMIN=%USERNAME% server node packages/server/dist/cli.js %*