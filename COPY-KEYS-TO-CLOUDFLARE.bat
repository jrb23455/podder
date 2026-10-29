@echo off
cd /d "%~dp0"
echo Copying Podder keys from Vercel to Cloudflare (names only are shown, never values)...
echo.
node scripts\copy-secrets-to-cf.mjs
echo.
echo Finished. Copy everything above into the chat with Claude, then close this window.
pause
