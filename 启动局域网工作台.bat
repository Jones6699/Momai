@echo off
setlocal
cd /d "%~dp0"
set NOVEL_LAN=1
echo 墨脉创作台局域网模式：http://127.0.0.1:4173
echo 手机与电脑连接同一 Wi-Fi 后，在墨脉桥中使用局域网配对码。
pushd "%~dp0web"
start "Momai LAN" cmd /k "set NOVEL_LAN=1&& node server.mjs"
popd
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173"
endlocal
