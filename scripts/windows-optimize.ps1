# MAZZ - Allègement de Windows pour l'IA locale (réversible).
# A lancer en administrateur :  powershell -ExecutionPolicy Bypass -File scripts\windows-optimize.ps1
# Restauration :                powershell -ExecutionPolicy Bypass -File scripts\windows-restore.ps1
#
# Conservé volontairement : Microsoft Defender, Hyper-V et WSL (Claude Cowork), pilotes Intel et
# Realtek, Windows Search, Tessera auto-apprentissage (projet de l'utilisateur), Node, Python, Git.
#
# Option : -DefenderExclusions exclut du scan les dossiers de modèles (chargement plus rapide des
# GGUF). Ces dossiers ne sont alors plus surveillés : n'y mettre que des fichiers de sources sûres.

param([switch]$DefenderExclusions)

$ErrorActionPreference = 'Continue'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host "Lancez ce script en administrateur (clic droit sur PowerShell, Exécuter en tant qu'administrateur)." -ForegroundColor Red
    exit 1
}

$backupFile = Join-Path $PSScriptRoot 'windows-optimize.backup.json'
if (Test-Path $backupFile) {
    Write-Host "Une sauvegarde existe déjà ($backupFile). Lancez windows-restore.ps1 avant de réappliquer." -ForegroundColor Yellow
    exit 1
}
$backup = [ordered]@{ date = (Get-Date).ToString('s'); run = @(); tasks = @(); services = @(); policies = @(); defender = @() }

# 1. Applications lancées au démarrage (clé Run de l'utilisateur)
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
foreach ($name in @('Opera GX Stable', 'Opera GX Browser Assistant', 'iCloudServices')) {
    $value = (Get-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue).$name
    if ($value) {
        $backup.run += @{ name = $name; value = $value }
        Remove-ItemProperty -Path $runKey -Name $name
        Write-Host "Démarrage désactivé : $name"
    }
}

# 2. Tâches planifiées de mise à jour et de suggestions
$taskFilters = @('Opera GX scheduled*', 'AppleSoftwareUpdate', 'GoogleUpdaterTaskSystem*', 'SoftLanding*')
foreach ($f in $taskFilters) {
    foreach ($t in (Get-ScheduledTask -TaskName $f -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Disabled' })) {
        $backup.tasks += @{ path = $t.TaskPath; name = $t.TaskName }
        Disable-ScheduledTask -TaskPath $t.TaskPath -TaskName $t.TaskName | Out-Null
        Write-Host "Tâche désactivée : $($t.TaskPath)$($t.TaskName)"
    }
}

# 3. Services inutiles pour le projet
foreach ($svc in @('Apple Mobile Device Service', 'Bonjour Service', 'SQLWriter', 'Spooler')) {
    $s = Get-CimInstance Win32_Service -Filter "Name='$svc'" -ErrorAction SilentlyContinue
    if ($s -and $s.StartMode -ne 'Disabled') {
        $backup.services += @{ name = $svc; startMode = $s.StartMode; wasRunning = ($s.State -eq 'Running') }
        Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
        Set-Service -Name $svc -StartupType Disabled
        Write-Host "Service désactivé : $svc"
    }
}

# 4. Widgets et flux d'actualités
$dsh = 'HKLM:\SOFTWARE\Policies\Microsoft\Dsh'
$prev = (Get-ItemProperty -Path $dsh -Name 'AllowNewsAndInterests' -ErrorAction SilentlyContinue).AllowNewsAndInterests
$backup.policies += @{ path = $dsh; name = 'AllowNewsAndInterests'; value = $prev }
New-Item -Path $dsh -Force | Out-Null
Set-ItemProperty -Path $dsh -Name 'AllowNewsAndInterests' -Value 0 -Type DWord
Get-Process -Name 'WidgetBoard', 'Widgets', 'MicrosoftStartFeedProvider' -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host 'Widgets désactivés'

# 5. Option : exclusions Defender pour les dossiers de modèles
if ($DefenderExclusions) {
    foreach ($p in @('D:\TESSERA\Mgguf', 'D:\MAZZ GPU ACX\dist', 'D:\MAZZ GPU ACX\build\llama-avx2')) {
        if ((Test-Path $p) -and -not ((Get-MpPreference).ExclusionPath -contains $p)) {
            Add-MpPreference -ExclusionPath $p
            $backup.defender += $p
            Write-Host "Exclusion Defender : $p"
        }
    }
}

$backup | ConvertTo-Json -Depth 5 | Set-Content -Path $backupFile -Encoding UTF8
Write-Host ''
Write-Host "Terminé. Sauvegarde : $backupFile" -ForegroundColor Green
Write-Host 'Redémarrez le PC pour libérer tout ce qui était déjà lancé.'
