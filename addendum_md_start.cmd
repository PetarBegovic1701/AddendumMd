@echo off
REM Addendum.md launcher (Windows). Double-click this file to start the app.
REM Usage: start.cmd [rootDir] [port]
REM Default root = whatever folder you last picked in the app (config.json),
REM or the w-m-c-e repo (two levels up) on a first run. Default port = 8888.
title Addendum.md

setlocal
REM Left empty, the server falls back to its saved root - so the folder you
REM chose in the UI survives a restart. Only seed a default when there is no
REM saved config yet, i.e. the very first launch.
set "ROOT=%~1"
if "%ROOT%"=="" if not exist "%~dp0config.json" set "ROOT=%~dp0..\.."
set "PORT=%~2"
if "%PORT%"=="" set "PORT=8888"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   1^) Go to https://nodejs.org  and install the "LTS" version.
  echo   2^) Then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Addendum.md...  a browser tab will open shortly.
echo   Keep this window open while you use the app.
echo.

node "%~dp0server.js" "%ROOT%" %PORT%

echo.
echo   Addendum.md has stopped. You can close this window.
pause
