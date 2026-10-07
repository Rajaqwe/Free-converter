@echo off
cd /d "%~dp0\backend"
echo Starting PDF/AI -^> PLT Conversion Backend on port 10000...
set PORT=10000
set HOST=0.0.0.0
set ALLOWED_ORIGINS=*
node server.js
pause
