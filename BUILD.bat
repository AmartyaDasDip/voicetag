@echo off
setlocal
cd /d "%~dp0"
title VoiceTag - building the Windows installer
echo.
echo  ==========================================================
echo     VoiceTag - building the Windows installer
echo     This takes 5-15 minutes the first time. Keep this
echo     window open and stay connected to the internet.
echo  ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :nonode

echo [1/4] Node.js found:
node -v
echo.

echo [2/4] Getting the offline voice model - about 40 MB, only once...
if exist "model\model.tar.gz" (
  echo       already downloaded.
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "tools\get-model.ps1"
  if errorlevel 1 goto :fail
)
echo.

echo [3/4] Downloading app components - Electron and ffmpeg...
call npm ci --no-audit --no-fund
if errorlevel 1 goto :fail
echo.

echo [4/4] Building the installer...
call npx electron-builder --win nsis --x64
if errorlevel 1 (
  echo.
  echo  First attempt failed - trying again in safe mode...
  call npx electron-builder --win nsis --x64 -c.win.signAndEditExecutable=false
  if errorlevel 1 goto :fail
)

echo.
echo  ==========================================================
echo     DONE!  Your installer is in the "dist" folder:
echo     VoiceTag-Setup-1.0.0.exe
echo     Double-click it to install VoiceTag.
echo  ==========================================================
start "" "%~dp0dist"
pause
exit /b 0

:nonode
echo  Node.js is not installed yet.
echo.
echo  1. A web page will open now. Download the "LTS" Windows Installer (.msi).
echo  2. Install it - just click Next until it finishes.
echo  3. Close this window and double-click BUILD.bat again.
echo.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:fail
echo.
echo  ----------------------------------------------------------
echo   Something went wrong. Take a screenshot of this window
echo   and send it to Claude.
echo  ----------------------------------------------------------
pause
exit /b 1
