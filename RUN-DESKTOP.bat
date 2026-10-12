@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
 echo Install Node.js LTS from https://nodejs.org/ first.
 pause
 exit /b 1
)
if not exist "node_modules\electron" (
 echo Installing dependencies (requires internet)...
 call npm install
 if errorlevel 1 (pause & exit /b 1)
)
call npm start
if errorlevel 1 pause
