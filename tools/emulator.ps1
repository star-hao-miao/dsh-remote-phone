# emulator.ps1 - create (once) and boot an Android emulator that acts as the
# "phone on the desktop", so APK changes can be previewed without touching a
# real device.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\emulator.ps1
#   powershell -ExecutionPolicy Bypass -File tools\emulator.ps1 -Avd dshphone -Port 5554
#
# ASCII-only: Windows PowerShell 5.1 mis-reads UTF-8 without BOM.

param(
    [string]$Avd = 'dshphone',
    [int]$Port = 5554,
    [string]$SystemImage = 'system-images;android-35;google_apis;x86_64',
    [switch]$Headless,
    [switch]$Run
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$tc = Join-Path $root '.toolchain'

$env:JAVA_HOME = Join-Path $tc 'jdk21'
$env:ANDROID_HOME = Join-Path $tc 'android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_USER_HOME = Join-Path $tc 'android-home'
# Everything Android tools treat as "$HOME" must live inside the workspace:
# the sandbox refuses writes to %USERPROFILE%\.android, and the emulator
# silently hangs (no adb port) when it cannot create its lock files there.
$env:HOME = Join-Path $tc 'android-home'
$env:ANDROID_SDK_HOME = Join-Path $tc 'android-home'
$env:ANDROID_AVD_HOME = Join-Path $tc 'android-home\avd'
New-Item -ItemType Directory -Force -Path $env:ANDROID_AVD_HOME | Out-Null

$sdk = $env:ANDROID_HOME
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$emulatorExe = Join-Path $sdk 'emulator\emulator.exe'
$avdmanager = Join-Path $sdk 'cmdline-tools\latest\bin\avdmanager.bat'

if (-not (Test-Path $emulatorExe)) { Write-Host '[!] emulator not installed yet (sdkmanager: emulator)'; exit 1 }

# 1) Create the AVD once (inside ANDROID_AVD_HOME). Existence is decided by the
#    AVD ini file: `avdmanager list avd` output parsing proved unreliable and a
#    needless --force re-create wipes the installed app.
if (Test-Path (Join-Path $env:ANDROID_AVD_HOME "$Avd.ini")) {
    Write-Host "[1/3] AVD $Avd already exists"
} else {
    Write-Host "[1/3] creating AVD $Avd ($SystemImage) ..."
    'no' | & $avdmanager create avd -n $Avd -k $SystemImage -d pixel_6 --force 2>&1 | Select-Object -Last 4
}
if (-not (Test-Path (Join-Path $env:ANDROID_AVD_HOME "$Avd.ini"))) {
    Write-Host "[!] AVD was not created - check the avdmanager output above (writable ANDROID_AVD_HOME?)"
    exit 1
}

# 2) Make sure the HOST keyboard is forwarded into Android. AVDs created by
#    avdmanager default to `hw.keyboard = no`, which is why typing from the PC
#    keyboard did nothing and only the on-screen keyboard worked. The setting is
#    read at boot, so it has to be fixed before starting the emulator.
$avdConfig = Join-Path $env:ANDROID_AVD_HOME "$Avd.avd\config.ini"
if (Test-Path $avdConfig) {
    $text = Get-Content $avdConfig -Raw
    $patched = $text -replace 'hw\.keyboard = no', 'hw.keyboard = yes'
    $patched = $patched -replace 'hw\.keyboard\.lid = yes', 'hw.keyboard.lid = no'
    if ($patched -ne $text) {
        [System.IO.File]::WriteAllText($avdConfig, $patched, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host '[i] enabled host-keyboard forwarding in the AVD config (hw.keyboard = yes)'
    }
}

# 3) Boot it (software GPU keeps it working without host GPU drivers).
# The emulator is started as an independent process with its output redirected
# to a log file: piping it through Select-Object/-First would terminate the
# emulator as soon as the pipeline stops reading.
$serial = "emulator-$Port"
$running = (& $adb devices) -match "$serial\s+device"
if ($running) {
    Write-Host "[2/3] emulator $serial is already running"
} else {
    Write-Host "[2/3] booting emulator on port $Port ..."
    $logs = Join-Path $tc 'logs'
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $args = @('-avd', $Avd, '-port', "$Port", '-no-snapshot', '-no-boot-anim', '-gpu', 'swiftshader_indirect')
    if ($Headless) { $args += @('-no-window') }
    Start-Process -FilePath $emulatorExe -ArgumentList $args `
        -RedirectStandardOutput (Join-Path $logs "emulator-$Port.out.log") `
        -RedirectStandardError (Join-Path $logs "emulator-$Port.err.log") | Out-Null
}

# 3) Wait for boot.
Write-Host '[3/3] waiting for boot (first boot can take a few minutes) ...'
& $adb -s $serial wait-for-device | Out-Null
$booted = $false
for ($i = 0; $i -lt 180; $i++) {
    $done = (& $adb -s $serial shell getprop sys.boot_completed 2>$null) -join ''
    if ($done.Trim() -eq '1') { $booted = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $booted) { Write-Host "[!] $serial did not report boot_completed"; exit 1 }
Write-Host "[ok] $serial booted."

if ($Run) {
    Write-Host '[4/4] build + install + launch the app ...'
    & (Join-Path $PSScriptRoot 'dev-run.ps1') -Serial $serial
} else {
    Write-Host "[i] start the app with: powershell -File tools\dev-run.ps1 -Serial $serial"
    Write-Host '[i] or open the emulator window and tap the DSH Remote icon.'
}
