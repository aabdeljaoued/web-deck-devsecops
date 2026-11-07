# Installe le deck comme service de session Windows (sans droits admin) :
#   - lancé caché à l'ouverture de session (dossier Démarrage), sans fenêtre de console ;
#   - relancé s'il s'arrête sur une erreur (ou via Réglages > Redémarrer) ;
#   - journal : %LOCALAPPDATA%\web-deck-devsecops\deck.log
# Désinstaller : service\desinstaller.cmd
$root = Split-Path -Parent $PSScriptRoot
$run = Join-Path $PSScriptRoot "run-windows.ps1"
$startup = [Environment]::GetFolderPath("Startup")
$vbs = Join-Path $startup "web-deck-devsecops.vbs"

# Lanceur caché (0 = fenêtre masquée) ; guillemets doublés pour VBScript
$cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """"$run"""""
Set-Content -Path $vbs -Encoding Unicode -Value "CreateObject(""WScript.Shell"").Run ""$cmd"", 0, False"

# Deck lancé à la main (fenêtre start.cmd) : arrêté pour libérer le port (les terminaux seront rouverts)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*server\index.mjs*" } |
    ForEach-Object { Write-Host "Arrêt du deck lancé à la main (PID $($_.ProcessId))..."; Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1

Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbs`""
Write-Host "Service installé : $vbs"
Write-Host "  Journal : $env:LOCALAPPDATA\web-deck-devsecops\deck.log"

# Ouvre le deck une fois le serveur prêt
$port = 7777
$m = Select-String -Path (Join-Path $root "config.jsonc") -Pattern '"port":\s*(\d+)' | Select-Object -First 1
if ($m) { $port = $m.Matches[0].Groups[1].Value }
for ($i = 0; $i -lt 40; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 1 | Out-Null; break } catch {
        if ($_.Exception.Response) { break }   # 403 sans jeton : le serveur répond
        Start-Sleep -Milliseconds 500
    }
}
$token = (Get-Content (Join-Path $root ".deck-token") -Raw).Trim()
Start-Process "http://127.0.0.1:$port/?token=$token"
