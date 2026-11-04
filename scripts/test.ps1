# MAZZ AENGENIUM - Test Runner
Write-Host "========================================================" -ForegroundColor Green
Write-Host "  Execution des tests MAZZ Agent Studio..." -ForegroundColor DarkYellow
Write-Host "========================================================" -ForegroundColor Green

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $scriptDir "..")
$packages = @("shared", "tools", "providers", "model-manager", "hermes-bridge", "agent", "core")

$failed = 0
foreach ($pkg in $packages) {
    Write-Host "`n---> Test du package : @mazz/$pkg" -ForegroundColor Cyan
    $pkgDir = Join-Path $root "packages\$pkg"
    if (Test-Path $pkgDir) {
        npm --prefix $pkgDir test
        if ($LASTEXITCODE -ne 0) {
            $failed++
        }
    }
}

if ($failed -eq 0) {
    Write-Host "`n[SUCCES] TOUS LES TESTS SONT PASSES AVEC SUCCES !" -ForegroundColor Green
} else {
    Write-Host "`n[ECHEC] $failed package(s) en echec." -ForegroundColor Red
}
