@echo off
rem Starts Reelhouse on Windows: double-click this file, or run it from a command prompt. Stop it with Ctrl+C.
rem
rem Needs Node.js 22.13 or newer (https://nodejs.org) and ffmpeg (winget install Gyan.FFmpeg). The packages Reelhouse
rem uses are installed the first time, and again after an update that changes them.
rem
rem Settings such as the port are in the web app. The environment variables in the README's Configuration table can be
rem set first, e.g. "set PORT=8585" and then start.bat. To start Reelhouse when you sign in, see the README's
rem "Running at startup".
setlocal
cd /d "%~dp0"
title Reelhouse

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed, or isn't on the PATH. Install Node.js 22.13 or newer from https://nodejs.org and run this again.
  goto failed
)
node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)"
if errorlevel 1 (
  for /f %%v in ('node -v') do echo Reelhouse needs Node.js 22.13 or newer; this is %%v. Install a newer one from https://nodejs.org and run this again.
  goto failed
)
where ffmpeg >nul 2>nul
if errorlevel 1 echo Note: ffmpeg isn't on the PATH. Install it with "winget install Gyan.FFmpeg", or set its path in Settings, Transcoder.

rem First run, or an update that changed the packages: install them as the lock file says.
call npm ls --omit=dev --depth=0 >nul 2>nul
if errorlevel 1 (
  echo Installing Reelhouse's packages...
  call npm ci --omit=dev
  if errorlevel 1 goto failed
)

node --disable-warning=ExperimentalWarning server\index.js
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Reelhouse didn't start, or stopped with an error (see above).
pause
exit /b 1
