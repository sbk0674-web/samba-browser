"""구매 done과 분리한 SSG 선물 재검증. 구매·결제 그래프를 다시 실행하지 않는다."""

import importlib.util
import json
import os
import re
import threading
import time
from collections.abc import Callable
from contextlib import ExitStack, contextmanager

from samba_agent.agents.base import split_page_dialogs
from samba_agent.agents.source_detail import detail_check, detail_script
from samba_agent.ops.masking import mask_text
from samba_agent.ops.ssg_gift_accept import gift_order_of, source_order_no_of
from samba_agent.queue.db import GIFT_FOLLOWUP_KEY, Job, JobQueue


class GiftFollowupStopped(ValueError):
    """취소·반품·만료 주문에는 수락 동작을 하지 않는다."""


def _shared_phone_lock(serial: str, owner: str):
    spec = importlib.util.spec_from_file_location(
        'ssg_shared_phone_lock', r'C:\Users\canno\workspace\phone-locks\phone_lock.py'
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PhoneLock(serial, owner, minutes=10, wait=0, note='SSG 선물 수락·독립 재확인')


def make_phone_session():
    """수락과 재확인 전체 동안 같은 실기기 잠금을 유지한다."""
    from samba_agent.ops.ssg_gift_accept import (
        DEFAULT_ADB,
        DEFAULT_PHONE,
        KAKAO,
        PHONE_BUSY,
        SSG_APP,
        GiftAcceptError,
        Phone,
        find_phone_serial,
        wait_foreground,
    )

    adb = os.environ.get('SAMBA_ADB') or DEFAULT_ADB
    want = os.environ.get('SAMBA_PAY_PHONE') or DEFAULT_PHONE

    @contextmanager
    def locked():
        serial = find_phone_serial(adb, want)
        if not serial:
            raise GiftAcceptError('선물 확인 폰 연결 없음')
        phone = Phone(adb, serial)
        real = phone._run('shell', 'getprop', 'ro.serialno').strip()
        if not real or not (real == want or real in want or serial == want):
            raise GiftAcceptError('선물 확인 실기기 일련번호 불일치')
        owner = f'ssg-gift-followup:{os.getpid()}:{threading.get_ident()}'
        with _shared_phone_lock(real, owner):
            if not PHONE_BUSY.acquire(timeout=0):
                raise GiftAcceptError('다른 하네스 폰 작업 중')
            try:
                calls = re.findall(
                    r'mCallState\s*=\s*(\d+)', phone._run('shell', 'dumpsys', 'telephony.registry')
                )
                if not calls or any(state != '0' for state in calls):
                    raise GiftAcceptError('통화 중이거나 통화 상태 미확인')
                foreground = phone.top_package()
                if 'alipay' in foreground.lower():
                    raise GiftAcceptError('알리페이 화면 사용 중 — 선물 확인 보류')
                power = phone._run('shell', 'dumpsys', 'power')
                allowed = (
                    KAKAO,
                    SSG_APP,
                    'com.sec.android.app.launcher',
                    'com.android.launcher',
                    'com.android.launcher3',
                    'launcher',
                )
                if 'mWakefulness=Awake' in power and foreground not in allowed:
                    raise GiftAcceptError('사용자 폰 화면 사용 중 — 선물 확인 보류')
                if 'mWakefulness=Awake' not in power:
                    if not re.search(r'mWakefulness=(?:Asleep|Dozing)', power):
                        raise GiftAcceptError('폰 화면 상태 미확인')
                    phone.wake()
                    if any(
                        any(
                            key in (node.rid + ' ' + node.text).lower()
                            for key in (
                                'pinentry',
                                'passwordentry',
                                'lockpattern',
                                'pin 입력',
                                '비밀번호 입력',
                            )
                        )
                        for node in phone.nodes()
                    ):
                        raise GiftAcceptError('폰 잠금 확인 필요')
                    phone.launch(KAKAO)
                    if not wait_foreground(phone, KAKAO, 25):
                        raise GiftAcceptError('카카오톡 진입 미확인')
                yield
            finally:
                PHONE_BUSY.release()

    return locked


def detail_reader(bridge):
    """이미 쓰는 소싱처 상세 저장 스크립트만 호출한다. 수리·구매·결제 도구는 노출하지 않는다."""
    reader = bridge.with_lane('ssg-gift-followup').scoped(['run_script'])

    def read(task):
        result = reader.call(
            'run_script',
            name=detail_script('SSG'),
            args=json.dumps(
                {
                    'source_order_no': task['source_order_no'],
                    'profile': task['profile'],
                },
                ensure_ascii=False,
            ),
        )
        body, _ = split_page_dialogs(result.result)
        detail = json.loads(body)
        if not isinstance(detail, dict):
            raise TypeError('소싱처 상세 형식 불명')
        return detail

    return read


def source_of_followup(job: Job) -> tuple[str, str]:
    """구매 때 확정해 저장한 상품만 수락 함수에 전달한다. 나중 소싱처 재지정과 섞지 않는다."""
    task = job.options.get(GIFT_FOLLOWUP_KEY)
    if not isinstance(task, dict) or not task.get('sku'):
        raise ValueError('선물 수락 대상 상품 확인 필요')
    return 'SSG', str(task['sku'])


def make_verify_only():
    """수락을 하지 않는 새 주문 검색·상품 대조·이미 완료 화면 확인만 재사용한다."""
    from samba_agent.ops.ssg_gift_accept import (
        DEFAULT_ADB,
        DEFAULT_PHONE,
        PHONE_BUSY,
        GiftAcceptError,
        Phone,
        find_phone_serial,
    )

    adb = os.environ.get('SAMBA_ADB') or DEFAULT_ADB
    want = os.environ.get('SAMBA_PAY_PHONE') or DEFAULT_PHONE

    def verify(task: dict) -> bool:
        from samba_agent.agents.buyer import model_code_of
        from samba_agent.ops.ssg_gift_search import accept_ssg_gift_by_search

        serial = find_phone_serial(adb, want)
        if serial is None:
            raise GiftAcceptError('선물 독립 확인 폰 연결 없음')
        with PHONE_BUSY:
            try:
                line = accept_ssg_gift_by_search(
                    Phone(adb, serial),
                    task['source_order_no'],
                    sku=task['sku'],
                    model_code=model_code_of(task['sku']) or '',
                    verify_only=True,
                )
            except GiftAcceptError as exc:
                if '독립 재확인에서 선물 수락 완료 미확인' in str(exc):
                    return False
                raise
        return line.startswith('이미 받은 선물(상품 대조·완료 화면)')

    return verify


class GiftFollowup:
    def __init__(
        self,
        queue: JobQueue,
        *,
        accept: Callable,
        source_of_job: Callable,
        read_detail: Callable,
        verify_only: Callable | None = None,
        now: Callable = time.time,
        add_memo: Callable | None = None,
        phone_session: Callable | None = None,
        read_order: Callable | None = None,
    ):
        self.queue, self.accept, self.source_of_job = queue, accept, source_of_job
        self.read_detail, self.now = read_detail, now
        self.verify_only, self.add_memo = verify_only, add_memo
        self.phone_session = phone_session
        self.read_order = read_order

    def prepare(self, job: Job, out: dict) -> dict | None:
        if not gift_order_of(out):
            return None
        # 원래 소싱처가 아닌 실제 구매한 buyer를 따른다(교차 비교로 SSG를 샀을 수 있다).
        bought = (out.get('results') or {}).get('buyer.ssg')
        payload = (
            bought.get('payload', {})
            if isinstance(bought, dict)
            else getattr(bought, 'payload', {})
        )
        if payload.get('order_type') != 'gift':
            return None
        try:
            _, sku = self.source_of_job(job)
        except Exception:  # noqa: BLE001 — 조회 장애에도 확인 대기는 보존하되 상품 불명이면 수락하지 않는다
            sku = ''
        profile = str(payload.get('account') or '')
        order = out.get('order')
        if not profile and order is not None:
            profile = (
                str(order.get('account') or '')
                if isinstance(order, dict)
                else str(getattr(order, 'account', '') or '')
            )
        return {
            'state': 'pending',
            'phase': 'accept',
            'source_order_no': source_order_no_of(out),
            'profile': profile,
            'sku': sku,
            'attempts': 0,
            'next_at': self.now(),
            'created_at': self.now(),
        }

    def __call__(self, job: Job, out: dict) -> str | None:
        current = self.queue.get_by_id(job.id)
        task = current.options.get(GIFT_FOLLOWUP_KEY) if current else None
        if not isinstance(task, dict):
            return None
        return self._process(current, dict(task))

    def _save(self, job: Job, task: dict) -> None:
        self.queue.mark_option(job.id, GIFT_FOLLOWUP_KEY, task)

    def _check(self, task: dict, before_phone: Callable = lambda: None) -> bool:
        detail = self.read_detail(task)
        if not isinstance(detail, dict) or detail_check(task['source_order_no'])(detail):
            raise ValueError('소싱 주문번호/결제 상세 대조 실패')
        profile = detail.get('profile') or detail.get('account')
        if profile and profile != task['profile']:
            raise ValueError('소싱 주문 계정 불일치')
        status = str(detail.get('status') or '') + ' ' + str(detail.get('gift_status') or '')
        if any(
            word in status.lower()
            for word in (
                '취소',
                '반품',
                '만료',
                '거절',
                'cancelled',
                'canceled',
                'returned',
                'expired',
                'rejected',
            )
        ):
            raise GiftFollowupStopped('취소·반품·만료·거절 주문 — 선물 수락 금지')
        # 상품준비중·삼바 메모·폰 완료 문구는 수락의 독립 증거가 아니다.
        accepted = detail.get('gift_accepted') is True or detail.get('gift_status') in (
            '수락완료',
            '선물 수락 완료',
            '선물 받기 완료',
        )
        if accepted:
            return True
        if self.verify_only is not None:
            before_phone()
            return self.verify_only(task) is True
        return False

    def _process(self, job: Job, task: dict) -> str:
        with ExitStack() as stack:
            entered = False

            def before_phone():
                nonlocal entered
                if not entered and self.phone_session is not None:
                    stack.enter_context(self.phone_session())
                    entered = True

            return self._process_locked(job, task, before_phone)

    def _process_locked(self, job: Job, task: dict, before_phone: Callable) -> str:
        task['attempts'] = int(task.get('attempts', 0)) + 1
        task['next_at'] = self.now() + min(3600, 300 * 2 ** min(task['attempts'] - 1, 4))
        self._save(job, task)  # 호출 도중 종료되어도 대기·백오프가 남는다
        reason = '원본 주문 상세의 수락 증거 없음'
        try:
            if self.now() - float(task.get('created_at', self.now())) >= 7 * 86400:
                raise GiftFollowupStopped('선물 확인 대기 7일 초과 — 원본 기한 수동 확인 필요')
            if not task.get('source_order_no') or not task.get('profile') or not task.get('sku'):
                raise ValueError('소싱 주문번호/계정/상품 확인 필요')
            if self.read_order is not None:
                current = self.read_order(job.wave_id or job.order_no)
                field = (
                    current.get
                    if isinstance(current, dict)
                    else lambda key: getattr(current, key, None)
                )
                status = str(field('status') or '').lower()
                if not status:
                    raise ValueError('판매 주문 현재 상태 미확인')
                if any(
                    word in status for word in ('cancel', 'return', '취소', '반품', '만료', '거절')
                ):
                    raise GiftFollowupStopped('판매 주문 취소·반품 상태 — 선물 수락 금지')
                saved_no = re.sub(
                    r'[^0-9A-Za-z]', '', str(field('sourcing_order_number') or '')
                ).upper()
                expected_no = re.sub(r'[^0-9A-Za-z]', '', task['source_order_no']).upper()
                if not saved_no or saved_no != expected_no:
                    raise GiftFollowupStopped('현재 소싱 주문번호 불일치 — 선물 수락 금지')
            verified = self._check(task, before_phone)
            if not verified and task.get('phase') == 'accept':
                # 수락 직후 프로세스가 죽으면 먼저 원본만 재확인한다. 무조건 다시 누르지 않는다.
                task['phase'] = 'verify'
                self._save(job, task)
                out = {
                    'results': {
                        'buyer.ssg': {
                            'payload': {'order_type': 'gift', 'account': task['profile']}
                        },
                        'payer': {'payload': {'source_order_no': task['source_order_no']}},
                    }
                }
                before_phone()
                line = self.accept(job, out) or ''
                if '완료' not in line or '실패' in line or '못 함' in line:
                    task['phase'] = 'accept'
                    reason = mask_text(line)[:200] or reason
                verified = self._check(task, before_phone)
            if verified:
                task['state'] = 'verified'
                task['reason'] = '선물 원본 수락 독립 재확인'
                self._save(job, task)
                return 'SSG 선물 수락 완료 — 선물 원본 독립 재확인'
        except GiftFollowupStopped as exc:
            task['state'] = 'needs_ai'
            reason = str(exc)
        except Exception as exc:  # noqa: BLE001 — 완료된 구매를 되돌리지 않는다
            reason = mask_text(str(exc))[:200]
        task['reason'] = reason
        if task['attempts'] >= 8:
            task['state'] = 'needs_ai'
        self._save(job, task)
        return f'SSG 선물 수락 실패 — 별도 확인 {task["state"]}: {reason} · 재결제 금지'

    def drain(self) -> bool:
        due = self.queue.pending_gift_followups(self.now())
        if not due:
            return False
        job = due[0]
        line = self._process(job, dict(job.options[GIFT_FOLLOWUP_KEY]))
        if self.add_memo:
            self.add_memo(job.key, f'[선물 재검증] {line}')
        return True
