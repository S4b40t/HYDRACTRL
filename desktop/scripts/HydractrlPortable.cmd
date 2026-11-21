@echo off
setlocal
if not exist "%~dp0HYDRACTRL.exe" (
  echo Keep this launcher next to HYDRACTRL.exe in the complete unpacked folder.
  pause
  exit /b 1
)
if /I "%~1"=="biotech" (
  start "HYDRACTRL Portable" /D "%~dp0" "%~dp0HYDRACTRL.exe" "--signature-assist-test-profile=biotech"
) else (
  start "HYDRACTRL Portable" /D "%~dp0" "%~dp0HYDRACTRL.exe"
)
