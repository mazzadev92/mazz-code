# MAZZ - Annule windows-optimize.ps1 à partir de sa sauvegarde. A lancer en administrateur.

$ErrorActionPreference = 'Continue'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host 'Lancez ce script en administrateur.' -ForegroundColor Red
    exit 1
}
$backupFile = Join-Path $PSScriptRoot 'windows-optimize.backup.json'
if (-not (Test-Path $backupFile)) {
    Write-Host "Aucune sauvegarde trouvée ($backupFile) : rien à restaurer." -ForegroundColor Yellow
    exit 1
}
$b = Get-Content -Path $backupFile -Raw -Encoding UTF8 | ConvertFrom-Json

foreach ($r in $b.run) {
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $r.name -Value $r.value
    Write-Host "Démarrage rétabli : $($r.name)"
}
foreach ($t in $b.tasks) {
    Enable-ScheduledTask -TaskPath $t.path -TaskName $t.name | Out-Null
    Write-Host "Tâche rétablie : $($t.path)$($t.name)"
}
$modes = @{ Auto = 'Automatic'; Manual = 'Manual'; Disabled = 'Disabled' }
foreach ($s in $b.services) {
    Set-Service -Name $s.name -StartupType $modes[$s.startMode]
    if ($s.wasRunning) { Start-Service -Name $s.name -ErrorAction SilentlyContinue }
    Write-Host "Service rétabli : $($s.name) ($($s.startMode))"
}
foreach ($p in $b.policies) {
    if ($null -eq $p.value) { Remove-ItemProperty -Path $p.path -Name $p.name -ErrorAction SilentlyContinue }
    else { Set-ItemProperty -Path $p.path -Name $p.name -Value $p.value -Type DWord }
    Write-Host "Stratégie rétablie : $($p.name)"
}
foreach ($d in $b.defender) {
    Remove-MpPreference -ExclusionPath $d
    Write-Host "Exclusion Defender retirée : $d"
}
Remove-Item -Path $backupFile
Write-Host 'Restauration terminée. Redémarrez le PC.' -ForegroundColor Green
