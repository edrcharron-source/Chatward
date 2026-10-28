@echo off
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
echo Starting Chatward server (first run takes a few minutes)...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo Could not start. Is Docker Desktop running? Open it, wait until it says "running", then try again.
  pause
  exit /b 1
)
echo.
echo Chatward server is running. Open the Chatward app and use the server address http://localhost:3000
pause
