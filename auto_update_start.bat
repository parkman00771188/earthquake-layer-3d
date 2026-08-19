@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  Earthquake 4D  -  auto update START
echo ============================================
echo.
echo This registers a Windows scheduled task that refreshes the data
echo (Japan + worldwide) and uploads it to the website every 30 minutes
echo while this PC is on and you are logged in. It runs silently in the
echo background; progress is written to data\raw\auto_update.log.
echo.

schtasks /Create /F /SC MINUTE /MO 30 /TN "EarthquakeAutoUpdate" ^
  /TR "wscript.exe \"%~dp0scripts\run_hidden.vbs\"" >nul
if %ERRORLEVEL% NEQ 0 (
  echo [!] could not register the scheduled task
  pause
  exit /b 1
)

echo [ok] scheduled task "EarthquakeAutoUpdate" registered (every 30 min).
echo [ok] kicking off the first cycle now...
schtasks /Run /TN "EarthquakeAutoUpdate" >nul

echo.
echo  - watch progress :  type data\raw\auto_update.log
echo  - stop           :  auto_update_stop.bat
echo.
pause
exit /b 0
