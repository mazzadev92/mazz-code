# MAZZ AENGENIUM - Doctor Script
Write-Host "========================================================" -ForegroundColor Green
Write-Host "  MAZZ AENGENIUM - System and Toolchain Doctor (2026)" -ForegroundColor DarkYellow
Write-Host "========================================================" -ForegroundColor Green

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cliPath = Join-Path $scriptDir "..\apps\cli\dist\index.js"

if (Test-Path $cliPath) {
    node $cliPath doctor
} else {
    Write-Host "Building CLI first..." -ForegroundColor Cyan
    $rootDir = Resolve-Path (Join-Path $scriptDir "..")
    npm --prefix $rootDir run build
    node $cliPath doctor
}
