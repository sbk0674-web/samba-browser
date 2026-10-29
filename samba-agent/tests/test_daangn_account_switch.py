import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    'daangn_switch', Path(__file__).parents[1] / 'tools/daangn/account_switch.py'
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakePhone:
    def __init__(self):
        self.events = []
        self.airplane = False
        self.usb = True
        self.online = True
    def assert_lock(self, serial): self.events.append('lock')
    def assert_usb_serial(self, serial):
        self.events.append('usb')
        if not self.usb: raise RuntimeError('USB 연결 없음')
    def clear_background(self): self.events.append('clear')
    def set_airplane(self, enabled):
        self.events.append('on' if enabled else 'off')
        self.airplane = enabled
    def airplane_enabled(self): return self.airplane
    def sleep(self, seconds): self.events.append(('wait', seconds))
    def internet_ready(self): return self.online
    def open_account(self, name): self.events.append(('open', name))
    def verify_account(self, name): return True


def test_switch_clears_background_and_airplane_for_three_seconds():
    phone = FakePhone()
    module.switch_account(phone, serial='serial', target='임귀태')
    assert phone.events == ['lock', 'usb', 'clear', 'usb', 'on', ('wait', 3), 'off', 'usb', ('open', '임귀태')]


def test_switch_stops_without_usb_or_network():
    phone = FakePhone()
    phone.usb = False
    with pytest.raises(RuntimeError): module.switch_account(phone, serial='serial', target='임귀태')
    assert phone.events == ['lock', 'usb']
    phone = FakePhone()
    phone.online = False
    with pytest.raises(RuntimeError): module.switch_account(phone, serial='serial', target='임귀태')
    assert ('open', '임귀태') not in phone.events
    assert phone.airplane is False


def test_already_verified_account_does_not_switch():
    phone = FakePhone()
    module.switch_account(phone, serial='serial', target='임귀태', already_verified=True)
    assert phone.events == ['lock']


def test_failure_while_airplane_is_on_turns_it_off_and_does_not_open_account():
    phone = FakePhone()
    def failed_wait(seconds):
        raise RuntimeError('연결 확인 실패')
    phone.sleep = failed_wait
    with pytest.raises(RuntimeError): module.switch_account(phone, serial='serial', target='임귀태')
    assert phone.airplane is False
    assert ('open', '임귀태') not in phone.events


def test_wrong_already_selected_account_never_skips_checks():
    phone = FakePhone()
    phone.verify_account = lambda name: False
    with pytest.raises(RuntimeError): module.switch_account(phone, serial='serial', target='임귀태', already_verified=True)
    assert phone.events == ['lock']


def test_android_clear_all_requires_visible_success(monkeypatch):
    import xml.etree.ElementTree as ET
    phone = module.AndroidAccountPhone('adb', 'serial', 'owner', lambda _: 'owner', lambda _: None, lambda _: True)
    calls = []
    monkeypatch.setattr(module.time, 'sleep', lambda _: None)
    monkeypatch.setattr(phone, '_run', lambda *args: calls.append(args) or '')
    screens = iter([
        ET.fromstring('<hierarchy><node text="모두 닫기" bounds="[10,20][110,80]"/></hierarchy>'),
        ET.fromstring('<hierarchy><node text="최근에 사용한 앱이 없습니다"/></hierarchy>')
    ])
    monkeypatch.setattr(phone, '_screen', lambda: next(screens))
    phone.clear_background()
    assert ('shell', 'input', 'tap', '60', '50') in calls
    assert calls[-1] == ('shell', 'input', 'keyevent', 'KEYCODE_HOME')


def test_android_clear_all_stops_if_success_cannot_be_confirmed(monkeypatch):
    import xml.etree.ElementTree as ET
    phone = module.AndroidAccountPhone('adb', 'serial', 'owner', lambda _: 'owner', lambda _: None, lambda _: True)
    monkeypatch.setattr(module.time, 'sleep', lambda _: None)
    monkeypatch.setattr(phone, '_run', lambda *args: '')
    monkeypatch.setattr(phone, '_screen', lambda: ET.fromstring('<hierarchy/>'))
    with pytest.raises(RuntimeError, match='모두 닫기'):
        phone.clear_background()


def test_empty_recent_apps_is_already_clear(monkeypatch):
    import xml.etree.ElementTree as ET
    phone = module.AndroidAccountPhone('adb', 'serial', 'owner', lambda _: 'owner', lambda _: None, lambda _: True)
    calls = []
    monkeypatch.setattr(module.time, 'sleep', lambda _: None)
    monkeypatch.setattr(phone, '_run', lambda *args: calls.append(args) or '')
    monkeypatch.setattr(phone, '_screen', lambda: ET.fromstring('<hierarchy><node text="최근에 사용한 앱이 없습니다"/></hierarchy>'))
    phone.clear_background()
    assert calls[-1] == ('shell', 'input', 'keyevent', 'KEYCODE_HOME')
