param([string]$Destination)
$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
$packageArgs = @((Join-Path $PSScriptRoot 'package_local.py'))
if ($Destination) { $packageArgs += @('--destination',$Destination) }
& python @packageArgs
if ($LASTEXITCODE -ne 0) { throw 'Création du package MAZZ échouée' }
