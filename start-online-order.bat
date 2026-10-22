@echo off
setlocal
title Chiu Food - Build and Start
cd /d "%~dp0"
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\cloudflared;%ProgramFiles(x86)%\cloudflared;%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"

if not exist ".env" (
    echo ERROR: Missing .env in the project folder. Restore your server configuration first.
    goto failed
)

where node >nul 2>nul
if errorlevel 1 (
    echo Installing Node.js LTS...
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if errorlevel 1 goto failed
    echo Node.js installed. Close this window and double-click this file again.
    pause
    exit /b 0
)

node -e "const [major,minor]=process.versions.node.split('.').map(Number); if(major<22 || (major===22 && minor<12)){console.error('Node.js 22.12 or newer is required. Install the current Node.js LTS.');process.exit(1)}"
if errorlevel 1 goto failed

where npm.cmd >nul 2>nul
if errorlevel 1 goto failed
where cloudflared >nul 2>nul
if errorlevel 1 (
    echo Installing Cloudflare Tunnel...
    winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
    if errorlevel 1 goto failed
    echo Cloudflare Tunnel installed. Close this window and double-click this file again.
    pause
    exit /b 0
)

echo [1/4] Checking dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto failed

echo [2/4] Checking server syntax...
node --check server.js
if errorlevel 1 goto failed

echo [3/4] Building frontend...
call npm run build:app
if errorlevel 1 goto failed

echo [4/4] Starting server and fixed-domain tunnel...
node scripts/start-windows.js
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Startup stopped. Read the error above. See WINDOWS-START.md for setup instructions.
pause
exit /b 1
