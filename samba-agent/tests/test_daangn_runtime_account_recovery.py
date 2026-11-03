"""All phone, lock, identity and transport boundaries are fake; never touch a device."""

import xml.etree.ElementTree as ET
from types import SimpleNamespace

import pytest

from tools.daangn import runtime


class FakePhone:
    def __init__(self, verified=(False, True), **kwargs):
        self.__dict__.update(adb='fake', serial='serial', owner='김귀옥', lock_owner='ours')
        self.__dict__.update(kwargs)
        self.verified = iter(verified)
        self.events = []
        self.calls = b'mCallState=0'
        self.power = b'lastUserActivityTime=123 (45000 ms ago)'
        self.screen = '<hierarchy><node text="나의 당근"/></hierarchy>'

    def assert_lock(self): self.events.append('lock')
    def assert_connected(self): self.events.append('connected')
    def verify_account(self, account):
        self.events.append('verify')
        return next(self.verified)
    def _run(self, *args):
        self.events.append(args)
        if args == ('shell', 'dumpsys', 'telephony.registry'): return self.calls
        if args == ('shell', 'dumpsys', 'power'): return self.power
        return b''
    def _screen(self):
        self.events.append('screen')
        return self.screen, ET.fromstring(self.screen)


@pytest.fixture(autouse=True)
def no_live_access(monkeypatch):
    def forbidden(*args, **kwargs): raise AssertionError('live access forbidden')
    monkeypatch.setattr(runtime.subprocess, 'run', forbidden)
    monkeypatch.setattr(runtime.sqlite3, 'connect', forbidden)
    monkeypatch.setattr(runtime.time, 'sleep', lambda _: None)


def test_already_verified_account_has_no_wake_launch_or_switch(monkeypatch):
    phone = FakePhone(verified=(True,))
    monkeypatch.setattr(runtime, 'switch_account', lambda *a, **k: pytest.fail('switch'))
    runtime._prepare_account(phone, SimpleNamespace(holder=lambda _: 'ours'))
    assert phone.events == ['verify']


def test_opening_same_account_on_wireless_does_not_require_usb(monkeypatch):
    phone = FakePhone(transport='192.0.2.1:5555')
    monkeypatch.setattr(runtime, 'switch_account', lambda *a, **k: pytest.fail('switch'))
    runtime._prepare_account(phone, SimpleNamespace(holder=lambda _: 'ours'))
    commands = [e for e in phone.events if isinstance(e, tuple)]
    assert commands == [
        ('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'),
        ('shell', 'monkey', '-p', 'com.towneers.www', '-c', 'android.intent.category.LAUNCHER', '1'),
    ]
    assert phone.events.count('verify') == 2


def test_wrong_account_on_wireless_still_requires_existing_usb_switch(monkeypatch):
    phone = FakePhone(verified=(False, False))
    switch_events = []
    class UsbDevice:
        def __init__(self, *args): pass
        def assert_lock(self, serial): switch_events.append('lock')
        def assert_usb_serial(self, serial):
            switch_events.append('usb')
            raise RuntimeError('USB 연결 확인 실패')
    monkeypatch.setattr(runtime, 'AndroidAccountPhone', UsbDevice)
    with pytest.raises(RuntimeError, match='USB'):
        runtime._prepare_account(phone, SimpleNamespace(holder=lambda _: 'ours'))
    assert switch_events == ['lock', 'usb']
    assert phone.events.count('verify') == 2


@pytest.mark.parametrize('screen', [
    '<hierarchy><node resource-id="com.android.systemui:id/pinEntry"/></hierarchy>',
    '<hierarchy><node password="true"/></hierarchy>',
    '<hierarchy><node text="로그인"/></hierarchy>',
    '<hierarchy><node text="휴대폰 번호"/></hierarchy>',
])
def test_pin_or_login_is_held_without_usb_switch(monkeypatch, screen):
    phone = FakePhone(verified=(False, False))
    phone.screen = screen
    monkeypatch.setattr(runtime, 'switch_account', lambda *a, **k: pytest.fail('switch'))
    with pytest.raises(RuntimeError):
        runtime._prepare_account(phone, SimpleNamespace(holder=lambda _: 'ours'))
    assert not any(isinstance(e, tuple) and 'tap' in e for e in phone.events)


def test_clone_account_never_uses_normal_foreground_shortcut(monkeypatch):
    phone = FakePhone(verified=(False,), serial='R5CT33ZR53H', owner='임귀태')
    def switch(*args, **kwargs): raise RuntimeError('USB required')
    monkeypatch.setattr(runtime, 'switch_account', switch)
    with pytest.raises(RuntimeError, match='USB'):
        runtime._prepare_account(phone, SimpleNamespace(holder=lambda _: 'ours'))
    assert phone.events == ['verify']


def test_login_after_foreground_stops_before_second_verification_or_switch(monkeypatch):
    phone = FakePhone(verified=(False,))
    screens = iter([
        '<hierarchy><node text="다른 앱"/></hierarchy>',
        '<hierarchy><node text="시작하기"/></hierarchy>',
    ])
    monkeypatch.setattr(phone, '_screen', lambda: ('', ET.fromstring(next(screens))))
    monkeypatch.setattr(runtime, 'switch_account', lambda *a, **k: pytest.fail('switch'))
    with pytest.raises(RuntimeError, match='로그인'):
        runtime._prepare_account(phone, SimpleNamespace(holder=lambda _: 'ours'))
    assert phone.events.count('verify') == 1


def reader(monkeypatch, phone, held=None, schedule=None):
    state = {'holder': held, 'owners': [], 'released': [], 'read': 0}
    class Lock:
        def __init__(self, serial, owner, **kwargs): self.owner = owner
        def __enter__(self):
            if state['holder'] not in (None, self.owner): raise RuntimeError('busy')
            state['holder'] = self.owner
            state['owners'].append(self.owner)
        def __exit__(self, *args):
            if state['holder'] == self.owner:
                state['released'].append(self.owner)
                state['holder'] = None
    locks = SimpleNamespace(PhoneLock=Lock, holder=lambda _: state['holder'])
    spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
    monkeypatch.setattr(runtime.importlib.util, 'spec_from_file_location', lambda *a: spec)
    monkeypatch.setattr(runtime.importlib.util, 'module_from_spec', lambda _: locks)
    monkeypatch.setattr(runtime, '_phone_identity', lambda _: ('serial', 'nickname'))
    monkeypatch.setattr(runtime, '_transport', lambda _: '192.0.2.1:5555')
    def create_phone(**kwargs):
        phone.lock_owner = kwargs['lock_owner']
        return phone
    monkeypatch.setattr(runtime, 'AndroidPhone', create_phone)
    def read(*args, **kwargs):
        state['read'] += 1
        return 'read'
    monkeypatch.setattr(runtime, 'read_phone_order', read)
    return runtime.make_phone_reader(None, schedule=schedule), state


@pytest.mark.parametrize('calls,power', [
    (b'mCallState=1', b'lastUserActivityTime=123 (45000 ms ago)'),
    (b'mCallState=2\nmCallState=0', b'lastUserActivityTime=123 (45000 ms ago)'),
    (b'unknown', b'lastUserActivityTime=123 (45000 ms ago)'),
    (b'mCallState=0', b'lastUserActivityTime=123 (1000 ms ago)'),
    (b'mCallState=0', b'unknown'),
])
def test_busy_or_unknown_phone_stops_before_verification_wake_and_read(monkeypatch, calls, power):
    phone = FakePhone()
    phone.calls, phone.power = calls, power
    inspect, state = reader(monkeypatch, phone)
    with pytest.raises(RuntimeError):
        inspect(SimpleNamespace(account='김귀옥', room_id='room'), None)
    assert phone.events[:2] == ['lock', 'connected']
    assert 'verify' not in phone.events and state['read'] == 0
    assert not any(isinstance(e, tuple) and 'keyevent' in e for e in phone.events)


def test_reader_checks_safety_before_wake_and_uses_pid_unique_lock_owner(monkeypatch):
    phone = FakePhone(verified=(False, True, True))
    inspect, state = reader(monkeypatch, phone)
    for pid in (101, 202):
        monkeypatch.setattr(runtime.os, 'getpid', lambda pid=pid: pid)
        assert inspect(SimpleNamespace(account='김귀옥', room_id='room'), None) == 'read'
    assert len(set(state['owners'])) == 2
    assert '101' in state['owners'][0] and '202' in state['owners'][1]
    assert state['released'] == state['owners']
    assert phone.lock_owner == state['owners'][-1]
    assert phone.events[:5] == [
        'lock', 'connected', ('shell', 'dumpsys', 'telephony.registry'),
        ('shell', 'dumpsys', 'power'), 'verify',
    ]


def test_other_owner_lock_is_never_taken_or_released(monkeypatch):
    phone = FakePhone()
    inspect, state = reader(monkeypatch, phone, held='human-session')
    with pytest.raises(RuntimeError, match='busy'):
        inspect(SimpleNamespace(account='김귀옥', room_id='room'), None)
    assert state['holder'] == 'human-session' and state['released'] == []
    assert phone.events == []


@pytest.mark.parametrize('method', ['assert_lock', 'assert_connected'])
def test_failed_lock_or_connection_check_prevents_screen_actions(monkeypatch, method):
    phone = FakePhone()
    inspect, state = reader(monkeypatch, phone)
    def failed(): raise RuntimeError('safety check failed')
    monkeypatch.setattr(phone, method, failed)
    with pytest.raises(RuntimeError, match='safety'):
        inspect(SimpleNamespace(account='김귀옥', room_id='room'), None)
    assert 'verify' not in phone.events and state['read'] == 0
    assert not any(isinstance(e, tuple) for e in phone.events)


def test_call_safety_hold_does_not_consume_chat_search_cooldown(monkeypatch):
    phone = FakePhone(verified=(True,))
    phone.calls = b'mCallState=2'
    schedule = runtime.CandidateSchedule()
    inspect, state = reader(monkeypatch, phone, schedule=schedule)
    candidate = SimpleNamespace(account='김귀옥', room_id='room')
    chat = SimpleNamespace(payment_event_at=None)
    with pytest.raises(RuntimeError, match='통화'):
        inspect(candidate, chat)
    assert schedule.phone_next_check == {}
    phone.calls = b'mCallState=0'
    assert inspect(candidate, chat) == 'read'
    before = list(phone.events)
    with pytest.raises(RuntimeError, match='재탐색'):
        inspect(candidate, chat)
    assert phone.events == before and state['read'] == 1
