import json
import subprocess
from datetime import datetime

import pytest

from samba_agent.ops.money_alerts import KST, MoneyBalanceAlerts
from samba_agent.ops.sms_alerts import RESULT_MARKER, SambaSmsSender, SmsDeliveryUnknown


def test_uses_existing_sms_service_without_exposing_keys():
    calls = []

    def run(command, **kwargs):
        calls.append((command, json.loads(kwargs['input'])))
        return subprocess.CompletedProcess(
            command, 0, (RESULT_MARKER + '{"success":true}\n').encode(), b''
        )

    sender = SambaSmsSender('01000000000', 'test-tenant', run=run)
    assert sender.ready()
    assert sender.send('잔액 알림 테스트')
    assert calls[0][1]['mode'] == 'check'
    assert calls[1][1]['receiver'] == '01000000000'
    assert calls[1][1]['message'] == '잔액 알림 테스트'
    assert '01000000000' not in calls[1][0]
    assert 'send_aligo_sms' in calls[1][0][-1]


def test_sms_timeout_never_triggers_duplicate_send(tmp_path):
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        raise subprocess.TimeoutExpired(command, 45)

    sender = SambaSmsSender('01000000000', 'test-tenant', run=run)
    alerts = MoneyBalanceAlerts(tmp_path / 'alerts.sqlite', sender.send,
                               now=lambda:datetime(2026,10,29,12,tzinfo=KST))
    assert not alerts.observe('buyer01', [{'method': '무신사머니', 'balance': 100000}])
    assert not alerts.observe('buyer01', [{'method': '무신사머니', 'balance': 90000}])
    assert len(calls) == 1


def test_missing_settings_is_definite_failure_and_can_retry():
    def run(command, **kwargs):
        return subprocess.CompletedProcess(
            command, 0, (RESULT_MARKER + '{"success":false}\n').encode(), b''
        )

    sender = SambaSmsSender('01000000000', 'test-tenant', run=run)
    assert not sender.ready()
    assert not sender.send('테스트')


def test_response_lost_after_send_is_ambiguous():
    def run(command, **kwargs):
        return subprocess.CompletedProcess(command, 1, b'', b'error')

    with pytest.raises(SmsDeliveryUnknown):
        SambaSmsSender('01000000000', 'test-tenant', run=run).send('테스트')
