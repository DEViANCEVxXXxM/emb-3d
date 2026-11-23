@echo off
cd /d "%~dp0"
echo.
echo EMBASSY OF BURGERS - 4 ZA 44 000 - 3D
where py >nul 2>&1
if %errorlevel%==0 (
  start "" "http://localhost:8080/"
  py -m http.server 8080
) else (
  where python >nul 2>&1
  if %errorlevel%==0 (
    start "" "http://localhost:8080/"
    python -m http.server 8080
  ) else (
    echo Python ne naiden. Ustanovite Python 3: https://python.org
  )
)
pause
