"""윈도우 알림(화면 오른쪽 아래 알림 창) — 사람이 처리해야 하는 일을 PC 에서 바로 알린다.

슬랙을 보지 않는 사용자에게 알리는 통로다(사용자 2026-09-29). 창을 앞으로 가져오지 않고 키 입력도 하지
않는다 — 알림만 띄운다. 띄우지 못해도 예외를 내지 않는다(작업자는 이어서 돈다).
"""

import base64
import logging
import subprocess

log = logging.getLogger(__name__)

# PowerShell 의 앱 id — 따로 등록하지 않아도 알림을 띄울 수 있다
_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml(@'
<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>__TITLE__</text><text>__BODY__</text></binding></visual>
<audio src="ms-winsoundevent:Notification.Reminder"/><actions><action content="확인" arguments="dismiss" activationType="system"/></actions></toast>
'@)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('__APP__').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
"""


def _escape(text: str) -> str:
    return (
        text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace("'", '&apos;')
    )


def show(title: str, body: str) -> bool:
    """알림 하나를 띄운다. 띄웠으면 True. 'reminder' 형식이라 사용자가 닫을 때까지 남는다."""
    script = (
        _SCRIPT.replace('__TITLE__', _escape(title))
        .replace('__BODY__', _escape(body))
        .replace('__APP__', _APP_ID)
    )
    encoded = base64.b64encode(script.encode('utf-16-le')).decode('ascii')
    try:
        done = subprocess.run(
            ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            capture_output=True,
            timeout=20,
            check=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        log.warning('윈도우 알림을 띄우지 못했다: %s', e)
        return False
    if done.returncode != 0:
        log.warning('윈도우 알림 실패: %s', done.stderr.decode('utf-8', 'replace')[:200])
        return False
    return True
