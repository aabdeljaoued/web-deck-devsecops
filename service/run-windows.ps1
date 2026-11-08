# Boucle de service Windows (lancée cachée à l'ouverture de session par install-windows.ps1) :
# relance le deck s'il s'arrête sur une erreur ou une demande de redémarrage (code de sortie différent de 0).
# Journal : %LOCALAPPDATA%\web-deck-devsecops\deck.log
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDir = Join-Path $env:LOCALAPPDATA "web-deck-devsecops"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "deck.log"
if (Test-Path (Join-Path $root "node\node.exe")) { $env:PATH = (Join-Path $root "node") + ";" + $env:PATH }
$env:DECK_SUPERVISOR = "windows"

while ($true) {
    # Première fois, ou dépendances modifiées (git pull) : même logique que start.cmd
    & node server\needs-install.mjs
    if ($LASTEXITCODE -eq 0) {
        & npm install --omit=dev *>> $log
        & node server\needs-install.mjs --done
    }
    # Journal de plus de 1 Mo : mis de côté (.1, le précédent est remplacé) avant le lancement
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) { Move-Item -Force $log "$log.1" }
    & node server\index.mjs --no-open *>> $log
    if ($LASTEXITCODE -eq 0) { break }   # arrêt normal (ou deck déjà lancé ailleurs) : pas de relance
    Add-Content -Path $log -Value "--- arrêt (code $LASTEXITCODE), relance dans 3 s"
    Start-Sleep -Seconds 3
}
