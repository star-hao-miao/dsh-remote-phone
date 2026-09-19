# e2e-app.ps1 - end-to-end check of the native app against a running QA harness.
#
# UI shape it drives (v2 shell, modelled on the DeepSeek-whale-Chat reference):
#   top bar [会话 drawer] [设置 drawer]  ->  character layer  ->  glass chat card
# There is no bottom navigation any more, and the newest conversation opens
# automatically, so the conversation list lives in a drawer.
#
# What it does:
#   1. reads the desktop capability token from the harness probe route
#   2. mints a one-time pairing code and hands the link to the app via an intent
#      (`--es dsh_pair_link`), so the app pairs itself (no manual typing)
#   3. checks the shell: top bar, character layer, chat card, composer
#   4. opens the conversation drawer and asserts the list renders
#   5. types a message into the composer and taps send
#   6. waits for the gateway transcript to grow and prints it
#   7. creates a conversation with the drawer's "new conversation" action
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\e2e-app.ps1
#   powershell -ExecutionPolicy Bypass -File tools\e2e-app.ps1 -Message "hello from the app"
#
# ASCII-only and PowerShell 5.1 compatible (this host ships Windows PowerShell).

param(
    [int]$HarnessPort = 3939,
    [int]$GatewayPort = 3080,
    [string]$Serial = 'emulator-5554',
    [string]$Message = 'Hello from the DSH Remote app please reply briefly',
    [switch]$SkipSend
)

$ErrorActionPreference = 'Continue'
# The Android UI dump contains Chinese labels; without this the console decodes
# adb output as the legacy ANSI code page and prints mojibake.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# Windows PowerShell reads a BOM-less .ps1 in the legacy ANSI code page, so
# Chinese literals inside this file would arrive corrupted and never match the
# UI dump. Every label is therefore built from code points.
$LBL_SEND = [string][char]0x53D1 + [char]0x9001                        # send
$LBL_NEW = [string][char]0x65B0 + [char]0x4F1A + [char]0x8BDD           # new conversation
$LBL_CLOSE = [string][char]0x5173 + [char]0x95ED                        # close (drawer)
$LBL_SESSIONS = [string][char]0x4F1A + [char]0x8BDD                     # conversations
$LBL_CHARACTER = [string][char]0x7ACB + [char]0x7ED8                    # character art label
# Relative-time labels are what only conversation rows carry (the workspace chip
# has "current", which shares no full word with these).
$LBL_AGO = ([string][char]0x521A + [char]0x521A) + '|' +
    ([string][char]0x5206 + [char]0x949F + [char]0x524D) + '|' +
    ([string][char]0x5C0F + [char]0x65F6 + [char]0x524D) + '|' +
    ([string][char]0x5929 + [char]0x524D)

$root = Split-Path -Parent $PSScriptRoot
$adb = Join-Path $root '.toolchain\android-sdk\platform-tools\adb.exe'
$shots = Join-Path $root '.toolchain\shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null

$dumpCounter = 0

function DumpUi([string]$name) {
    # `uiautomator dump` fails with "could not get idle state" while the UI is
    # animating, and in that case it leaves the PREVIOUS file in place - pulling
    # it silently returns a stale screen. Use a unique remote path per call and
    # retry, so a stale read is impossible.
    $script:dumpCounter++
    $remote = "/sdcard/e2e_$($script:dumpCounter).xml"
    $local = Join-Path $shots "$name.xml"
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        & $adb -s $Serial shell rm -f $remote | Out-Null
        & $adb -s $Serial shell uiautomator dump $remote 2>&1 | Out-Null
        Remove-Item $local -ErrorAction SilentlyContinue
        & $adb -s $Serial pull $remote $local 2>&1 | Out-Null
        if ((Test-Path $local) -and (Get-Item $local).Length -gt 0) {
            return (Get-Content $local -Raw -Encoding UTF8)
        }
        Start-Sleep -Milliseconds 700
    }
    Write-Host '      (!) uiautomator dump failed 4 times'
    return ''
}

function UiTexts([string]$xml) {
    $texts = @()
    foreach ($m in [regex]::Matches($xml, '(?:text|content-desc)="([^"]+)"')) {
        if ($m.Groups[1].Value -ne '') { $texts += $m.Groups[1].Value }
    }
    return ($texts | Select-Object -Unique)
}

# Compose nodes expose the label on `text` (Text) or `content-desc` (icon
# button); match either one.
function CenterOf([string]$xml, [string]$textPattern) {
    $m = [regex]::Match($xml, '<node[^>]*?(?:text|content-desc)="[^"]*(' + $textPattern + ')[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    if (-not $m.Success) { return $null }
    $x = [int](([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2)
    $y = [int](([int]$m.Groups[3].Value + [int]$m.Groups[5].Value) / 2)
    return @($x, $y)
}

function TapNode([string]$xml, [string]$pattern) {
    $point = CenterOf $xml $pattern
    if ($point -eq $null) { return $false }
    & $adb -s $Serial shell input tap $point[0] $point[1] | Out-Null
    return $true
}

function PrintScreen([string]$label, [string]$xml) {
    Write-Host "      $label"
    foreach ($t in UiTexts $xml) {
        $v = $t
        if ($v.Length -gt 70) { $v = $v.Substring(0, 70) + '...' }
        Write-Host "        $v"
    }
}

Write-Host '[1/8] reading capability token ...'
$cfg = Invoke-RestMethod -Uri "http://127.0.0.1:$HarnessPort/api/remote-gateway/config" -TimeoutSec 8
$cap = $cfg.cap
if (-not $cap) { Write-Host '[!] harness probe returned no capability token'; exit 1 }

Write-Host '[2/8] minting a pairing code for the app ...'
$mintForApp = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/pair" -Method Post `
    -Headers @{ 'x-rg-cap' = $cap; 'Content-Type' = 'application/json' } -Body '{}' -TimeoutSec 8
if (-not $mintForApp.ok) { Write-Host "[!] mint failed: $($mintForApp | ConvertTo-Json -Compress)"; exit 1 }
$link = "http://10.0.2.2:$GatewayPort/pair?code=$($mintForApp.code)"

# A CLI device of our own, for reading the transcript over REST.
$mint = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/pair" -Method Post `
    -Headers @{ 'x-rg-cap' = $cap; 'Content-Type' = 'application/json' } -Body '{}' -TimeoutSec 8
$verify = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/pair/verify" -Method Post -ContentType 'application/json' `
    -Body (@{ code = $mint.code; device = @{ name = 'e2e-cli'; os = 'Windows' } } | ConvertTo-Json -Compress) -TimeoutSec 8
$auth = @{ Authorization = "Bearer $($verify.token)" }

& $adb -s $Serial shell am force-stop com.dsh.remote | Out-Null
# Pre-grant the notification permission: the app asks for it once paired, and
# that dialog would block every automation step below.
& $adb -s $Serial shell pm grant com.dsh.remote android.permission.POST_NOTIFICATIONS 2>&1 | Out-Null
& $adb -s $Serial shell am start -n com.dsh.remote/.MainActivity --es dsh_pair_link "$link" 2>&1 | Select-Object -Last 1
Start-Sleep -Seconds 10

Write-Host '[3/8] pairing screen -> shell ...'
$xml = DumpUi 'e2e-shell'
PrintScreen 'app screen:' $xml

Write-Host '[4/8] shell structure ...'
$texts = UiTexts $xml
$hasTopBar = ($texts -contains $LBL_SESSIONS)
$hasCharacter = @($texts | Where-Object { $_ -like "*$LBL_CHARACTER*" }).Count -gt 0
$hasComposer = $xml -match 'android.widget.EditText'
Write-Host "      top bar: $hasTopBar ; character layer: $hasCharacter ; composer: $hasComposer"
if (-not $hasComposer) { Write-Host '[!] no composer on screen - is a conversation open?'; exit 1 }

Write-Host '[5/8] conversation drawer ...'
if (TapNode $xml $LBL_SESSIONS) {
    Start-Sleep -Seconds 2
    $drawer = DumpUi 'e2e-drawer'
    PrintScreen 'drawer:' $drawer
    $hasList = $drawer -match $LBL_AGO
    $hasNew = $drawer -match $LBL_NEW
    Write-Host "      conversation list: $hasList ; new-conversation action: $hasNew"
    if (TapNode $drawer $LBL_CLOSE) { Start-Sleep -Seconds 2 }
    $xml = DumpUi 'e2e-shell-again'
} else {
    Write-Host '      (!) conversations button not found'
}

$sessions = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/sessions" -Headers $auth -TimeoutSec 15
$sessionId = $sessions.items[0].id
$baseline = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/sessions/$sessionId" -Headers $auth -TimeoutSec 20
$baselineCount = $baseline.session.transcript.Count
Write-Host "      gateway session=$sessionId baseline messages=$baselineCount"

if (-not $SkipSend) {
    Write-Host '[6/8] typing into the composer and sending ...'
    $edit = [regex]::Match($xml, '<node[^>]*class="android.widget.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    if ($edit.Success) {
        $ex = [int](([int]$edit.Groups[1].Value + [int]$edit.Groups[3].Value) / 2)
        $ey = [int](([int]$edit.Groups[2].Value + [int]$edit.Groups[4].Value) / 2)
        & $adb -s $Serial shell input tap $ex $ey | Out-Null
        Start-Sleep -Seconds 2
        # Clear anything a previous run left behind: caret to end + many deletes.
        $deletes = @('123') + (1..60 | ForEach-Object { '67' })
        & $adb -s $Serial shell input keyevent ($deletes -join ' ') | Out-Null
        Start-Sleep -Seconds 1
        $typed = $Message -replace ' ', '%s'
        & $adb -s $Serial shell input text "$typed" | Out-Null
        Start-Sleep -Seconds 2
        $typedXml = DumpUi 'e2e-typed'
        # Never press ENTER: the composer accepts newlines instead of sending.
        if (TapNode $typedXml "$LBL_SEND|send|Send") {
            Write-Host '      tapped send'
        } else {
            Write-Host '      (!) send button not found'
        }
        # The local echo confirms the message the instant it is sent. Check it
        # quickly: the list follows the tail, so once the agent starts streaming
        # the bubble scrolls out of the visible area (that is correct, but a dump
        # only contains what is on screen).
        Start-Sleep -Milliseconds 1200
        $echoXml = DumpUi 'e2e-echo'
        $echoSeen = (UiTexts $echoXml) -contains $Message
        Write-Host "      local echo visible right after send: $echoSeen"
    } else {
        Write-Host '      (composer not found; skipping send)'
    }
}

Write-Host '[7/8] waiting for the gateway transcript to grow ...'
$detail = $baseline
$grew = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 5
    $detail = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/sessions/$sessionId" -Headers $auth -TimeoutSec 20
    if ($detail.session.transcript.Count -gt $baselineCount) { $grew = $true }
    $lastBaselineSeq = 0
    if ($baseline.session.transcript.Count -gt 0) { $lastBaselineSeq = $baseline.session.transcript[-1].seq }
    $newAssistant = @($detail.session.transcript | Where-Object { $_.role -eq 'assistant' -and $_.seq -gt $lastBaselineSeq })
    if ($grew -and $newAssistant.Count -gt 0) { break }
}
if (-not $grew) { Write-Host '      (!) no new message reached the session (in queue mode a busy turn holds it back)' }
Write-Host '      transcript:'
foreach ($msg in $detail.session.transcript) {
    $text = $msg.text
    if ($text -eq $null -or $text -eq '') { $text = '(empty)' }
    if ($text.Length -gt 110) { $text = $text.Substring(0, 110) + '...' }
    Write-Host ("      seq={0} [{1}/{2}] {3}" -f $msg.seq, $msg.role, $msg.kind, ($text -replace "`n", ' / '))
}

Write-Host '[8/8] creating a conversation from the drawer ...'
$before = (Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/sessions" -Headers $auth -TimeoutSec 20).items
# The soft keyboard is usually up after sending; close it before touching drawers.
& $adb -s $Serial shell input keyevent 4 | Out-Null
Start-Sleep -Seconds 2
$shellXml = DumpUi 'e2e-shell-clean'
if (-not (TapNode $shellXml $LBL_SESSIONS)) { Write-Host '      (!) conversations button not found' }
Start-Sleep -Seconds 2
$drawerXml = DumpUi 'e2e-drawer-new'
if (-not (TapNode $drawerXml $LBL_NEW)) {
    Write-Host '      (!) new-conversation action not found'
} else {
    Start-Sleep -Seconds 7
    $afterXml = DumpUi 'e2e-new-session'
    $after = (Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/sessions" -Headers $auth -TimeoutSec 20).items
    $opened = $afterXml -match 'android.widget.EditText'
    Write-Host "      sessions $($before.Count) -> $($after.Count) ; composer still on screen: $opened"
}
Write-Host '[done]'
