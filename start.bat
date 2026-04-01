@echo off
title BilliSync Arduino Bridge
echo ================================
echo   BilliSync Arduino Bridge
echo   Starting server...
echo ================================
cd /d "%~dp0"
node server.js
pause
