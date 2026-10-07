# SAMBA 감시자 — 앱(개발 모드)과 주문 하네스가 꺼져 있으면 다시 띄운다. 작업 스케줄러가 로그온 때 한 번 실행한다.
#
# 왜: 앱·하네스를 대화 세션(터미널)에서 띄우면 세션이 닫힐 때 같이 꺼진다. 이 감시자는 세션과 무관하게 돈다.
# 점검 중지: samba-agent\PAUSE 파일이 있으면 하네스를 새로 띄우지 않는다(앱은 그대로 살린다).
#            samba-agent\PAUSE_APP 파일이 있으면 앱도 새로 띄우지 않는다.
# 로그: %TEMP%\samba-watchdog.log(감시자) · %TEMP%\samba-app-<시각>.log · samba-agent\logs\harness-<시각>.log
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$agent = Join-Path $root 'samba-agent'
$wlog = Join-Path $env:TEMP 'samba-watchdog.log'
function Say([string]$msg) { Add-Content -Path $wlog -Value ((Get-Date -Format 'MM-dd HH:mm:ss') + ' ' + $msg) -Encoding utf8 }

# 같은 감시자가 둘 돌지 않게 — 이름 있는 뮤텍스
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\SambaWatchdog', [ref]$created)
if (-not $created) { exit 0 }

function AppRunning {
  @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'samba_browser' }).Count -gt 0
}
function HarnessRunning {
  @(Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'samba_agent' }).Count -gt 0
}
function BridgeUp {
  try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:47811/' -TimeoutSec 3 -UseBasicParsing; return $true }
  catch { return [bool]$_.Exception.Response }  # 401·404 도 떠 있는 것이다
}

Say "감시자 시작 ($root)"
while ($true) {
  if (-not (Test-Path (Join-Path $agent 'PAUSE_APP')) -and -not (AppRunning)) {
    $alog = Join-Path $env:TEMP ('samba-app-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    Say "앱 시작 → $alog"
    # [2026-10-07] electron.exe 를 node 없이 직접 띄운다. npx·electron-vite dev 로 띄우면 앱이 node 자식이 되어
    # 다른 세션의 `taskkill /IM node.exe`(실기 10:02 — 1호기·2호기·오토튠 브라우저 동시 사망) 에 휩쓸린다.
    # 빌드는 끝나면 사라지는 node 라 괜찮다 — 빌드 산출물(out/)이 있어야 electron . 이 뜬다
    $build = Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $root -Wait -PassThru `
      -ArgumentList '/c', "npx electron-vite build > `"$alog.build`" 2>&1"
    if ($build.ExitCode -ne 0) { Say "앱 빌드 실패(code $($build.ExitCode)) — 기존 out/ 으로 띄운다" }
    $electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
    Start-Process -FilePath $electron -WindowStyle Hidden -WorkingDirectory $root `
      -ArgumentList '.', '--remote-debugging-port=9502' `
      -RedirectStandardOutput $alog -RedirectStandardError "$alog.err"
    # 앱·브릿지가 뜰 때까지 기다린다(최대 3분)
    for ($i = 0; $i -lt 60 -and -not (BridgeUp); $i++) { Start-Sleep -Seconds 3 }
  }
  if (-not (Test-Path (Join-Path $agent 'PAUSE')) -and -not (HarnessRunning) -and (BridgeUp)) {
    $logs = Join-Path $agent 'logs'
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $hlog = Join-Path $logs ('harness-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    Say "하네스 시작 → $hlog"
    # 앱이 막 떠서 바쁘면(409) 레인 확인이 실패해 계정 비교가 순서대로 돈다 — 잠깐 기다린다
    Start-Sleep -Seconds 10
    Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden -WorkingDirectory $agent `
      -ArgumentList '/c', "set PYTHONIOENCODING=utf-8&& set PYTHONUNBUFFERED=1&& .venv\Scripts\python.exe -m samba_agent > `"$hlog`" 2>&1"
  }
  # 7일 지난 로그 정리
  Get-ChildItem -Path $env:TEMP -Filter 'samba-app-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem -Path (Join-Path $agent 'logs') -Filter 'harness-*.log' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 30
}
