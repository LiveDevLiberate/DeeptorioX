@echo off
rem Windows entry point: build if needed, then invoke the run CLI.
rem Usage:  autorio.cmd start smoke
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0autorio.ps1" %*
exit /b %ERRORLEVEL%
