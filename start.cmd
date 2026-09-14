@echo off
REM ---------------------------------------------------------------------------
REM Launch the DSH Control Panel.
REM
REM Preferred: the desktop app (Electron) -- a real window, no browser tab.
REM Fallback : browser mode, which needs nothing but Node itself.
REM
REM Re-running this script is always safe: a second instance of the desktop app
REM just focuses the existing window, and the browser-mode server notices the
REM port is taken and exits quietly.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   node.exe was not found on PATH.
  echo   Install Node.js 22.5 or newer from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "."
  exit /b 0
)

REM No local Electron build: fall back to the zero-dependency browser mode.
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'src\cli.mjs' -WorkingDirectory '%CD%' -WindowStyle Hidden"

REM Give the listener a moment to bind before the browser races it.
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){ try{ (Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:8791/api/health').StatusCode | Out-Null; break }catch{ Start-Sleep -Milliseconds 150 } }"

start "" "http://127.0.0.1:8791"
endlocal
