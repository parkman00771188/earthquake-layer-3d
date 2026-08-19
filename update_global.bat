@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  Earthquake 4D  -  full data update
echo  (Japan + worldwide, one pass)
echo ============================================
echo.

where py >nul 2>nul && (set PY=py) || (set PY=python)

echo --- [1/3] Japan ------------------------------------
%PY% scripts\update.py
if %ERRORLEVEL% NEQ 0 (
  echo [!] Japan update failed -- rerun to resume from the checkpoint
  if "%1"=="" pause
  exit /b 1
)

echo.
echo --- [2/3] worldwide --------------------------------
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
if %RC% NEQ 0 (
  echo [!] worldwide build failed with code %RC%
  if "%1"=="" pause
  exit /b %RC%
)

echo.
echo --- [3/3] what changed -----------------------------
%PY% scripts\global_changes.py

%PY% scripts\archive_raw.py

echo.
echo [ok] Japan + worldwide data updated. Reload the page with Ctrl+F5.
echo      Japan item-by-item report:  update.bat --changes

if "%1"=="" pause
exit /b 0
