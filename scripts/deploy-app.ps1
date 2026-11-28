# 삼바 브라우저 앱 배포 — 앱 out/ 을 만드는 유일한 정식 경로.
#
# 1) 깨끗한 워크트리(samba_browser-mastersync)를 최신 origin/master 로 맞춘다
# 2) 거기서 빌드한다(미커밋 변경·옛 소스가 섞일 수 없다)
# 3) 메인 폴더 out/ 에 복사한다(기존 out/ 은 out.bak-<시각> 으로 옮기고 최신 3개만 남긴다)
# 4) -Restart 를 주면 하네스 큐가 30초 비었을 때만 앱을 껐다 켠다
#
# 사용: powershell -File scripts\deploy-app.ps1            (빌드·복사만, 실행 중인 앱은 그대로)
#       powershell -File scripts\deploy-app.ps1 -Restart   (큐가 30초 비면 재시작까지)
#
# 재시작 전에 사람·세션에게 알린다: 삼바 브라우저를 쓰는 세션(SAMBASNS·선녀체크인 등)에 한 줄 통지 → 답/무응답 확인.
param([switch]$Restart, [switch]$Force)

$ErrorActionPreference = 'Stop'
$main = Split-Path -Parent $PSScriptRoot
$wt = Join-Path (Split-Path -Parent $main) 'samba_browser-mastersync'
$jobs = Join-Path $main 'samba-agent\jobs.sqlite'
$py = Join-Path $main 'samba-agent\.venv\Scripts\python.exe'

if (-not (Test-Path $wt)) { throw "빌드용 워크트리가 없다: $wt  (git worktree add $wt origin/master --detach)" }

Write-Host '[1/4] 워크트리를 origin/master 로 맞춘다'
git -C $wt fetch -q origin
git -C $wt checkout -q --detach origin/master
$rev = (git -C $wt log -1 --format='%h %s').Trim()
Write-Host "      $rev"

Write-Host '[2/4] 빌드'
Push-Location $wt
try { npm run build; if ($LASTEXITCODE -ne 0) { throw '빌드 실패' } } finally { Pop-Location }

Write-Host '[3/4] 메인 out/ 교체'
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path (Join-Path $main 'out')) { Rename-Item (Join-Path $main 'out') "out.bak-$ts" }
Copy-Item -Recurse (Join-Path $wt 'out') (Join-Path $main 'out')
Get-ChildItem $main -Directory -Filter 'out.bak-*' | Sort-Object Name -Descending | Select-Object -Skip 3 |
  ForEach-Object { Remove-Item -Recurse -Force $_.FullName }

if (-not $Restart) { Write-Host '[4/4] 재시작 안 함(-Restart 로 재시작). 앱은 다음 시작부터 새 판이다.'; exit 0 }

Write-Host '[4/4] 하네스 큐가 30초 비면 재시작'
# 큐 검사 파이썬 조각은 파일로 만들어 부른다 — -c 에 여러 줄·따옴표를 넘기면 PowerShell 이 따옴표를 벗겨 SyntaxError 로 끝났다(2026-10-21)
$idleCheck = Join-Path $env:TEMP 'samba-queue-idle-check.py'
@'
import sqlite3, datetime, sys
j = sqlite3.connect(sys.argv[1], timeout=30)
n = j.execute("select count(*) from jobs where state in ('queued','running')").fetchone()[0]
m = j.execute('select max(updated_at) from jobs').fetchone()[0]
age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(m)).total_seconds()
print('ok' if n == 0 and age >= 30 else 'wait')
'@ | Set-Content -Encoding UTF8 $idleCheck
for ($i = 0; $i -lt 180; $i++) {
  $r = (& $py $idleCheck $jobs | Select-Object -Last 1)
  if ($r -eq 'ok' -or $Force) { break }
  Start-Sleep -Seconds 20
}
if ($r -ne 'ok' -and -not $Force) { throw '큐가 비지 않아 재시작을 포기했다(-Force 로 강제)' }
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*samba_browser\node_modules\electron*' } |
  ForEach-Object { cmd /c "taskkill /PID $($_.ProcessId) /T /F" | Out-Null }
Start-Sleep -Seconds 4
Start-Process -FilePath (Join-Path $main 'node_modules\electron\dist\electron.exe') -ArgumentList '.', '--remote-debugging-port=9502' -WorkingDirectory $main
Write-Host '재시작했다. 로그인 화면 아래 판 표시가 위 커밋과 같은지 확인한다.'
