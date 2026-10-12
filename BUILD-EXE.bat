@echo off
setlocal
cd /d "%~dp0"
echo ==========================================
echo   DAYMARK TIME TRACKER - WINDOWS EXE
 echo ==========================================
echo.
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js/npm is not installed.
  echo Install Node.js LTS from https://nodejs.org/ and run again.
  pause
  exit /b 1
)
echo Installing application packages (requires internet)...
call npm install
if errorlevel 1 goto :failed
echo.
echo Building Windows installer and portable executable...
call npm run dist:win
if errorlevel 1 goto :failed
echo.
echo SUCCESS! Windows .exe output is in the dist folder.
start "" "%~dp0dist"
pause
exit /b 0
:failed
echo.
echo BUILD FAILED. Read the messages above. Check internet access,
echo Node.js LTS, and Visual Studio Build Tools if native modules failed.
pause
exit /b 1
