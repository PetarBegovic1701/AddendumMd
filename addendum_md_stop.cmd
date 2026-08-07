@echo off
REM Stops a running Addendum.md server (including the no-window launcher).
REM Kills only the exact process recorded in server.pid, not every node.exe.
title Stop Addendum.md

setlocal
set "PIDFILE=%~dp0server.pid"

if not exist "%PIDFILE%" (
  echo.
  echo   Addendum.md does not appear to be running ^(no server.pid found^).
  echo   If it is still running, end node.exe in Task Manager.
  echo.
  timeout /t 3 >nul
  exit /b 0
)

set /p PID=<"%PIDFILE%"
echo.
echo   Stopping Addendum.md ^(process %PID%^)...
taskkill /F /PID %PID% >nul 2>nul
if errorlevel 1 (
  echo   It was not running anymore.
) else (
  echo   Stopped.
)
del "%PIDFILE%" >nul 2>nul
echo.
timeout /t 3 >nul
