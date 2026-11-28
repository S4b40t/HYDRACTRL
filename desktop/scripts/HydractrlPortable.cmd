@echo off
setlocal
if not exist "%~dp0HYDRACTRL.exe" (
  echo Extract all files and keep this launcher next to HYDRACTRL.exe.
  pause
  exit /b 1
)
start "HYDRACTRL Portable" /D "%~dp0" "%~dp0HYDRACTRL.exe"
