@echo off
rem Double-clic : installe le deck comme service de session (voir install-windows.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
pause
