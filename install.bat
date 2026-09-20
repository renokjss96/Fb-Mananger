@echo off
cd /d "%~dp0"
set "NODEDIR=%~dp0..\FB Cookie\node-v22.14.0-win-x64"
set "NPM=%NODEDIR%\npm.cmd"
if not exist "%NPM%" (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo Khong tim thay npm. Can Node.js hoac thu muc FB Cookie\node-v22.14.0-win-x64
    pause
    exit /b 1
  )
  set "NPM=npm"
)
echo Dang cai dat dependencies...
call "%NPM%" install
if errorlevel 1 (
  echo Cai dat that bai.
  pause
  exit /b 1
)
echo Xong. Chay start.bat de mo app.
pause
