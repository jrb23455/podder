@echo off
cd /d "%~dp0"
node scripts\enter-cf-keys.mjs
echo.
echo Finished. Copy the Saved / Not saved lines into the chat with Claude, then close this window.
pause
