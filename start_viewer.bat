@echo off
setlocal
cd /d "%~dp0"
set PORT=8123
set URL=http://localhost:%PORT%/index.html

REM --- find a Python ---------------------------------------------------------
set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY (
  echo.
  echo   No Python found on PATH.
  echo   Open a terminal in this folder and run one of these instead:
  echo       py -m http.server %PORT%
  echo       npx --yes serve -l %PORT% .
  echo   then browse to %URL%
  echo.
  pause
  exit /b 1
)

echo.
echo   Kempsey 3D Flood Viewer
echo   ------------------------------------------------------------
echo   Serving this folder at  %URL%
echo   Your browser will open in about 3 seconds.
echo.
echo   KEEP THIS WINDOW OPEN.  Close it to stop the server.
echo   ------------------------------------------------------------
echo.

REM Open the browser only AFTER the server has had time to bind the port -
REM launching it first is a race and lands on "connection refused".
start "" /min cmd /c "timeout /t 3 /nobreak >nul & explorer %URL%"

%PY% -m http.server %PORT%

echo.
echo   Server stopped.  If it quit immediately, port %PORT% is probably in use -
echo   edit the PORT line at the top of this file and try again.
pause
