"""SSG 선물 수락 — 결제 뒤 카카오톡 SSG닷컴 알림톡에서 선물을 받는다(사용자 2026-10-01 "하네스에 확실하게 이식").

SSG 선물 주문은 받는 분(우리 번호)이 카카오톡에서 수락해야 발송된다(기한 1주일). 폰(adb)으로 사람이 하던 순서를 그대로 한다:
카카오톡 채팅 목록 → SSG닷컴 → 맨 아래 '선물 받으러 가기' → '옵션/배송지 확인' → 배송 요청사항 '부재 시 문앞에 놓아주세요'
→ '선물 받기' → '선물 받기 완료' 확인 → 리뷰 팝업 '다음에 할게요!' → 인앱 브라우저 닫기(X) → 홈.
마지막에 브라우저를 닫아야 다음 결제(카톡결제·폰 승인)가 이 화면에 막히지 않는다(사용자 2026-10-01).

배송지는 주문 때 이미 넣었다 — 수락 화면의 배송지 '변경'은 건드리지 않는다(사용자 2026-09-29).
고객 이름·주소는 로그·결과에 남기지 않는다.
"""

import logging
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass

log = logging.getLogger(__name__)

DEFAULT_ADB = os.path.expanduser(r'~\Downloads\pt\platform-tools\adb.exe')
# 결제 폰(임성희 폰 SM-A426N) — 무선 디버깅이면 기기 이름이 'adb-<시리얼>-…' 이나 IP:포트라 시리얼을 품은 줄을 찾는다
DEFAULT_PHONE = 'R5CR30LFATY'
KAKAO = 'com.kakao.talk'
CHANNEL = 'SSG닷컴'
GO_GIFT = '선물 받으러 가기'
CHECK_BTN = '옵션/배송지 확인'
DOOR = '부재 시 문앞에 놓아주세요'
ACCEPT = '선물 받기'
DONE = '선물 받기 완료'
LATER = '다음에 할게요!'
CLOSE_ID = 'com.kakao.talk:id/webview_navi_close_button'


@dataclass(frozen=True)
class Node:
    text: str
    desc: str
    rid: str
    x: int
    y: int


_BOUNDS = re.compile(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]')


def parse_nodes(xml: str) -> list[Node]:
    """uiautomator 덤프 → 글자·설명·id·가운데 좌표. 읽지 못하면 빈 목록."""
    try:
        root = ET.fromstring(xml[xml.find('<?xml') :] if '<?xml' in xml else xml)
    except ET.ParseError:
        return []
    out: list[Node] = []
    for el in root.iter('node'):
        m = _BOUNDS.match(el.get('bounds') or '')
        if not m:
            continue
        x1, y1, x2, y2 = (int(v) for v in m.groups())
        out.append(
            Node(
                text=(el.get('text') or '').strip(),
                desc=(el.get('content-desc') or '').strip(),
                rid=el.get('resource-id') or '',
                x=(x1 + x2) // 2,
                y=(y1 + y2) // 2,
            )
        )
    return out


def find_text(nodes: list[Node], text: str, *, last: bool = False) -> Node | None:
    """글자가 정확히 같은 요소(last 면 화면 맨 아래 것)."""
    hits = [n for n in nodes if n.text == text]
    if not hits:
        return None
    return max(hits, key=lambda n: n.y) if last else hits[0]


def has_text(nodes: list[Node], part: str) -> bool:
    return any(part in n.text for n in nodes)


class Phone:
    """adb 로 화면을 읽고 누른다. 테스트는 이 클래스를 가짜로 바꾼다."""

    def __init__(self, adb: str, serial: str) -> None:
        self.adb = adb
        self.serial = serial

    def _run(self, *args: str, timeout: float = 20) -> str:
        done = subprocess.run(
            [self.adb, '-s', self.serial, *args],
            capture_output=True,
            timeout=timeout,
            check=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        return done.stdout.decode('utf-8', 'replace')

    def nodes(self) -> list[Node]:
        self._run('shell', 'uiautomator', 'dump', '/sdcard/samba_ui.xml')
        return parse_nodes(self._run('shell', 'cat', '/sdcard/samba_ui.xml'))

    def top_package(self) -> str:
        out = self._run('shell', 'dumpsys', 'activity', 'activities')
        m = re.search(r'topResumedActivity=ActivityRecord\{\S+ \S+ ([\w.]+)/', out)
        return m.group(1) if m else ''

    def tap(self, x: int, y: int) -> None:
        self._run('shell', 'input', 'tap', str(x), str(y))

    def swipe_up(self) -> None:
        self._run('shell', 'input', 'swipe', '360', '1300', '360', '500', '400')

    def key(self, code: str) -> None:
        self._run('shell', 'input', 'keyevent', code)

    def launch(self, package: str) -> None:
        self._run('shell', 'monkey', '-p', package, '-c', 'android.intent.category.LAUNCHER', '1')


def find_phone_serial(adb: str, want: str = DEFAULT_PHONE) -> str | None:
    """연결된 기기 중 결제 폰. 무선(IP:포트·adb-<시리얼>-…)도 시리얼로 찾는다. 없으면 None."""
    try:
        out = subprocess.run(
            [adb, 'devices'],
            capture_output=True,
            timeout=15,
            check=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        ).stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.TimeoutExpired):
        return None
    rows = [ln.split('\t')[0] for ln in out.splitlines()[1:] if ln.endswith('\tdevice')]
    named = [r for r in rows if want in r]
    if named:
        return named[0]
    # 무선 IP:포트는 이름에 시리얼이 없다 — 각 기기의 실제 시리얼을 물어 맞춘다
    for r in rows:
        try:
            got = subprocess.run(
                [adb, '-s', r, 'shell', 'getprop', 'ro.serialno'],
                capture_output=True,
                timeout=10,
                check=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            ).stdout.decode('utf-8', 'replace').strip()
        except (OSError, subprocess.TimeoutExpired):
            continue
        if got == want:
            return r
    return None


class GiftAcceptError(Exception):
    """선물 수락 실패 — 사유는 사람에게 넘길 한 줄(개인정보 없음)."""


def accept_ssg_gift(
    phone: Phone,
    model_code: str,
    *,
    sleep: Callable[[float], None] = time.sleep,
    wait_message_s: float = 180,
) -> str:
    """카카오톡 SSG닷컴 알림톡의 선물을 받는다. 성공하면 결과 한 줄, 실패하면 GiftAcceptError.

    model_code 가 있으면 수락 화면의 상품명에 그 코드가 보여야 받는다(다른 주문의 선물을 받지 않게).
    """

    def wait_for(check: Callable[[list[Node]], bool], seconds: float, step: float = 2) -> list[Node]:
        end = time.monotonic() + seconds
        nodes = phone.nodes()
        while not check(nodes) and time.monotonic() < end:
            sleep(step)
            nodes = phone.nodes()
        return nodes

    # 1) 카카오톡 채팅 목록에서 SSG닷컴 방 — 앱이 다른 방·브라우저에 있으면 뒤로 가며 목록을 찾는다
    phone.launch(KAKAO)
    sleep(3)
    nodes = phone.nodes()
    for _ in range(4):
        if find_text(nodes, GO_GIFT) or find_text(nodes, CHANNEL):
            break
        phone.key('4')  # BACK
        sleep(1.5)
        nodes = phone.nodes()
    if not find_text(nodes, GO_GIFT):
        room = find_text(nodes, CHANNEL)
        if room is None:
            raise GiftAcceptError('카카오톡 채팅 목록에서 SSG닷컴 방을 못 찾았다')
        phone.tap(room.x, room.y)
        sleep(3)
    # 2) 결제 직후엔 알림톡이 늦게 온다 — 맨 아래 '선물 받으러 가기'가 생길 때까지 기다린다
    nodes = wait_for(lambda ns: find_text(ns, GO_GIFT) is not None, wait_message_s, step=10)
    go = find_text(nodes, GO_GIFT, last=True)
    if go is None:
        raise GiftAcceptError(f'SSG닷컴 알림톡에 "{GO_GIFT}" 버튼이 {int(wait_message_s)}초 안에 안 왔다')
    phone.tap(go.x, go.y)
    # 3) 선물받기 화면 → 옵션/배송지 확인
    nodes = wait_for(lambda ns: find_text(ns, CHECK_BTN) is not None or has_text(ns, DONE), 30)
    if has_text(nodes, DONE):
        _close_browser(phone, sleep)
        return '이미 받은 선물(완료 화면) — 브라우저 닫음'
    check_btn = find_text(nodes, CHECK_BTN)
    if check_btn is None:
        raise GiftAcceptError('선물받기 화면에서 "옵션/배송지 확인"이 안 보인다(인앱 브라우저 로딩 멈춤일 수 있다)')
    phone.tap(check_btn.x, check_btn.y)
    nodes = wait_for(lambda ns: has_text(ns, '배송지'), 20)
    if model_code and not any(model_code.upper() in n.text.upper() for n in nodes):
        _close_browser(phone, sleep)
        raise GiftAcceptError(f'수락 화면 상품이 이 주문({model_code})이 아니다 — 받지 않고 닫음')
    # 4) 배송 요청사항 '부재 시 문앞에 놓아주세요' — 기본값은 경비실이라 반드시 바꾼다(사용자 2026-09-29)
    for _ in range(4):
        if find_text(nodes, DOOR) and find_text(nodes, ACCEPT):
            break
        phone.swipe_up()
        sleep(1.5)
        nodes = phone.nodes()
    door = find_text(nodes, DOOR)
    accept = find_text(nodes, ACCEPT)
    if door is None or accept is None:
        raise GiftAcceptError('배송 요청사항(문앞)·"선물 받기" 버튼을 못 찾았다')
    phone.tap(door.x, door.y)  # 글자 줄 전체가 라디오 버튼 영역이다
    sleep(1)
    phone.tap(accept.x, accept.y)
    nodes = wait_for(lambda ns: has_text(ns, DONE), 20)
    if not has_text(nodes, DONE):
        raise GiftAcceptError('"선물 받기"를 눌렀지만 완료 화면이 안 떴다 — 사람이 확인')
    # 5) 리뷰 팝업 닫고 인앱 브라우저 X — 다음 결제가 이 화면에 막히지 않게
    later = find_text(nodes, LATER)
    if later is not None:
        phone.tap(later.x, later.y)
        sleep(1.5)
    _close_browser(phone, sleep)
    return '선물 받기 완료(부재 시 문앞) — 브라우저 닫음'


def _close_browser(phone: Phone, sleep: Callable[[float], None]) -> None:
    """카카오톡 인앱 브라우저를 X 로 닫고 홈으로 나간다."""
    for _ in range(3):
        close = next((n for n in phone.nodes() if n.rid == CLOSE_ID), None)
        if close is None:
            break
        phone.tap(close.x, close.y)
        sleep(1.5)
    phone.key('3')  # HOME


def gift_order_of(out: dict) -> bool:
    """그래프 결과의 구매 단계가 선물 주문으로 샀는가."""
    for name, r in (out.get('results') or {}).items():
        if not str(name).startswith('buyer.'):
            continue
        payload = getattr(r, 'payload', None) if not isinstance(r, dict) else r.get('payload')
        if isinstance(payload, dict) and payload.get('order_type') == 'gift':
            return True
    return False


def make_after_done(
    source_of_job: Callable[[object], tuple[str, str]],
    *,
    adb: str | None = None,
    phone_serial: str | None = None,
) -> Callable[[object, dict], str | None]:
    """끝난 작업 뒤처리 — SSG 선물 주문이면 폰에서 선물을 받는다. source_of_job(작업) → (소싱처, 상품명)."""
    from samba_agent.agents.buyer import model_code_of

    adb_path = adb or os.environ.get('SAMBA_ADB') or DEFAULT_ADB
    want = phone_serial or os.environ.get('SAMBA_PAY_PHONE') or DEFAULT_PHONE

    def after(job: object, out: dict) -> str | None:
        source, sku = source_of_job(job)
        if source.upper() != 'SSG' or not gift_order_of(out):
            return None
        serial = find_phone_serial(adb_path, want)
        if serial is None:
            return 'SSG 선물 수락 못 함 — 결제 폰이 연결돼 있지 않다(카카오톡에서 직접 수락 필요, 기한 1주일)'
        try:
            return 'SSG ' + accept_ssg_gift(Phone(adb_path, serial), model_code_of(sku))
        except GiftAcceptError as e:
            return f'SSG 선물 수락 실패 — {e}(카카오톡에서 직접 수락 필요)'
        except (OSError, subprocess.TimeoutExpired) as e:
            return f'SSG 선물 수락 실패 — 폰 명령 오류 {type(e).__name__}(카카오톡에서 직접 수락 필요)'

    return after
