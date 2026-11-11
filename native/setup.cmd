@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required for the Zalo Web Call helper. Install it from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)
node "%~dp0setup.js" %*
set ERR=%ERRORLEVEL%
echo.
pause
exit /b %ERR%
