@echo off
setlocal
cd /d "%~dp0"
"C:\Users\lycheelli\.workbuddy\binaries\PortableGit\versions\1.2.0\bin\bash.exe" "%~dp0release.sh" %*
if errorlevel 1 (
  echo.
  echo 发布失败，请查看上方错误。
  pause
  exit /b 1
)
echo.
echo 发布完成。
pause
