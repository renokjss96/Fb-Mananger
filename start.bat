@echo off
cd /d "%~dp0"
set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" set "ELECTRON=%~dp0..\FB Cookie\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo Chua cai dat Electron. Hay chay install.bat
  pause
  exit /b 1
)
start "" "%ELECTRON%" "%~dp0"
