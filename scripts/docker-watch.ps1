# 도커 엔진 감시 — 작업 스케줄러가 1분마다 부른다(사용자 2026-10-09 "도커다운 모니터링해라").
# 엔진이 2번 연속(1분 간격) 안 뜨면 Docker Desktop 을 다시 실행하고, 컨테이너가 올라올 때까지 기다린 뒤 기록한다.
# 삼바웨이브 API·DB·크림·터널이 전부 컨테이너라 도커가 꺼지면 하네스 주문 접수가 530 으로 막힌다(10/9 14:48).
# 로그: %TEMP%\docker-watch.log   점검 중지: 이 폴더의 PAUSE_DOCKER_WATCH 파일이 있으면 아무것도 하지 않는다
#
# [2026-10-26 개정] 오늘 강제 재시작이 4번 났는데 원인은 도커가 죽은 게 아니라 WSL VM CPU 포화였다
# (postgres 컨테이너 7코어·호스트 CPU 100% → VM 안 DNS i/o timeout, 2376 no route → docker info 가 15초를 넘김).
# 느린 것을 죽은 것으로 보고 5분 만에 강제 재시작하면 postgres 가 비정상 종료 복구를 하느라 CPU 를 또 몰아 써서
# 다음 점검도 실패 → 또 재시작하는 악순환이 됐다. 그래서
#   · 응답 대기를 15초 → 60초
#   · 엔진 파이프(dockerDesktopLinuxEngine)가 살아 있으면 '느린 것'으로 보고 15회 연속까지 기다린다(파이프가 없으면 종전대로 5회)
#   · 직전 강제 재시작 20분 안에는 파이프가 있는 한 다시 강제 재시작하지 않는다

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $env:TEMP 'docker-watch.log'
$state = Join-Path $env:TEMP 'docker-watch.state'
$lastRestart = Join-Path $env:TEMP 'docker-watch.lastrestart'
$pipePath = '\\.\pipe\dockerDesktopLinuxEngine'
$exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$dkexe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'

function Write-Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  # 로그가 커지면 뒤쪽 2000줄만 남긴다
  if ((Get-Item $log).Length -gt 400KB) { Get-Content $log -Tail 2000 | Set-Content $log -Encoding UTF8 }
}

function Test-EnginePipe {
  try { return [bool]([System.IO.Directory]::GetFiles('\\.\pipe\') -contains $script:pipePath) } catch { return $false }
}

function Test-Engine {
  $dk = $script:dkexe
  if (-not (Test-Path $dk)) { $dk = (Get-Command docker -ErrorAction SilentlyContinue).Source }
  if (-not $dk) { return $false }
  # PowerShell 5.1 은 Start-Process 후 ExitCode 를 못 읽는다 — 작업(Job)으로 돌려 60초 안에 끝났는지·종료코드를 본다
  $job = Start-Job -ScriptBlock { param($exe) & $exe info *> $null; $LASTEXITCODE } -ArgumentList $dk
  if (-not (Wait-Job $job -Timeout 60)) { Stop-Job $job; Remove-Job $job -Force; return $false }
  $code = Receive-Job $job
  Remove-Job $job -Force
  return (@($code)[-1] -eq 0)
}
function Show-Toast([string]$title, [string]$body) {
  try {
    $py = Join-Path $root 'samba-agent\.venv\Scripts\python.exe'
    if (Test-Path $py) {
      $code = "from samba_agent.export.desktop import toast; toast.show('$title','$body')"
      Start-Process -FilePath $py -ArgumentList '-c', $code -WorkingDirectory (Join-Path $root 'samba-agent') -WindowStyle Hidden | Out-Null
    }
  } catch { }
}

if (Test-Path (Join-Path $PSScriptRoot 'PAUSE_DOCKER_WATCH')) { exit 0 }

if (Test-Engine) {
  if (Test-Path $state) {
    $was = (Get-Content $state -ErrorAction SilentlyContinue | Select-Object -First 1)
    Remove-Item $state -Force -ErrorAction SilentlyContinue
    Write-Log "복구 확인 — 엔진 정상(이전 실패 $was 회)"
  }
  exit 0
}

# 실패 횟수 기록 — 2번 연속일 때만 되살린다(Docker Desktop 시작 중 잠깐 안 뜨는 것을 오탐하지 않게)
$fails = 1
if (Test-Path $state) { $fails = [int](Get-Content $state | Select-Object -First 1) + 1 }
Set-Content -Path $state -Value $fails
$pipeUp = Test-EnginePipe
Write-Log ("엔진 응답 없음 ($fails 회 연속, 엔진 파이프 {0})" -f $(if ($pipeUp) { '있음' } else { '없음' }))
if ($fails -lt 2) { exit 0 }

$running = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue
if ($running) {
  # 프로세스는 있는데 엔진이 안 뜬다 — 시작 중일 수 있으니 기다린다.
  # 파이프가 살아 있으면 VM 이 바쁜 것(느린 것)이라 15회까지, 파이프가 없으면 5회까지.
  $limit = if ($pipeUp) { 15 } else { 5 }
  if ($fails -lt $limit) { exit 0 }
  # 직전 강제 재시작 20분 안이면 파이프가 있는 한 다시 하지 않는다(재시작이 부하를 만들어 악순환이 된다)
  if ($pipeUp -and (Test-Path $lastRestart)) {
    $prev = [datetime](Get-Content $lastRestart | Select-Object -First 1)
    if (((Get-Date) - $prev).TotalMinutes -lt 20) { Write-Log '직전 강제 재시작 20분 안 — 파이프가 살아 있어 더 기다림'; exit 0 }
  }
  Write-Log "Docker Desktop 이 $fails 회째 엔진을 못 올림 — 종료 후 다시 실행"
  Set-Content -Path $lastRestart -Value (Get-Date).ToString('s')
  Get-Process -Name 'Docker Desktop','com.docker.backend' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
}

if (-not (Test-Path $exe)) { Write-Log "Docker Desktop 실행 파일이 없다: $exe"; exit 1 }
Write-Log 'Docker Desktop 실행'
Start-Process -FilePath $exe
Show-Toast '도커가 꺼져 다시 켭니다' 'Docker Desktop 을 다시 실행했습니다. 컨테이너가 올라올 때까지 1~2분 걸립니다.'

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 6
  if (Test-Engine) {
    $n = (& $script:dkexe ps -q 2>$null | Measure-Object).Count
    Write-Log "엔진 복구 — 컨테이너 $n 개 실행 중"
    Remove-Item $state -Force -ErrorAction SilentlyContinue
    Show-Toast '도커 복구됨' "컨테이너 $n 개가 올라왔습니다."
    exit 0
  }
}
Write-Log '4분 기다렸지만 엔진이 안 올라온다 — 사람이 확인해야 한다'
Show-Toast '도커가 안 켜집니다' 'Docker Desktop 을 다시 실행했지만 4분 안에 엔진이 올라오지 않았습니다. 직접 확인해 주세요.'
exit 1
