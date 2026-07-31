@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul && (set PY=py) || (set PY=python)

if "%1"=="" ( set PORT=8080 ) else ( set PORT=%1 )

echo Starting local server on http://localhost:%PORT%/
echo Press Ctrl+C to stop.
echo.

%PY% scripts\serve.py %PORT%
