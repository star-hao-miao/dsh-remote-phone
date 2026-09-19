# e2e-approval.ps1 - end-to-end check of the approval path.
#
# Steps:
#   1. pair the app (one-time code handed over via intent)
#   2. ask the harness agent to do something that needs approval (a write
#      outside the workspace), and wait until the gateway reports it pending
#   3. KILL the app and cold-start it WITHOUT the pairing extra, to prove the
#      pending decision survives a restart (it rides along with `hello`)
#   4. tap "allow once" in the app and confirm the harness actually received
#      the decision (the tool result / file shows up)
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\e2e-approval.ps1
# ASCII-only, Windows PowerShell 5.1 compatible.

param(
    [int]$HarnessPort = 3939,
    [int]$GatewayPort = 3080,
    [string]$Serial = 'emulator-5554',
    [string]$ProbePath = 'C:\Windows\Temp\dsh-approval-e2e.txt',
    [int]$ApprovalWaitSeconds = 45
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
$adb = Join-Path $root '.toolchain\android-sdk\platform-tools\adb.exe'
$shots = Join-Path $root '.toolchain\shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null

$LBL_ALLOW = [string][char]0x5141 + [char]0x8BB8 + [char]0x4E00 + [char]0x6B21   # "allow once"
$LBL_DENY = [string][char]0x62D2 + [char]0x7EDD                                   # "reject"
$LBL_APPROVE = [string][char]0x6279 + [char]0x51C6                                 # "approval"
$LBL_SESSIONS = [string][char]0x4F1A + [char]0x8BDD                                # conversations
# Relative-time labels that only session rows carry (the workspace chip has
# "current", which shares no full word with these).
$LBL_AGO = ([string][char]0x521A + [char]0x521A) + '|' +
    ([string][char]0x5206 + [char]0x949F + [char]0x524D) + '|' +
    ([string][char]0x5C0F + [char]0x65F6 + [char]0x524D) + '|' +
    ([string][char]0x5929 + [char]0x524D)

$dumpCounter = 0
function DumpUi([string]$name) {
    $script:dumpCounter++
    $remote = "/sdcard/apr_$($script:dumpCounter).xml"
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
    Write-Host '      (!) uiautomator dump failed'
    return ''
}

function CenterOf([string]$xml, [string]$pattern) {
    $m = [regex]::Match($xml, '<node[^>]*?(?:text|content-desc)="[^"]*(' + $pattern + ')[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
    if (-not $m.Success) { return $null }
    return @([int](([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2), [int](([int]$m.Groups[3].Value + [int]$m.Groups[5].Value) / 2))
}

function TapNode([string]$xml, [string]$pattern) {
    $point = CenterOf $xml $pattern
    if ($point -eq $null) { return $false }
    & $adb -s $Serial shell input tap $point[0] $point[1] | Out-Null
    return $true
}

function UiTexts([string]$xml) {
    $texts = @()
    foreach ($m in [regex]::Matches($xml, '(?:text|content-desc)="([^"]+)"')) {
        if ($m.Groups[1].Value -ne '') { $texts += $m.Groups[1].Value }
    }
    return ($texts | Select-Object -Unique)
}

Write-Host '[1/5] pairing the app ...'
$cap = (Invoke-RestMethod -Uri "http://127.0.0.1:$HarnessPort/api/remote-gateway/config" -TimeoutSec 8).cap
if (-not $cap) { Write-Host '[!] no capability token from the harness probe'; exit 1 }
$mint = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/pair" -Method Post -Headers @{ 'x-rg-cap' = $cap; 'Content-Type' = 'application/json' } -Body '{}' -TimeoutSec 8
$link = "http://10.0.2.2:$GatewayPort/pair?code=$($mint.code)"
& $adb -s $Serial shell am force-stop com.dsh.remote | Out-Null
& $adb -s $Serial shell pm grant com.dsh.remote android.permission.POST_NOTIFICATIONS 2>&1 | Out-Null
& $adb -s $Serial shell am start -n com.dsh.remote/.MainActivity --es dsh_pair_link "$link" 2>&1 | Select-Object -Last 1
Start-Sleep -Seconds 9

# A CLI device of our own, for driving the session and reading the transcript.
$mint2 = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/pair" -Method Post -Headers @{ 'x-rg-cap' = $cap; 'Content-Type' = 'application/json' } -Body '{}' -TimeoutSec 8
$verify = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/pair/verify" -Method Post -ContentType 'application/json' `
    -Body (@{ code = $mint2.code; device = @{ name = 'approval-cli'; os = 'Windows' } } | ConvertTo-Json -Compress) -TimeoutSec 8
$auth = @{ Authorization = "Bearer $($verify.token)" }
# Run in a FRESH session: an older session may still hold an unanswered question,
# and `queue` mode would park our prompt behind it forever.
$created = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/sessions" -Method Post -Headers $auth `
    -ContentType 'application/json' -Body '{}' -TimeoutSec 20
if (-not $created.sessionId) { Write-Host '[!] POST /api/sessions returned no sessionId'; exit 1 }
$sessionId = $created.sessionId
Write-Host "      new session=$sessionId (POST /api/sessions)"

Write-Host '[2/5] asking the agent for something that needs approval ...'
# The prompt must steer the agent onto the harness's OWN escalation path: a
# sandbox denial followed by an identical retry with danger-full-access raises
# an `approval/request` waterfall. Asking "do you want me to...?" instead makes
# the agent call ask_user_question, which is a different (question) waterfall.
$prompt = "Run exactly this PowerShell command now: Set-Content -Path '$ProbePath' -Value 'hello' -Encoding Ascii. " +
    "If the file sandbox denies it, retry the SAME command once with sandbox_permissions=danger-full-access " +
    "(that raises the approval prompt this test is looking for). Do not ask me any questions first."
$body = @{ content = $prompt; mode = 'queue' } | ConvertTo-Json -Compress
$sent = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/sessions/$sessionId/message" -Method Post -Headers $auth -Body $body -TimeoutSec 20
Write-Host "      accepted=$($sent.accepted)"

$pending = $null
for ($i = 0; $i -lt $ApprovalWaitSeconds; $i++) {
    Start-Sleep -Seconds 1
    # NOTE: control-plane routes live on the GATEWAY port, not the harness web
    # port; the harness port only exposes the desktop probe.
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/rg/state?cap=$cap" -TimeoutSec 8
    # Only this run's session counts: an older unanswered approval stays pending
    # and would otherwise be mistaken for ours.
    $mine = @($state.interactions) | Where-Object { $_.sessionId -eq $sessionId }
    if ($mine.Count -gt 0) { Write-Host "      interaction kind=$($mine[0].kind) tool=$($mine[0].toolName)" }
    $pending = $mine | Where-Object { $_.kind -eq 'approval' } | Select-Object -First 1
    if ($pending -eq $null) { $pending = $mine | Select-Object -First 1 }
    if ($pending -ne $null) { break }
}
if ($pending -eq $null) { Write-Host '[!] no approval request appeared (the agent may not need one)'; exit 1 }
Write-Host "      pending approval id=$($pending.id) tool=$($pending.toolName) sessionId=$($pending.sessionId)"

Write-Host '[3/5] cold-starting the app (no pairing extra) ...'
& $adb -s $Serial shell am force-stop com.dsh.remote | Out-Null
Start-Sleep -Seconds 2
& $adb -s $Serial shell am start -n com.dsh.remote/.MainActivity 2>&1 | Select-Object -Last 1
Start-Sleep -Seconds 10

$x_ = DumpUi 'approval-card'
Write-Host '      app screen:'
foreach ($t in (UiTexts $x_)) { Write-Host "      $t" }

if ($x_ -notmatch $LBL_APPROVE) {
    # The card renders inside the chat card, and the shell opens the newest
    # conversation by itself. If that is not the approval's session, pick it from
    # the conversation drawer by its relative-time subtitle.
    Write-Host '      (opening the newest conversation from the drawer)'
    if (TapNode $x_ $LBL_SESSIONS) {
        Start-Sleep -Seconds 2
        $drawer = DumpUi 'approval-drawer'
        $row = CenterOf $drawer $LBL_AGO
        if ($row -ne $null) { & $adb -s $Serial shell input tap $row[0] $row[1] | Out-Null }
    }
    Start-Sleep -Seconds 6
    $x_ = DumpUi 'approval-detail'
    foreach ($t in (UiTexts $x_)) { Write-Host "      $t" }
}

if ($x_ -match $LBL_APPROVE) {
    Write-Host '[4/5] approval card is rendered after a cold start - allowing once ...'
} else {
    Write-Host '[!] approval card not found on screen'
    exit 1
}

if (-not (TapNode $x_ $LBL_ALLOW)) {
    if (-not (TapNode $x_ ($LBL_ALLOW + '|allow|Allow'))) {
        Write-Host '[!] allow button not found'
        exit 1
    }
}
Write-Host '      tapped allow-once'

Write-Host '[5/5] waiting for the harness to act on the decision ...'
$created = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 3
    if (Test-Path $ProbePath) { $created = $true; break }
}
Write-Host "      probe file created: $created"
$detail = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/api/sessions/$sessionId" -Headers $auth -TimeoutSec 20
foreach ($msg in ($detail.session.transcript | Select-Object -Last 6)) {
    $text = $msg.text
    if ($text -eq $null -or $text -eq '') { $text = '(empty)' }
    if ($text.Length -gt 110) { $text = $text.Substring(0, 110) + '...' }
    Write-Host ("      seq={0} [{1}/{2}] {3}" -f $msg.seq, $msg.role, $msg.kind, ($text -replace "`n", ' / '))
}
Write-Host '[done]'
