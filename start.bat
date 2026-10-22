@echo off
REM One-click start for Windows. Double-click this file.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules call npm install --no-audit --no-fund
call npm start
pause
