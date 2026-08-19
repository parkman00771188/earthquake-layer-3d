@echo off
setlocal

echo ============================================
echo  Earthquake 4D  -  auto update STOP
echo ============================================
echo.

schtasks /Query /TN "EarthquakeAutoUpdate" >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo [ok] auto update is not registered -- nothing to stop.
  pause
  exit /b 0
)

rem Stop a cycle that is mid-run, then remove the schedule.
schtasks /End /TN "EarthquakeAutoUpdate" >nul 2>nul
schtasks /Delete /F /TN "EarthquakeAutoUpdate" >nul
if %ERRORLEVEL% NEQ 0 (
  echo [!] could not remove the scheduled task
  pause
  exit /b 1
)

del "%TEMP%\earthquake_auto_update.lock" 2>nul
echo [ok] auto update stopped and unregistered.
pause
exit /b 0
