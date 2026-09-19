# setup-android.ps1 - extract the downloaded toolchain and install Android SDK packages.
#
# Everything lands under dsh-apk\.toolchain (workspace-confined):
#   .toolchain\jdk21            Temurin JDK 21 (AGP requires 17-21; system JDK is 25)
#   .toolchain\gradle-8.11.1    Gradle distribution
#   .toolchain\android-sdk      Android SDK root (cmdline-tools + platform + build-tools)
#   .toolchain\gradle-home      GRADLE_USER_HOME (keeps caches inside the workspace)
#
# ASCII-only on purpose: Windows PowerShell 5.1 mis-reads UTF-8 without BOM.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot          # dsh-apk
$tc = Join-Path $root '.toolchain'
$dl = Join-Path $tc 'dl'
$sdk = Join-Path $tc 'android-sdk'
$jdkDir = Join-Path $tc 'jdk21'
$gradleDir = Join-Path $tc 'gradle-8.11.1'

function Unzip($zip, $dest) {
    if (-not (Test-Path $zip)) { throw "missing archive: $zip" }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    & tar.exe -xf $zip -C $dest
    if ($LASTEXITCODE -ne 0) { throw "tar failed for $zip" }
}

# 1) JDK 21 (archive contains a single jdk-21.x.y+z folder -> flatten)
if (-not (Test-Path (Join-Path $jdkDir 'bin\java.exe'))) {
    $tmp = Join-Path $tc 'jdk-extract'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Unzip (Join-Path $dl 'jdk21.zip') $tmp
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $inner) { throw 'JDK archive layout unexpected' }
    Remove-Item $jdkDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item $inner.FullName $jdkDir
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "[1/4] JDK21: $jdkDir"

# 2) Gradle
if (-not (Test-Path (Join-Path $gradleDir 'bin\gradle.bat'))) {
    Unzip (Join-Path $dl 'gradle-8.11.1-bin.zip') $tc
}
Write-Host "[2/4] Gradle: $gradleDir"

# 3) Android cmdline-tools -> <sdk>\cmdline-tools\latest
$latest = Join-Path $sdk 'cmdline-tools\latest'
if (-not (Test-Path (Join-Path $latest 'bin\sdkmanager.bat'))) {
    $tmp = Join-Path $tc 'cmdline-extract'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Unzip (Join-Path $dl 'cmdline-tools.zip') $tmp
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $latest) | Out-Null
    Remove-Item $latest -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item (Join-Path $tmp 'cmdline-tools') $latest
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "[3/4] cmdline-tools: $latest"

# 4) SDK packages (Java TLS reaches dl.google.com; PowerShell/.NET cannot).
$env:JAVA_HOME = $jdkDir
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$sdkmanager = Join-Path $latest 'bin\sdkmanager.bat'

$licenses = 1..40 | ForEach-Object { 'y' }
$licenses | & $sdkmanager --sdk_root=$sdk --licenses 2>&1 | Select-Object -Last 3

& $sdkmanager --sdk_root=$sdk 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 2>&1 | Select-Object -Last 12
Write-Host "[4/4] SDK packages installed under $sdk"

Write-Host ''
Write-Host 'Next:'
Write-Host "  `$env:JAVA_HOME='$jdkDir'"
Write-Host "  `$env:ANDROID_HOME='$sdk'"
Write-Host "  `$env:GRADLE_USER_HOME='$(Join-Path $tc 'gradle-home')'"
Write-Host "  & '$gradleDir\bin\gradle.bat' -p '$root\android-app' :app:assembleDebug --no-daemon"
