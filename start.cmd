@echo off
rem Stagegen launcher: builds anything missing, then starts the server (studio + show outputs + AI gateway).
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & exit /b 1)
where ffmpeg >nul 2>nul || (echo ffmpeg is required on PATH: winget install Gyan.FFmpeg & exit /b 1)

if not exist gateway\node_modules (
  echo Installing AI gateway dependencies...
  pushd gateway & call npm install --no-fund --no-audit & popd
)
if not exist web\dist\index.html (
  echo Building web UI...
  pushd web & call npm install --no-fund --no-audit & call npm run build & popd
)
if not exist core\build\Release\stagegen.exe (
  echo Building C++ core...
  cmake -S core -B core\build -G "Visual Studio 17 2022" -A x64 || exit /b 1
  cmake --build core\build --config Release || exit /b 1
)

start "" http://localhost:8080/
core\build\Release\stagegen.exe %*
