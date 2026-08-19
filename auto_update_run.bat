@echo off
rem One cycle of the scheduled auto refresh: update Japan + worldwide data,
rem then upload to GitHub Pages. Runs hidden every 30 minutes while
rem auto_update_start.bat is active -- see auto_update_stop.bat to stop.
rem Everything is logged to data\raw\auto_update.log.
setlocal
cd /d "%~dp0"

rem Never let two cycles overlap (a slow network run + the next trigger).
rem A lock older than 25 minutes is a leftover from a crashed cycle, not a
rem running one -- clear it instead of blocking every future run.
set LOCK=%TEMP%\earthquake_auto_update.lock
powershell -NoProfile -Command "$l = Join-Path $env:TEMP 'earthquake_auto_update.lock'; if ((Test-Path $l) -and ((Get-Date) - (Get-Item $l).LastWriteTime).TotalMinutes -gt 25) { Remove-Item $l -Force }" >nul 2>nul
if exist "%LOCK%" exit /b 0
echo running > "%LOCK%"

set LOG=data\raw\auto_update.log

rem Rotate the log at ~2 MB so it never grows without bound.
for %%F in ("%LOG%") do if %%~zF GTR 2000000 move /y "%LOG%" "%LOG%.old" >nul 2>nul

echo.>> "%LOG%"
echo ================ %DATE% %TIME% ================>> "%LOG%"

call "%~dp0update_global.bat" auto >> "%LOG%" 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [auto] update failed rc=%ERRORLEVEL% -- upload skipped>> "%LOG%"
  del "%LOCK%" 2>nul
  exit /b 1
)

where py >nul 2>nul && (set PY=py) || (set PY=python)
%PY% scripts\upload_github.py --auto >> "%LOG%" 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [auto] upload failed rc=%ERRORLEVEL%>> "%LOG%"
  del "%LOCK%" 2>nul
  exit /b 1
)

echo [auto] cycle done %DATE% %TIME%>> "%LOG%"
del "%LOCK%" 2>nul
exit /b 0
