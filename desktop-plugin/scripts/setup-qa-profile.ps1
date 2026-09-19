# setup-qa-profile.ps1 - creates an ISOLATED dev profile for dsh-remote-phone.
#
# Why: the DSH Desktop "web" profile pins plugin versions (e.g. dsh-whale-widget
# 0.3.0) that only exist in the desktop's own plugin store, so a raw
# `dsh plugin add` there re-resolves against npmjs.org and fails. A separate
# QA profile under this project avoids that entirely and matches how ecosystem
# plugins are developed (`dsh --profile web --no-open --port 3939`).
#
# Usage (any PowerShell; network required on first run):
#   powershell -ExecutionPolicy Bypass -File "C:\Users\33812\Desktop\dsh-apk\desktop-plugin\scripts\setup-qa-profile.ps1"
#
# Optional:
#   -QaRoot <dir>   default: C:\Users\33812\Desktop\dsh-apk\.qa
#   -Port <int>     boot port echoed at the end (default 3939)

param(
    [string]$QaRoot = 'C:\Users\33812\Desktop\dsh-apk\.qa',
    [int]$Port = 3939
)

$ErrorActionPreference = 'Stop'

# Locate the dsh CLI bundled inside DSH Desktop.
$candidates = @(
    'C:\Users\33812\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js',
    (Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js')
)
$dshBin = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $dshBin) {
    Write-Error 'dsh CLI (bin.js) not found. Is DSH Desktop installed at the default location?'
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    $nodePath = 'C:\Users\33812\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\node\bin\node.exe'
    if (Test-Path $nodePath) { $node = $nodePath }
    else { Write-Error 'node not found.'; exit 1 }
}

# Plugin package root (parent of the scripts dir).
$pluginDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path (Join-Path $pluginDir 'lib\index.js'))) {
    Write-Host '[hint] building plugin lib first...'
    Push-Location $pluginDir
    try {
        & node 'node_modules\typescript\bin\tsc' -p 'tsconfig.json'
        & node 'node_modules\typescript\bin\tsc' -p 'tsconfig.client.json'
    }
    finally { Pop-Location }
}

$qaHome = Join-Path $QaRoot 'home'
New-Item -ItemType Directory -Force -Path $qaHome | Out-Null

$env:DSH_HOME = $qaHome
Write-Host "[1/2] creating QA profile at $qaHome (first run downloads core bundles; please wait)..."
Write-Host "[1/2] running: dsh plugin --profile web add link:$pluginDir"
& $node $dshBin plugin --profile web add "link:$pluginDir"
if ($LASTEXITCODE -ne 0) {
    Write-Error "QA profile setup failed (exit=$LASTEXITCODE)."
    exit $LASTEXITCODE
}
Write-Host "[2/2] plugin added to the QA profile."

Write-Host ''
Write-Host 'Now boot the isolated instance in a NEW terminal window and keep it open:'
Write-Host "  `$env:DSH_HOME = '$qaHome'"
Write-Host "  node '$dshBin' web --no-open --port $Port"
Write-Host ''
Write-Host "Then open:  http://127.0.0.1:$Port   (whale button bottom right)"
Write-Host "Gateway:   http://127.0.0.1:3080   (health: /healthz)"
Write-Host ''
Write-Host 'To stop later: close the terminal window, or delete the whole .qa folder.'
