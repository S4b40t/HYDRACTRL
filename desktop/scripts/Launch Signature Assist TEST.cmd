@echo off
setlocal
set "TEST_PROFILE=main"
if /I "%~1"=="biotech" set "TEST_PROFILE=biotech"
if not exist "%~dp0HYDRACTRL.exe" (
  echo Keep this launcher next to HYDRACTRL.exe in the complete unpacked folder.
  pause
  exit /b 1
)
start "HYDRACTRL Signature Assist TEST" /D "%~dp0" "%~dp0HYDRACTRL.exe" "--user-data-dir=%~dp0signature-test-data\%TEST_PROFILE%" "--signature-assist-test-profile=%TEST_PROFILE%"
