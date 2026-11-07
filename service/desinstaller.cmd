@echo off
rem Double-clic : desinstalle le service du deck (voir uninstall-windows.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-windows.ps1"
pause
