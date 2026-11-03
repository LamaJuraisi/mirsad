@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Download the LTS version from https://nodejs.org , install it, then double-click start.bat again.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

echo.
echo Checking which news feeds work...
call npm run check-feeds

echo.
echo Starting Mirsad at http://localhost:8787  -  keep this window open, close it to stop.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8787"
node server.js
pause
