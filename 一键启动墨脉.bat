@echo off
setlocal
cd /d "%~dp0"
title Momai
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required.
  pause
  exit /b 1
)
for /f "delims=" %%P in ('powershell -NoProfile -Command "$x=Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue; if($x){$x[0].OwningProcess}"') do set "PORT_PID=%%P"
if defined PORT_PID goto open_app
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; $wd=(Get-Location).Path; Start-Process -FilePath (Get-Command node).Source -ArgumentList 'web/server.mjs' -WorkingDirectory $wd -WindowStyle Hidden; for($i=0;$i -lt 30;$i++){Start-Sleep -Milliseconds 300; try{$r=Invoke-WebRequest 'http://127.0.0.1:4173/api/settings' -UseBasicParsing -TimeoutSec 1;if($r.StatusCode -eq 200){$ok=$true;break}}catch{}}; if(-not $ok){exit 1}"
if errorlevel 1 (
  echo Failed to start Momai on port 4173.
  pause
  exit /b 1
)
:open_app
start "" "http://127.0.0.1:4173/"
endlocal
