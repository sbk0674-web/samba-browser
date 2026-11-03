# 주문처리 감시 — GPT(Codex)로 10분마다 한 번 돌린다(작업 스케줄러가 부른다)
$dir = $PSScriptRoot
$day = Get-Date -Format 'yyyyMMdd'
$log = Join-Path $dir "logs\monitor-codex-$day.log"
$last = Join-Path $dir 'logs\monitor-codex-last.txt'
New-Item -ItemType Directory -Force (Join-Path $dir 'logs') | Out-Null
$ensure = Join-Path $dir 'ensure-order-harness.ps1'
if (Test-Path $ensure) {
  powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $ensure
}
$lock = Join-Path $dir 'logs\monitor-codex.lock'
# 앞 실행이 아직 끝나지 않았으면 겹쳐 돌지 않는다(40분 넘은 잠금은 죽은 것으로 본다)
if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt 40) { exit 0 }
Set-Content $lock (Get-Date -Format 'o')
try {
  $prompt = (Get-Content (Join-Path $dir 'monitor-prompt.txt') -Raw -Encoding UTF8) + "`n먼저 samba-agent/HANDOFF-order-monitor.md 를 읽고 규칙을 지켜라."
  Add-Content $log ("=== " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " 시작") -Encoding UTF8
  $prompt | codex exec -C $dir -s danger-full-access --skip-git-repo-check --ephemeral -o $last - 2>&1 | Add-Content $log -Encoding UTF8
  Add-Content $log ("--- 마지막 메시지: " + ((Get-Content $last -Raw -Encoding UTF8) -replace "\s+", ' ')) -Encoding UTF8
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
