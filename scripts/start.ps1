param(
    [ValidateRange(1024,65535)][int]$Port = 3333,
    [string]$DataDirectory,
    [switch]$NoBrowser,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
# MAZZ AENGENIUM - Start Studio Server
Write-Host "========================================================" -ForegroundColor Green
Write-Host "  Demarrage de MAZZ AENGENIUM - Agent Studio..." -ForegroundColor DarkYellow
Write-Host "========================================================" -ForegroundColor Green

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir "..")
$cliPath = Join-Path $rootDir "apps\cli\dist\index.js"
$webIndex = Join-Path $rootDir "apps\web\dist\index.html"

if (-not (Test-Path (Join-Path $rootDir "node_modules"))) {
    throw 'Dépendances absentes. Utiliser scripts\setup.ps1 -InstallDependencies.'
}

if (-not (Test-Path $cliPath) -or -not (Test-Path $webIndex)) {
    if ($SkipBuild) { throw 'Build absent alors que -SkipBuild est demandé.' }
    Write-Host "Compilation de la solution (backend + interface)..." -ForegroundColor Cyan
    npm --prefix $rootDir run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ECHEC] La compilation a echoue." -ForegroundColor Red
        exit 1
    }
}

# Open the browser once the server answers, without blocking the server start.
if (-not $NoBrowser) { Start-Job -ScriptBlock {
    param($p)
    for ($i = 0; $i -lt 40; $i++) {
        try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$p/api/health" -TimeoutSec 1 | Out-Null; Start-Process "http://127.0.0.1:$p"; break } catch { Start-Sleep -Milliseconds 500 }
    }
} -ArgumentList $port | Out-Null }

if ($DataDirectory) { $env:MAZZ_STUDIO_DATA = [IO.Path]::GetFullPath($DataDirectory) }
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Le port $Port est déjà occupé. Choisir -Port avec un port libre; aucun processus existant n’a été arrêté." }
Push-Location $rootDir
try { & node.exe $cliPath start --port $Port }
finally { Pop-Location }
