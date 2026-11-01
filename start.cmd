@echo off
rem Lance le deck : Node.js portable dans .\node\ s'il existe, sinon celui du PATH.
cd /d "%~dp0"
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
where node >nul 2>nul || (
    echo Node.js introuvable : extraire le zip Windows de nodejs.org dans le dossier "node" du projet.
    pause
    exit /b 1
)
rem Premiere fois, ou dependances modifiees depuis la derniere installation (git pull)
node server\needs-install.mjs
if not errorlevel 1 (
    echo Installation des dependances...
    call npm install --omit=dev || (pause & exit /b 1)
    node server\needs-install.mjs --done
)
node server\index.mjs %*
if errorlevel 1 pause
