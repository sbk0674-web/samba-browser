# samba-agent 하네스가 죽어 있으면 다시 올린다.
$dir = $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $dir 'PAUSE')) { exit 0 }
$logs = Join-Path $dir 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$watchLog = Join-Path $logs ("harness-watchdog-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
$lock = Join-Path $logs 'harness-watchdog.lock'

if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -lt 3) {
  exit 0
}
Set-Content $lock (Get-Date -Format 'o')

try {
  # 폴더 경로로 거르지 않는다 — samba-watchdog 가 띄운 하네스는 상대 경로(.venv\Scripts\python.exe -m samba_agent)라
  # 명령줄에 폴더 이름이 없어 이 점검이 못 알아보고 하네스를 하나 더 띄웠다(실기 2026-10-18~20: 둘이 같은 큐를 처리)
  $procs = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('python.exe', 'pythonw.exe') -and
    $_.CommandLine -and
    $_.CommandLine -like '*-m samba_agent*'
  })
  if ($procs.Count -gt 0) {
    Add-Content $watchLog ("{0} alive pid={1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), (($procs | Select-Object -ExpandProperty ProcessId) -join ',')) -Encoding UTF8
    exit 0
  }

  $day = Get-Date -Format 'yyyyMMdd-HHmmss'
  $harnessLog = Join-Path $logs "harness-$day.log"
  if (Test-Path -LiteralPath (Join-Path $dir 'PAUSE')) { exit 0 }
  Add-Content $watchLog ("{0} missing -> restart log={1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $harnessLog) -Encoding UTF8
  # Hidden only hides the first window; CreateNoWindow prevents a console entirely.
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $env:ComSpec
  $startInfo.Arguments = '/d /s /c ""' + (Join-Path $dir '.venv\Scripts\python.exe') + '" -m samba_agent > "' + $harnessLog + '" 2>&1"'
  $startInfo.WorkingDirectory = $dir
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables['PYTHONUNBUFFERED'] = '1'
  $startInfo.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
  $startedProcess = [System.Diagnostics.Process]::Start($startInfo)
  $startedProcess.Dispose()
} finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
