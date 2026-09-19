# install-to-desktop.ps1 - installs dsh-remote-phone into the local DSH Desktop web profile.
#
# Usage (run after quitting DSH Desktop to avoid profile lock conflicts):
#   powershell -ExecutionPolicy Bypass -File "C:\Users\33812\Desktop\dsh-apk\desktop-plugin\scripts\install-to-desktop.ps1"
#
# Optional parameters:
#   -DshHome <path>   default: C:\Users\33812\AppData\Roaming\dsh-desktop\harness
#   -Profile <name>   default: web

param(
    [string]$DshHome = 'C:\Users\33812\AppData\Roaming\dsh-desktop\harness',
    [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

# 1) Locate the dsh CLI bundled inside DSH Desktop.
$candidates = @(
    'C:\Users\33812\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js',
    (Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js')
)
$dshBin = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $dshBin) {
    Write-Error 'dsh CLI (bin.js) not found. Is DSH Desktop installed at the default location?'
    exit 1
}

# 2) Locate this plugin package root (parent of the scripts dir).
$pluginDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path (Join-Path $pluginDir 'cordis.patch.yml'))) {
    Write-Error "Not a plugin root (cordis.patch.yml missing): $pluginDir"
    exit 1
}
if (-not (Test-Path (Join-Path $pluginDir 'lib\index.js'))) {
    Write-Host '[hint] lib/ not built yet - building now...'
    Push-Location $pluginDir
    try {
        & node 'node_modules\typescript\bin\tsc' -p 'tsconfig.json'
        & node 'node_modules\typescript\bin\tsc' -p 'tsconfig.client.json'
    }
    finally {
        Pop-Location
    }
}

# 3) node from PATH, falling back to the DSH Desktop bundled node.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    $nodePath = 'C:\Users\33812\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\node\bin\node.exe'
    if (Test-Path $nodePath) {
        $node = $nodePath
    }
    else {
        Write-Error 'node not found.'
        exit 1
    }
}

# 4) Run "dsh plugin --profile <name> add link:<pluginDir>" with the desktop DSH_HOME.
$env:DSH_HOME = $DshHome
Write-Host "[1/2] DSH_HOME=$env:DSH_HOME profile=$Profile"
& $node $dshBin plugin --profile $Profile add "link:$pluginDir"
if ($LASTEXITCODE -ne 0) {
    Write-Error "dsh plugin add failed (exit=$LASTEXITCODE). See README.md for the manual fallback."
    exit $LASTEXITCODE
}

# 5) Verify the dependency landed in the profile manifest.
$profilePkg = Join-Path $DshHome "profiles\$Profile\package.json"
if (Test-Path $profilePkg) {
    $has = Select-String -Path $profilePkg -Pattern 'dsh-remote-phone' -Quiet
    Write-Host "[2/2] profile package.json contains dsh-remote-phone: $has"
}
else {
    Write-Host '[2/2] profile package.json not found (ok if the previous step succeeded).'
}

Write-Host ''
Write-Host 'Done. Next steps:'
Write-Host '  1) Quit and reopen DSH Desktop (the patch row takes effect on the next start).'
Write-Host '  2) Open the Web GUI - a whale button appears at the bottom right (Remote Gateway panel).'
Write-Host '  3) If the desktop market registry prunes the manual dependency after a restart, use the in-app plugin manager, or apply the manual bundles + cordis.patch.yml steps in README.'
