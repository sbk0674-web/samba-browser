from contextlib import contextmanager

import pytest

from samba_agent.ops import ssg_gift_accept as phone_ops
from samba_agent.ops import ssg_gift_followup as followup


@pytest.mark.parametrize(
    'calls,foreground,power,error',
    [
        ('mCallState=1', 'com.kakao.talk', 'mWakefulness=Awake', '통화'),
        ('', 'com.kakao.talk', 'mWakefulness=Awake', '통화'),
        ('mCallState=0', 'com.nhn.android.search', 'mWakefulness=Awake', None),
        ('mCallState=0', 'com.eg.android.AlipayGphone', 'mWakefulness=Asleep', '알리페이'),
        ('mCallState=0', 'com.kakao.talk', 'unreadable', '화면 상태'),
        ('mCallState=0', 'com.kakao.talk', 'mWakefulness=Awake', None),
        ('mCallState=0', 'com.nhn.android.search', 'mWakefulness=Asleep', None),
    ],
)
def test_shared_lock_call_and_user_screen_guards(monkeypatch, calls, foreground, power, error):
    events = []

    @contextmanager
    def shared(serial, owner):
        assert serial == phone_ops.DEFAULT_PHONE
        assert owner.startswith('ssg-gift-followup:')
        events.append('lock')
        try:
            yield
        finally:
            events.append('unlock')

    class Busy:
        def acquire(self, timeout):
            assert timeout == 0
            events.append('busy')
            return True

        def release(self):
            events.append('release')

    class Phone:
        def __init__(self, adb, serial):
            self.serial = serial

        def _run(self, *args):
            if args[-1] == 'ro.serialno':
                return phone_ops.DEFAULT_PHONE
            if args[-1] == 'telephony.registry':
                return calls
            if args[-1] == 'power':
                return power
            pytest.fail('예상치 못한 폰 명령')

        def top_package(self):
            return foreground

        def wake(self):
            events.append('wake')

        def nodes(self):
            return []

        def launch(self, package):
            assert package == 'com.kakao.talk'
            events.append('launch')

    monkeypatch.delenv('SAMBA_PAY_PHONE', raising=False)
    monkeypatch.setattr(followup, '_shared_phone_lock', shared)
    monkeypatch.setattr(phone_ops, 'Phone', Phone)
    monkeypatch.setattr(phone_ops, 'PHONE_BUSY', Busy())
    monkeypatch.setattr(phone_ops, 'find_phone_serial', lambda *_: 'transport')
    monkeypatch.setattr(phone_ops, 'wait_foreground', lambda *_: True)
    session = followup.make_phone_session()
    if error:
        with pytest.raises(phone_ops.GiftAcceptError, match=error), session():
            pytest.fail('안전 확인 실패 시 진입 금지')
    else:
        with session():
            events.append('body')
        assert 'body' in events
    assert events[-2:] == ['release', 'unlock']
    if 'Asleep' in power and not error:
        assert events.index('wake') < events.index('launch') < events.index('body')
    else:
        assert 'wake' not in events
