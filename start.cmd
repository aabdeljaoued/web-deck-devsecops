@echo off
rem Lance le deck : Node.js portable dans .\node\ s'il existe, sinon celui du PATH.
cd /d "%~dp0"
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
where node >nul 2>nul || (
    echo Node.js introuvable : extraire le zip Windows de nodejs.org dans le dossier "node" du projet.
    pause
    exit /b 1
)
if not exist node_modules (
    echo Installation des dependances...
    call npm install --omit=dev || (pause & exit /b 1)
)
node server\index.mjs %*
if errorlevel 1 pause
