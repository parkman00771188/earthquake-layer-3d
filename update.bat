@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  Japan Quake 4D  -  data update
echo ============================================
echo.

where py >nul 2>nul && (set PY=py) || (set PY=python)

%PY% scripts\update.py %*
set RC=%ERRORLEVEL%

echo.
if %RC% NEQ 0 (
  echo [!] update failed with code %RC%
  echo     tip: run  update.bat --resume  to continue an interrupted scan
) else (
  echo [ok] data updated. Reload the page with Ctrl+F5.
)

if "%1"=="" pause
exit /b %RC%
