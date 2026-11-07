# Désinstalle le service de session Windows du deck (le deck s'arrête ; start.cmd le relance à la main).
$vbs = Join-Path ([Environment]::GetFolderPath("Startup")) "web-deck-devsecops.vbs"
# La boucle de relance d'abord, puis le serveur
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like "*run-windows.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like "*server\index.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
if (Test-Path $vbs) { Remove-Item $vbs; Write-Host "Service désinstallé." } else { Write-Host "Service non installé." }
