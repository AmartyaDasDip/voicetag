@echo off
setlocal
cd /d "%~dp0"
title VoiceTag - test run
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Run BUILD.bat first - it explains what to do.
  pause
  exit /b 1
)
if not exist "model\model.tar.gz" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "tools\get-model.ps1"
)
if not exist "node_modules\electron" (
  echo Downloading app components, please wait...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Something went wrong. Take a screenshot and send it to Claude.
    pause
    exit /b 1
  )
)
call npx electron .
