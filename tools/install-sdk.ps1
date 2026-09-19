# install-sdk.ps1 - extract the toolchain and install Android SDK packages.
# Everything stays inside dsh-apk\.toolchain (workspace-confined).
# ASCII-only: Windows PowerShell 5.1 mis-reads UTF-8 without BOM.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$tc = Join-Path $root '.toolchain'
$sdk = Join-Path $tc 'android-sdk'
$jdk = Join-Path $tc 'jdk21'
$gradle = Join-Path $tc 'gradle-8.11.1'

# 1) Flatten a nested JDK directory if a previous run left one.
$nested = Join-Path $jdk 'jdk-21.0.2'
if (Test-Path $nested) {
    Get-ChildItem $nested -Force | ForEach-Object { Move-Item $_.FullName (Join-Path $jdk '') -Force }
    Remove-Item $nested -Recurse -Force
}
if (-not (Test-Path (Join-Path $jdk 'bin\java.exe'))) {
    Write-Host '[jdk] extracting...'
    $tmp = Join-Path $tc 'jdk-extract'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    & tar.exe -xf (Join-Path $tc 'dl\jdk21.zip') -C $tmp
    $inner = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
    New-Item -ItemType Directory -Force -Path $jdk | Out-Null
    Get-ChildItem $inner -Force | ForEach-Object { Move-Item $_.FullName (Join-Path $jdk '') -Force }
    Remove-Item $tmp -Recurse -Force
}
Write-Host "[jdk] java present: $(Test-Path (Join-Path $jdk 'bin\java.exe'))"

# 2) Gradle.
if (-not (Test-Path (Join-Path $gradle 'bin\gradle.bat'))) {
    Write-Host '[gradle] extracting...'
    & tar.exe -xf (Join-Path $tc 'dl\gradle-8.11.1-bin.zip') -C $tc
}
Write-Host "[gradle] present: $(Test-Path (Join-Path $gradle 'bin\gradle.bat'))"

# 3) SDK packages. Java TLS reaches dl.google.com from this sandbox; the SDK
#    user home must live inside the workspace (the sandbox blocks ~/.android).
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_USER_HOME = Join-Path $tc 'android-home'
$env:GRADLE_USER_HOME = Join-Path $tc 'gradle-home'
New-Item -ItemType Directory -Force -Path $env:ANDROID_USER_HOME, $env:GRADLE_USER_HOME | Out-Null

$sdkmanager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
Write-Host "[sdk] sdkmanager: $(Test-Path $sdkmanager)"

Write-Host '[sdk] accepting licenses...'
$yes = 1..50 | ForEach-Object { 'y' }
$yes | & $sdkmanager --sdk_root=$sdk --licenses | Select-Object -Last 2

Write-Host '[sdk] installing platform-tools, platforms;android-35, build-tools;35.0.0 ...'
& $sdkmanager --sdk_root=$sdk 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' | Select-Object -Last 8

Write-Host '[sdk] contents:'
Get-ChildItem $sdk -Name
