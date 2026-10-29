"""공유 폰 계정 이동 전 필수 순서. 등록과 주문확인에서 같은 함수를 쓴다."""

import re
import subprocess
import time
import xml.etree.ElementTree as ET


def switch_account(phone, *, serial: str, target: str, already_verified: bool = False) -> None:
    if not serial or not target:
        raise ValueError('폰과 계정이 필요합니다')
    phone.assert_lock(serial)
    if already_verified:
        if not phone.verify_account(target):
            raise RuntimeError('현재 계정을 확인할 수 없습니다')
        return

    phone.assert_usb_serial(serial)
    phone.clear_background()
    phone.assert_usb_serial(serial)
    try:
        phone.set_airplane(True)
        if not phone.airplane_enabled():
            raise RuntimeError('비행기모드 켜기 확인 실패')
        phone.sleep(3)
    finally:
        # 켜기 응답이 불명확해도 끄기를 먼저 시도한다.
        phone.set_airplane(False)
    if phone.airplane_enabled():
        raise RuntimeError('비행기모드 끄기 확인 실패')
    phone.assert_usb_serial(serial)
    if not phone.internet_ready():
        raise RuntimeError('인터넷 복구 확인 실패')
    phone.open_account(target)
    if not phone.verify_account(target):
        raise RuntimeError('전환한 계정을 확인할 수 없습니다')


class AndroidAccountPhone:
    """USB 연결, 공유 잠금과 안드로이드 상태를 확인하는 전환 드라이버."""

    def __init__(self, adb, serial, owner, lock_holder, open_account, verify_account):
        self.adb, self.serial, self.owner = adb, serial, owner
        self.lock_holder = lock_holder
        self._open_account, self._verify_account = open_account, verify_account

    def _run(self, *args):
        result = subprocess.run([self.adb, '-s', self.serial, *args], capture_output=True, timeout=25)
        if result.returncode:
            raise RuntimeError('폰 명령 실패')
        return result.stdout.decode('utf-8', 'replace').strip()

    def assert_lock(self, serial):
        if serial != self.serial or self.lock_holder(serial) != self.owner:
            raise RuntimeError('폰 공유 잠금 확인 실패')

    def assert_usb_serial(self, serial):
        result = subprocess.run([self.adb, 'devices'], capture_output=True, timeout=10)
        lines = result.stdout.decode('utf-8', 'replace').splitlines()
        if result.returncode or not any(line.split()[:2] == [serial, 'device'] for line in lines):
            raise RuntimeError('USB 연결 확인 실패')
        if self._run('shell', 'getprop', 'ro.serialno') != serial:
            raise RuntimeError('폰 일련번호 불일치')

    def _screen(self):
        out = self._run('exec-out', 'uiautomator', 'dump', '/dev/tty')
        start, end = out.find('<?xml'), out.rfind('</hierarchy>')
        if start < 0 or end < 0:
            raise RuntimeError('폰 화면 확인 실패')
        return ET.fromstring(out[start:end + len('</hierarchy>')])

    def clear_background(self):
        self._run('shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH')
        time.sleep(1)
        root = self._screen()
        initial = [(n.get('text') or n.get('content-desc') or '').strip() for n in root.iter('node')]
        if any('최근에 사용한 앱이 없습니다' in t or '최근 앱이 없습니다' in t for t in initial):
            self._run('shell', 'input', 'keyevent', 'KEYCODE_HOME')
            return
        nodes = [n for n in root.iter('node') if (n.get('text') or n.get('content-desc') or '').strip() == '모두 닫기']
        if len(nodes) != 1:
            raise RuntimeError('모두 닫기 버튼 확인 실패')
        coords = [int(v) for v in re.findall(r'\d+', nodes[0].get('bounds', ''))]
        if len(coords) != 4 or coords[2] <= coords[0] or coords[3] <= coords[1]:
            raise RuntimeError('모두 닫기 위치 확인 실패')
        self._run('shell', 'input', 'tap', str((coords[0] + coords[2]) // 2), str((coords[1] + coords[3]) // 2))
        time.sleep(1)
        self._run('shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH')
        time.sleep(1)
        after = self._screen()
        texts = [(n.get('text') or n.get('content-desc') or '').strip() for n in after.iter('node')]
        if '모두 닫기' in texts or not any('최근에 사용한 앱이 없습니다' in t or '최근 앱이 없습니다' in t for t in texts):
            raise RuntimeError('백그라운드 종료 확인 실패')
        self._run('shell', 'input', 'keyevent', 'KEYCODE_HOME')

    def set_airplane(self, enabled):
        self._run('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable' if enabled else 'disable')

    def airplane_enabled(self):
        state = self._run('shell', 'settings', 'get', 'global', 'airplane_mode_on')
        if state not in ('0', '1'):
            raise RuntimeError('비행기모드 상태 확인 실패')
        return state == '1'

    def sleep(self, seconds):
        time.sleep(seconds)

    def internet_ready(self):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            out = self._run('shell', 'dumpsys', 'connectivity')
            match = re.search(r'Active default network:\s*(\d+)', out)
            if match and re.search(r'NetworkAgentInfo\{network\{' + re.escape(match.group(1)) + r'\}[^\n]*IS_VALIDATED', out):
                return True
            time.sleep(2)
        return False

    def open_account(self, name):
        self._open_account(name)

    def verify_account(self, name):
        return self._verify_account(name) is True
