param([switch]$InstallDependencies)
$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
Get-Command node.exe -ErrorAction Stop | Select-Object Name,Source
& node.exe --version
if ($InstallDependencies) {
    Push-Location $studioRoot
    try { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci a échoué' } }
    finally { Pop-Location }
} elseif (-not (Test-Path -LiteralPath (Join-Path $studioRoot 'node_modules'))) {
    throw 'Dépendances absentes. Relancer setup.ps1 -InstallDependencies pour autoriser leur installation.'
}
& (Join-Path $PSScriptRoot 'build.ps1')
& node.exe (Join-Path $studioRoot 'apps\cli\dist\index.js') doctor --json
if ($LASTEXITCODE -ne 0) { throw 'Diagnostic MAZZ échoué' }
