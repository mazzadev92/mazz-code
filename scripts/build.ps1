$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
Push-Location $studioRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Build MAZZ échoué : $LASTEXITCODE" }
} finally { Pop-Location }
