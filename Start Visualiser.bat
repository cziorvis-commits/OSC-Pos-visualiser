@echo off
REM Windows: double-click to start the OSC Position Visualiser.
title OSC Position Visualiser
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is needed to run the OSC Position Visualiser.
  echo Install the LTS version from https://nodejs.org then double-click this launcher again.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

echo Starting OSC Position Visualiser...
node bridge\server.js --open
echo.
echo Visualiser stopped.
pause
