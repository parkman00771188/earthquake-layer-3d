@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  Earthquake 4D  -  worldwide data update
echo ============================================
echo.

where py >nul 2>nul && (set PY=py) || (set PY=python)

%PY% scripts\fetch_global.py
if %ERRORLEVEL% NEQ 0 (
  echo [!] USGS fetch failed -- rerun to resume from the checkpoint
  if "%1"=="" pause
  exit /b 1
)

%PY% scripts\fetch_isc_global.py
if %ERRORLEVEL% NEQ 0 (
  echo [!] ISC fetch failed -- rerun to resume from the checkpoint
  if "%1"=="" pause
  exit /b 1
)

%PY% scripts\build_global.py
set RC=%ERRORLEVEL%

echo.
if %RC% NEQ 0 (
  echo [!] build failed with code %RC%
) else (
  echo [ok] worldwide data updated. Reload the page with Ctrl+F5.
)

if "%1"=="" pause
exit /b %RC%
