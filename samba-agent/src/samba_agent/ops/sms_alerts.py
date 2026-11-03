"""로컬 삼바웨이브의 기존 알리고 발송·이력 저장 기능을 재사용한다."""

import json
import logging
import re
import subprocess
from collections.abc import Callable

log = logging.getLogger(__name__)
RESULT_MARKER = 'SAMBA_SMS_RESULT='
SMS_SCRIPT = """
import asyncio, json, sys
from backend.core.tenant_context import current_tenant_id
from backend.db.orm import get_write_sessionmaker
from backend.api.v1.routers.samba.proxy._helpers import _get_setting
from backend.domain.samba.message_log.aligo_sender import send_aligo_sms

async def main():
    data = json.load(sys.stdin)
    token = current_tenant_id.set(data['tenant_id'])
    started = False
    try:
        async with get_write_sessionmaker()() as session:
            creds = await _get_setting(session, 'aligo_sms', data['tenant_id'])
            ready = isinstance(creds, dict) and all(creds.get(k) for k in ('apiKey','userId','sender'))
            result = {'success': bool(ready)}
            if ready and data['mode'] == 'send':
                started = True
                sent = await send_aligo_sms(session, data['tenant_id'], data['receiver'], data['message'], title='무신사머니 잔액 알림')
                await session.commit()
                result = {'success': sent.get('success') is True, 'msg_id': sent.get('msg_id')}
                if str(sent.get('message','')).startswith('SMS 발송 실패:'):
                    result['uncertain'] = True
    except Exception as exc:
        result = {'success': False, 'uncertain': started, 'error_type': type(exc).__name__}
    finally:
        current_tenant_id.reset(token)
    print('SAMBA_SMS_RESULT=' + json.dumps(result))

asyncio.run(main())
"""


class SmsDeliveryUnknown(RuntimeError):
    pass


class SambaSmsSender:
    def __init__(
        self,
        receiver: str,
        tenant_id: str,
        *,
        container: str = 'local-samba-api-1',
        run: Callable = subprocess.run,
    ) -> None:
        if not re.fullmatch(r'010\d{8}', receiver) or not tenant_id:
            raise ValueError('문자 수신 번호와 테넌트 설정 필요')
        self.receiver = receiver
        self.tenant_id = tenant_id
        self.container = container
        self.run = run

    def _call(self, mode: str, message: str = '') -> bool:
        payload = {
            'mode': mode,
            'receiver': self.receiver,
            'tenant_id': self.tenant_id,
            'message': message,
        }
        try:
            result = self.run(
                [
                    'docker',
                    'exec',
                    '-i',
                    self.container,
                    '/app/backend/.venv/bin/python',
                    '-c',
                    SMS_SCRIPT,
                ],
                input=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                capture_output=True,
                timeout=45,
                check=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        except subprocess.TimeoutExpired as exc:
            if mode == 'send':
                raise SmsDeliveryUnknown('문자 발송 결과 미확인 — 자동 재전송 금지') from exc
            return False
        except OSError:
            log.warning('문자 발송 실행 환경 확인 필요')
            return False
        lines = result.stdout.decode('utf-8', 'replace').splitlines()
        raw = next(
            (
                line[len(RESULT_MARKER) :]
                for line in reversed(lines)
                if line.startswith(RESULT_MARKER)
            ),
            None,
        )
        if raw is None:
            if mode == 'send':
                raise SmsDeliveryUnknown('문자 발송 응답 없음 — 자동 재전송 금지')
            return False
        try:
            response = json.loads(raw)
        except ValueError as exc:
            if mode == 'send':
                raise SmsDeliveryUnknown('문자 발송 응답 판독 실패') from exc
            return False
        if response.get('uncertain') and mode == 'send':
            raise SmsDeliveryUnknown('문자 발송 결과 미확인 — 발송 이력 확인 필요')
        return response.get('success') is True

    def ready(self) -> bool:
        return self._call('check')

    def send(self, message: str) -> bool:
        return self._call('send', message)
