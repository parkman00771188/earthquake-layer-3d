@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  Earthquake 4D  -  GitHub upload + deploy
echo ============================================
echo.

where py >nul 2>nul && (set PY=py) || (set PY=python)

rem Keep the raw-data backups in sync (skips instantly when nothing changed).
%PY% scripts\archive_raw.py

set MSG=%*
if "%MSG%"=="" set MSG=manual upload %DATE% %TIME%

%PY% scripts\upload_github.py "%MSG%"
set RC=%ERRORLEVEL%

echo.
if %RC% NEQ 0 (
  echo [!] upload failed with code %RC% -- run again to retry
) else (
  echo [ok] uploaded. The live site refreshes itself in a few minutes:
  echo      https://parkman00771188.github.io/earthquake-layer-3d/
)

if "%1"=="" pause
exit /b %RC%
