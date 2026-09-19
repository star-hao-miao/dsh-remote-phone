# make-debug-keystore.ps1 - create the repo-local debug signing key.
#
# Why: the Android default debug keystore lives in %USERPROFILE%\.android, which
# is outside this workspace and blocked for sandboxed builds. app/build.gradle.kts
# prefers android-app/debug.keystore when it exists, so generating it here makes
# every build (yours, mine, CI) produce the same signature.
#
# The key is a throwaway debug key with the well-known password "android"; it is
# only ever used for `debug` builds. Delete it freely - it is regenerated.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$keytool = Join-Path $root '.toolchain\jdk21\bin\keytool.exe'
$target = Join-Path $root 'android-app\debug.keystore'

if (Test-Path $target) {
    Write-Host "keystore already present: $target"
    exit 0
}
if (-not (Test-Path $keytool)) {
    Write-Host "keytool not found at $keytool"
    exit 1
}

# keytool writes its progress report to stderr; with $ErrorActionPreference set
# to Stop that would abort this script before the store is written, so the exit
# code is what we check instead.
$ErrorActionPreference = 'SilentlyContinue'
& $keytool -genkeypair -v `
    -keystore $target `
    -storetype JKS `
    -storepass android `
    -keypass android `
    -alias androiddebugkey `
    -keyalg RSA -keysize 2048 -validity 10000 `
    -dname "CN=Android Debug,O=Android,C=US" 2>&1 | Out-Null
$code = $LASTEXITCODE
$ErrorActionPreference = 'Continue'

if (Test-Path $target) { Write-Host "created $target" } else { Write-Host "keystore creation failed (keytool exit $code)"; exit 1 }
