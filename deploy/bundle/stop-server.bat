@echo off
cd /d "%~dp0"
docker compose down
echo Server stopped. Your data is kept.
pause
