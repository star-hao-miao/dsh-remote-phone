# dev-run.ps1 - rebuild the app, install it on the running device/emulator, and launch it.
# One command per UI iteration: build -> install -r -> am start.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\dev-run.ps1            # auto-detect device
#   powershell -ExecutionPolicy Bypass -File tools\dev-run.ps1 -Serial emulator-5554
#
# ASCII-only: Windows PowerShell 5.1 mis-reads UTF-8 without BOM.

param(
    [string]$Serial = '',
    [switch]$NoInstall,
    [switch]$NoBuild
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$tc = Join-Path $root '.toolchain'

$env:JAVA_HOME = Join-Path $tc 'jdk21'
$env:ANDROID_HOME = Join-Path $tc 'android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_USER_HOME = Join-Path $tc 'android-home'
$env:GRADLE_USER_HOME = Join-Path $tc 'gradle-home'
# emulator.ps1 points HOME at the workspace so the emulator can write its lock
# files; Gradle/AGP must NOT inherit that (AGP then fails to create its
# AndroidDirectoryCreator service). Drop it for the build.
Remove-Item Env:\HOME -ErrorAction SilentlyContinue
Remove-Item Env:\ANDROID_SDK_HOME -ErrorAction SilentlyContinue

$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$apk = Join-Path $root 'android-app\app\build\outputs\apk\debug\app-debug.apk'

if ($NoBuild) {
    Write-Host '[1/3] build skipped (-NoBuild)'
} else {
    Write-Host '[1/3] gradle :app:assembleDebug ...'
    & (Join-Path $tc 'gradle-8.11.1\bin\gradle.bat') -p (Join-Path $root 'android-app') :app:assembleDebug --no-daemon --console=plain |
        Select-Object -Last 6
    if ($LASTEXITCODE -ne 0) { Write-Host '[!] build failed'; exit 1 }
}

if ($NoInstall) { Write-Host "[ok] APK: $apk"; exit 0 }

if ($Serial -eq '') {
    $lines = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\sdevice$' }
    $Serial = ($lines | Select-Object -First 1) -replace '\s+device$', ''
}
if ($Serial -eq '' -or $Serial -eq $null) {
    Write-Host '[!] no device/emulator attached (adb devices is empty)'
    Write-Host '[i] start one first: powershell -File tools\emulator.ps1'
    exit 1
}

Write-Host "[2/3] installing on $Serial ..."
& $adb -s $Serial install -r $apk | Select-Object -Last 2
# The app asks for the notification permission once paired (Android 13+); grant
# it here so the dialog never interrupts a dev loop.
& $adb -s $Serial shell pm grant com.dsh.remote android.permission.POST_NOTIFICATIONS 2>&1 | Out-Null

Write-Host '[3/3] launching ...'
& $adb -s $Serial shell am start -n com.dsh.remote/.MainActivity | Select-Object -Last 2

Write-Host '[done] reload the page inside the app (or tap 刷新) to see UI changes.'
