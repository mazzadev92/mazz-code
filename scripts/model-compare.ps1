# Runs the judge bench and the Forge bench for one GGUF model on a fresh llama-server, then stops it.
# Usage: powershell -File scripts/model-compare.ps1 -Model Qwen_Qwen3-1.7B-Q4_K_M.gguf [-Ctx 16384] [-Parallel 4]
param(
  [Parameter(Mandatory = $true)][string]$Model,
  [int]$Ctx = 16384,
  [int]$Parallel = 4,
  [string]$ModelDir = 'D:\TESSERA\Mgguf',
  [string]$Server = 'D:\MAZZ GPU ACX\dist\MUCE-v0.1.0\runtimes\llama-avx2\llama-server.exe'
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$tag = ($Model -replace '^Qwen_', '' -replace '-Q4_K_M\.gguf$', '')
$out = Join-Path $root "AUDIT_RUN_2026-10-25_FORGE\compare-$tag"
New-Item -ItemType Directory -Force $out | Out-Null
$env:NoDefaultCurrentDirectoryInExePath = $null
$env:MAZZ_FORGE_EXPERIENCE = $null

$llama = Start-Process -PassThru -NoNewWindow -FilePath $Server -ArgumentList @('-m', (Join-Path $ModelDir $Model), '--host', '127.0.0.1', '--port', '8091', '-c', $Ctx, '--parallel', $Parallel, '-t', '4', '-ctk', 'q8_0', '-ctv', 'q8_0', '-fa', 'on', '--jinja') -RedirectStandardOutput "$out\llama.out" -RedirectStandardError "$out\llama.err"
try {
  $ready = $false
  # Larger models load slowly when memory is tight (pages come from disk): up to 10 minutes.
  for ($i = 0; $i -lt 600; $i++) {
    try { if ((Invoke-RestMethod http://127.0.0.1:8091/health -TimeoutSec 2).status -eq 'ok') { $ready = $true; break } } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { "llama-server non prêt pour $Model" | Tee-Object -FilePath "$out\progress.log" -Append; exit 1 }
  "[$(Get-Date -Format HH:mm:ss)] $Model prêt" | Tee-Object -FilePath "$out\progress.log" -Append
  Set-Location $root
  node scripts/judge-bench.mjs --model $Model --trials 5 --repeats 3 2>&1 | Tee-Object -FilePath "$out\judge.log" | Select-String 'TOTAL|classée' | ForEach-Object { "[$(Get-Date -Format HH:mm:ss)] juge $($_.Line)" } | Tee-Object -FilePath "$out\progress.log" -Append
  # Baseline speed on the standard task, then the two tasks where the 0.6B struggled, with and without repair.
  node scripts/forge-bench.mjs "$out\std" --model $Model --tasks crc32-ctypes:standard --configs norepair 2>&1 | Select-String '#1 ' | ForEach-Object { "[$(Get-Date -Format HH:mm:ss)] banc $($_.Line)" } | Tee-Object -FilePath "$out\progress.log" -Append
  node scripts/forge-bench.mjs "$out\hard" --model $Model --tasks vecmath-ctypes:hard,crc32-ctypes:coarse --configs repair,norepair 2>&1 | Select-String '#1 ' | ForEach-Object { "[$(Get-Date -Format HH:mm:ss)] banc $($_.Line)" } | Tee-Object -FilePath "$out\progress.log" -Append
  "[$(Get-Date -Format HH:mm:ss)] TERMINE $Model" | Tee-Object -FilePath "$out\progress.log" -Append
} finally {
  Stop-Process -Id $llama.Id -Force -ErrorAction SilentlyContinue
}
