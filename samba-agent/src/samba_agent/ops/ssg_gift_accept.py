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
import threading
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass
from typing import Self

log = logging.getLogger(__name__)

DEFAULT_ADB = os.path.expanduser(r'~\Downloads\pt\platform-tools\adb.exe')
# 결제 폰(임성희 폰 SM-A426N) — 무선 디버깅이면 기기 이름이 'adb-<시리얼>-…' 이나 IP:포트라 시리얼을 품은 줄을 찾는다
DEFAULT_PHONE = 'R5CR30LFATY'
KAKAO = 'com.kakao.talk'
# 폰을 쓰는 모든 작업(得物 구매·송장, 롯데ON 선물 송장, SSG 선물 수락)이 서로 겹치지 않게 잡는 자물쇠 — 아래 PhoneLock
# 사람이(또는 다른 세션이) 폰을 직접 만지는 동안 samba-agent 폴더에 만들어 두는 파일 — 있으면 주기 작업이 폰에 손대지 않는다
PHONE_HOLD_FILE = 'PHONE_HOLD'
_AGENT_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)


class PhoneLock:
    """폰 하나를 한 번에 한 작업만 쓰게 하는 자물쇠 — 스레드 사이는 RLock, 프로세스 사이는 파일 잠금.

    예전엔 threading.Lock 이라 같은 프로세스 안에서만 통했다. 그래서 다른 프로세스(수동 스크립트·다른 세션)나
    잠금을 안 쓰던 SSG 선물 수락이 득물 구매·롯데ON 선물 송장과 폰 화면을 두고 부딪쳐 검색 버튼·결제창을 못 찾고
    멈췄다(2026-10-08). 파일 잠금은 프로세스가 죽으면 운영체제가 풀어 줘서 남는 잠금이 없다.
    같은 스레드가 다시 들어와도(재진입) 막히지 않는다.
    """

    def __init__(self, path: str, poll_s: float = 0.5) -> None:
        self._path = path
        self._poll = poll_s
        self._rlock = threading.RLock()
        self._depth = 0
        self._fh: object | None = None

    def _try_file_lock(self) -> bool:
        fh = open(self._path, 'a+b')  # noqa: SIM115 — 잠금을 쥐고 있는 동안 열어 둔다
        try:
            if os.name == 'nt':
                import msvcrt

                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        self._fh = fh
        return True

    def acquire(self, timeout: float | None = None) -> bool:
        if not self._rlock.acquire(timeout=-1 if timeout is None else timeout):
            return False
        if self._depth == 0:
            end = None if timeout is None else time.monotonic() + timeout
            while not self._try_file_lock():
                if end is not None and time.monotonic() >= end:
                    self._rlock.release()
                    return False
                time.sleep(self._poll)
        self._depth += 1
        return True

    def release(self) -> None:
        self._depth -= 1
        if self._depth == 0 and self._fh is not None:
            fh, self._fh = self._fh, None
            try:
                if os.name == 'nt':
                    import msvcrt

                    fh.seek(0)  # type: ignore[attr-defined]
                    msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)  # type: ignore[attr-defined]
            finally:
                fh.close()  # type: ignore[attr-defined]
        self._rlock.release()

    def __enter__(self) -> Self:
        self.acquire()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()


PHONE_BUSY = PhoneLock(os.path.join(_AGENT_ROOT, 'phone.lock'))


def phone_on_hold() -> bool:
    """PHONE_HOLD 파일이 있으면 True(2026-10-03: 得物 송장 루프가 앱 결제 중인 폰을 가로채 결제가 끊겼다)."""
    return os.path.exists(os.path.join(_AGENT_ROOT, PHONE_HOLD_FILE))


CHANNEL = 'SSG닷컴'
GO_GIFT = '선물 받으러 가기'
CHECK_BTN = '옵션/배송지 확인'
DOOR = '부재 시 문앞에 놓아주세요'
ACCEPT = '선물 받기'
DONE = '선물 받기 완료'
LATER = '다음에 할게요!'
CLOSE_ID = 'com.kakao.talk:id/webview_navi_close_button'
# 알림톡 버튼 글자는 주문 방식에 따라 다르다 — 배송지를 대신 넣은 주문은 '선물 확인하기'로 온다(실기 2026-10-02)
GO_LABELS = (GO_GIFT, '선물 확인하기')
# 비회원 양식(카카오톡 인앱 브라우저)에는 이 동의 칸을 켜야 '선물 받기'가 된다(실기 2026-10-02)
AGREE = '배송에 필요한 개인정보수집에 모두 동의'
# '선물 확인하기'는 SSG 앱으로 열린다 — 아래 메뉴 막대가 버튼을 가린다
SSG_APP = 'kr.co.ssg'
# 화면에 실제로 보이는 세로 범위(720×1600) — 화면 밖 요소는 좌표가 0 이거나 막대 밑이라 눌러도 안 먹는다
SCREEN_TOP = 150
SCREEN_BOTTOM = 1500
# 맨 아래 알림이 다른 주문의 선물이면 그 위 알림을 이만큼까지 본다(앞 주문 수락이 밀려 있을 때)
# 알림을 열어 보는 최대 횟수(한 번에 약 15초)와 위로 스크롤하는 최대 쪽 수
MAX_NOTICES = 12
MAX_PAGES = 8
# 상품명 낱말로 같은 상품인지 볼 때 세지 않는 말
_GENERIC_WORDS = frozenset(
    {'매장정품', '정품', '남성', '여성', '공용', '아동', '키즈', '신발', '의류'}
)


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
            [self.adb, *adb_server_args(), '-s', self.serial, *args],
            capture_output=True,
            timeout=timeout,
            check=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        return done.stdout.decode('utf-8', 'replace')

    def nodes(self) -> list[Node]:
        """지금 화면의 요소들. 덤프가 실패하면(화면 전환 중·보안 창) 지난 파일을 읽지 않고 몇 번 다시 뜬다.

        실기 2026-10-03: 得物이 앞인데 덤프가 실패해 지난 카카오톡 화면 xml 을 읽었고 '검색창을 못 찾았다'로 멈췄다.
        """
        for _ in range(4):
            self._run('shell', 'rm', '-f', '/sdcard/samba_ui.xml')
            out = self._run('shell', 'uiautomator', 'dump', '/sdcard/samba_ui.xml')
            xml = self._run('shell', 'cat', '/sdcard/samba_ui.xml')
            if '<?xml' in xml or '<hierarchy' in xml:
                # 뒤로 간 카카오톡이 덤프를 가로채는 일이 있다(실기 2026-10-03: 홈 화면인데 카카오톡 친구 목록이 읽힘,
                # 다른 앱이 앞에 있어도 계속). 그 패키지를 끝내고 다시 뜬다 — 한 번만
                pkg = re.search(r'package="([\w.]+)"', xml)
                top = self.top_package()
                if (
                    pkg
                    and top
                    and pkg.group(1) == KAKAO != top
                    and not getattr(self, '_kakao_killed', False)
                ):
                    self._kakao_killed = True
                    self._run('shell', 'am', 'force-stop', KAKAO)
                    time.sleep(1.5)
                    continue
                return parse_nodes(xml)
            if 'ERROR' not in out and 'No such file' not in xml:
                break
            time.sleep(1.0)
        return []

    def top_package(self) -> str:
        out = self._run('shell', 'dumpsys', 'activity', 'activities')
        m = re.search(
            r'(?:topResumedActivity|ResumedActivity:?)\s*=?\s*ActivityRecord\{\S+ \S+ ([\w.]+)/',
            out,
        )
        if m:
            return m.group(1)
        # 기록이 비는 순간이 있다(실기 2026-10-03: 카카오톡이 앞인데 '') — 창 포커스로 한 번 더 본다
        win = self._run('shell', 'dumpsys', 'window')
        m = re.search(r'mCurrentFocus=Window\{\S+ \S+ ([\w.]+)/', win)
        return m.group(1) if m else ''

    def tap(self, x: int, y: int) -> None:
        self._run('shell', 'input', 'tap', str(x), str(y))

    def swipe_up(self) -> None:
        self._run('shell', 'input', 'swipe', '360', '1300', '360', '500', '400')

    def input_text(self, text: str) -> None:
        """영문·숫자만(adb input text 는 한글을 못 친다) — 주문번호 검색에 쓴다."""
        self._run('shell', 'input', 'text', text)

    def swipe_down(self) -> None:
        """위로 스크롤(손가락을 아래로) — 채팅방의 오래된 알림을 본다."""
        self._run('shell', 'input', 'swipe', '360', '500', '360', '1300', '400')

    def key(self, code: str) -> None:
        self._run('shell', 'input', 'keyevent', code)

    def wake(self) -> None:
        """화면이 꺼져 있으면 켜고 잠금 화면을 올린다(밀어서 잠금 해제) — 꺼진 채로는 어느 앱도 못 연다.

        실기 2026-10-03: 폰이 Dozing 상태라 카카오톡·得物 화면을 못 읽어 롯데ON 선물 송장·식화 주문이 몇 시간 멈췄다.
        """
        power = self._run('shell', 'dumpsys', 'power')
        if 'mWakefulness=Awake' not in power:
            self.key('224')  # KEYCODE_WAKEUP
            time.sleep(1.5)
            self._run('shell', 'input', 'swipe', '360', '1300', '360', '400', '300')
            time.sleep(1.5)

    def launch(self, package: str) -> None:
        self.wake()
        self._run('shell', 'monkey', '-p', package, '-c', 'android.intent.category.LAUNCHER', '1')


def adb_server_args() -> list[str]:
    """다른 PC 가 중계하는 adb 서버로 보낼 때의 접두 인자(`-H host -P port`).

    환경변수 SAMBA_ADB_SERVER='ip:port' 가 있으면 모든 adb 호출이 그 서버를 쓴다(폰이 다른 PC 에 USB 로 붙어 있을 때,
    앱의 phone/relay.ts 와 같은 길). 없으면 빈 목록(로컬 adb 서버)
    """
    raw = os.environ.get('SAMBA_ADB_SERVER', '').strip()
    m = re.match(r'^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$', raw)
    return ['-H', m.group(1), '-P', m.group(2)] if m else []


def find_phone_serial(adb: str, want: str = DEFAULT_PHONE) -> str | None:
    """연결된 기기 중 결제 폰. 무선(IP:포트·adb-<시리얼>-…)도 시리얼로 찾는다. 없으면 None."""
    try:
        out = subprocess.run(
            [adb, *adb_server_args(), 'devices'],
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
            got = (
                subprocess.run(
                    [adb, *adb_server_args(), '-s', r, 'shell', 'getprop', 'ro.serialno'],
                    capture_output=True,
                    timeout=10,
                    check=False,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                )
                .stdout.decode('utf-8', 'replace')
                .strip()
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        if got == want:
            return r
    return None


class GiftAcceptError(Exception):
    """선물 수락 실패 — 사유는 사람에게 넘길 한 줄(개인정보 없음)."""


def _visible(nodes: list[Node], text: str) -> Node | None:
    """글자가 정확히 같고 화면 안에 보이는 요소. 화면 밖 요소는 덤프에 좌표 0 으로 섞여 나온다."""
    return next((n for n in nodes if n.text == text and SCREEN_TOP < n.y < SCREEN_BOTTOM), None)


def _starts(nodes: list[Node], prefix: str) -> Node | None:
    """글자가 그 말로 시작하는(뒤에 기한 안내가 붙은) 보이는 요소."""
    return next((n for n in nodes if n.text.startswith(prefix) and n.y > 0), None)


def _go_buttons(nodes: list[Node]) -> list[Node]:
    """알림톡의 선물 버튼들 — 아래(최근) 것부터."""
    return sorted((n for n in nodes if n.text in GO_LABELS and n.y > 0), key=lambda n: -n.y)


def same_product(model_code: str, sku: str, texts: list[str]) -> bool:
    """수락 화면의 상품이 이 주문 상품인가. 품번(끝 색상 글자 두 자까지는 없어도 된다) 또는 상품명 낱말 셋 이상.

    실기 2026-10-02: 품번 YMM23342CT 인데 화면은 'YMM23342[다이나핏]…' — 전체 일치만 보면 제 선물도 못 받는다.
    """
    code = model_code.strip().upper()
    words = [
        w
        for w in re.split(r'[^0-9A-Za-z가-힣]+', sku)
        if len(w) >= 2 and not w.isdigit() and w not in _GENERIC_WORDS
    ]
    if not code and not words:
        return True  # 견줄 값이 없다 — 예전처럼 맨 아래 알림을 받는다
    joined = ' '.join(texts).upper()
    if code:
        stem = code[: max(6, len(code) - 2)]
        if code in joined or (len(stem) >= 6 and stem in joined):
            return True
    return sum(1 for w in set(words) if w.upper() in joined) >= 3


def accept_ssg_gift(
    phone: Phone,
    model_code: str,
    *,
    sku: str = '',
    sleep: Callable[[float], None] = time.sleep,
    wait_message_s: float = 180,
) -> str:
    """카카오톡 SSG닷컴 알림톡의 선물을 받는다. 성공하면 결과 한 줄, 실패하면 GiftAcceptError.

    model_code·sku 가 있으면 수락 화면의 상품이 그 주문 상품일 때만 받는다(다른 주문의 선물을 받지 않게).
    맨 아래 알림이 다른 상품이면 그 위 알림을 차례로 본다.
    """

    def wait_for(
        check: Callable[[list[Node]], bool], seconds: float, step: float = 2
    ) -> list[Node]:
        end = time.monotonic() + seconds
        nodes = phone.nodes()
        while not check(nodes) and time.monotonic() < end:
            sleep(step)
            nodes = phone.nodes()
        return nodes

    # 1) 카카오톡 채팅 목록에서 SSG닷컴 방 — 앱이 다른 방·브라우저에 있으면 뒤로 가며 목록을 찾는다
    phone.launch(KAKAO)
    sleep(3)
    # 카카오톡은 새로 뜰 때 채팅 목록이 나오기까지 10~20초 걸린다(하얀·회색 빈 화면) — 그 사이 뒤로가기를 누르면
    # 앱을 나가 버려 "SSG닷컴 방을 못 찾았다"가 된다(실기 2026-10-06). 목록·선물 버튼이 보일 때까지 기다린다
    nodes = wait_for(lambda ns: bool(_go_buttons(ns)) or find_text(ns, CHANNEL) is not None, 30)
    for _ in range(4):
        if _go_buttons(nodes) or find_text(nodes, CHANNEL):
            break
        phone.key('4')  # BACK
        sleep(1.5)
        nodes = phone.nodes()
    if not _go_buttons(nodes):
        room = find_text(nodes, CHANNEL)
        if room is None:
            raise GiftAcceptError('카카오톡 채팅 목록에서 SSG닷컴 방을 못 찾았다')
        phone.tap(room.x, room.y)
        sleep(3)
    # 2) 결제 직후엔 알림톡이 늦게 온다 — 맨 아래 선물 버튼이 생길 때까지 기다린다
    nodes = wait_for(lambda ns: bool(_go_buttons(ns)), wait_message_s, step=10)
    if not _go_buttons(nodes):
        raise GiftAcceptError(
            f'SSG닷컴 알림톡에 "{GO_GIFT}" 버튼이 {int(wait_message_s)}초 안에 안 왔다'
        )
    wanted = model_code or '이 주문'
    # 이 주문의 알림이 맨 아래가 아닐 수 있다(앞선 주문 알림이 쌓임, 실기 2026-10-06) — 한 화면의 알림을 아래부터 보고,
    # 다 봤으면 위로 스크롤해 더 오래된 알림을 본다. 방을 다시 열면 맨 아래라서 본 만큼(pages) 다시 올라간다
    pages = 0
    idx = 0
    tried = 0

    def reopen_room() -> list[Node]:
        phone.launch(KAKAO)
        sleep(2)
        ns = wait_for(lambda x: bool(_go_buttons(x)), 25)
        for _ in range(pages):
            phone.swipe_down()
            sleep(1.2)
        return phone.nodes() if pages else ns

    while True:
        gos = _go_buttons(nodes)
        if idx >= len(gos):
            pages += 1
            if pages > MAX_PAGES or tried >= MAX_NOTICES:
                _close_browser(phone, sleep)
                raise GiftAcceptError(
                    f'알림 {tried}건을 봤지만 이 주문({wanted})의 선물을 못 찾았다'
                )
            phone.swipe_down()
            sleep(1.2)
            nodes = phone.nodes()
            idx = 0
            continue
        tried += 1
        if tried > MAX_NOTICES:
            _close_browser(phone, sleep)
            raise GiftAcceptError(
                f'알림 {MAX_NOTICES}건을 봤지만 이 주문({wanted})의 선물을 못 찾았다'
            )
        phone.tap(gos[idx].x, gos[idx].y)
        idx += 1
        # 3) 선물받기 화면 → 옵션/배송지 확인(글자 뒤에 '10/9(금) 23:59까지 …' 기한이 붙는다)
        nodes = wait_for(lambda ns: _starts(ns, CHECK_BTN) is not None or has_text(ns, DONE), 40)
        if has_text(nodes, DONE):
            # 완료 화면은 그 알림의 상품이 이 주문일 때만 이 주문의 성공이다 — 맨 아래 알림(다른 주문)이 이미
            # 받아진 것을 이 주문 성공으로 돌려줘 미수락 주문이 성공으로 기록됐다(실기 2026-10-06)
            if same_product(model_code, sku, [n.text for n in nodes]):
                _close_browser(phone, sleep)
                return '이미 받은 선물(완료 화면) — 브라우저 닫음'
            _close_browser(phone, sleep, home=False)
            nodes = reopen_room()
            continue
        check_btn = _starts(nodes, CHECK_BTN)
        if check_btn is None:
            raise GiftAcceptError(
                '선물받기 화면에서 "옵션/배송지 확인"이 안 보인다(인앱 브라우저 로딩 멈춤일 수 있다)'
            )
        if check_btn.y > SCREEN_BOTTOM - 100 and phone.top_package() == SSG_APP:
            # SSG 앱은 아래 메뉴 막대가 버튼을 가린다 — 조금 올려서 누른다
            phone.swipe_up()
            sleep(1.5)
            check_btn = _starts(phone.nodes(), CHECK_BTN) or check_btn
        phone.tap(check_btn.x, check_btn.y)
        nodes = wait_for(lambda ns: has_text(ns, '배송지'), 20)
        if same_product(model_code, sku, [n.text for n in nodes]):
            break
        # 다른 주문의 선물이다 — 받지 않고 닫은 뒤 방으로 돌아가 그 위 알림을 본다
        _close_browser(phone, sleep, home=False)
        nodes = reopen_room()
    if not same_product(model_code, sku, [n.text for n in nodes]):
        _close_browser(phone, sleep)
        raise GiftAcceptError(f'수락 화면 상품이 이 주문({wanted})이 아니다 — 받지 않고 닫음')
    # 4) 배송 요청사항 '부재 시 문앞에 놓아주세요' — 기본값은 경비실이라 반드시 바꾼다(사용자 2026-09-29).
    # 화면에 실제로 보일 때만 누른다 — 화면 밖 요소는 좌표가 0 이라 눌러도 안 먹는다(실기 2026-10-02)
    for _ in range(6):
        if _visible(nodes, DOOR) and _visible(nodes, ACCEPT):
            break
        phone.swipe_up()
        sleep(1.5)
        nodes = phone.nodes()
    door = _visible(nodes, DOOR)
    accept = _visible(nodes, ACCEPT)
    if door is None or accept is None:
        raise GiftAcceptError('배송 요청사항(문앞)·"선물 받기" 버튼을 못 찾았다')
    phone.tap(door.x, door.y)  # 글자 줄 전체가 라디오 버튼 영역이다
    sleep(1)
    agree = _visible(nodes, AGREE)
    if agree is not None:
        # 비회원 양식 — 배송 개인정보수집 동의를 켜야 받아진다
        phone.tap(agree.x, agree.y)
        sleep(1)
    phone.tap(accept.x, accept.y)
    nodes = wait_for(lambda ns: has_text(ns, DONE), 25)
    if not has_text(nodes, DONE):
        raise GiftAcceptError('"선물 받기"를 눌렀지만 완료 화면이 안 떴다 — 사람이 확인')
    # 5) 리뷰 팝업 닫고 인앱 브라우저 X — 다음 결제가 이 화면에 막히지 않게
    later = next((n for n in nodes if n.text == LATER and n.y > 0), None)
    if later is not None:
        phone.tap(later.x, later.y)
        sleep(1.5)
    _close_browser(phone, sleep)
    return '선물 받기 완료(부재 시 문앞) — 브라우저 닫음'


def _close_browser(phone: Phone, sleep: Callable[[float], None], *, home: bool = True) -> None:
    """카카오톡 인앱 브라우저를 X 로 닫고 홈으로 나간다(home=False 면 채팅방에 남는다)."""
    for _ in range(3):
        close = next((n for n in phone.nodes() if n.rid == CLOSE_ID), None)
        if close is None:
            break
        phone.tap(close.x, close.y)
        sleep(1.5)
    if home:
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


def source_order_no_of(out: dict) -> str:
    """결제 단계가 기록한 SSG 주문번호(source_order_no). 없으면 ''."""
    for _name, r in (out.get('results') or {}).items():
        payload = getattr(r, 'payload', None) if not isinstance(r, dict) else r.get('payload')
        if isinstance(payload, dict) and payload.get('source_order_no'):
            return str(payload['source_order_no'])
    return ''


def wait_foreground(
    phone: 'Phone', package: str, seconds: float = 25.0, sleep: Callable[[float], None] = time.sleep
) -> bool:
    """그 앱이 앞으로 나올 때까지 기다린다(콜드 스타트 5~20초). 나왔으면 True.

    앱을 열자마자 화면 글자를 읽으면 아직 앞에 있는 홈 화면(런처)의 앱 이름들을 읽고 '화면이 떴다'로 착각해
    카카오톡 방을 못 열었다고 끝났다(실기 2026-10-08: 롯데ON 선물 송장·SSG 선물 수락이 반나절 같은 사유로 멈춤).
    """
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if phone.top_package() == package:
            sleep(1.5)  # 첫 화면이 그려질 때까지 조금 더
            return True
        sleep(1.0)
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
        line = _after(job, out)
        if line:
            # 결과가 슬랙에만 가서 수락 실패가 로그에 안 보였다(실기 2026-10-02: 2건이 주문접수로 남음)
            log.warning('선물 수락: %s', line) if '실패' in line or '못 함' in line else log.info(
                '선물 수락: %s', line
            )
        return line

    def _after(job: object, out: dict) -> str | None:
        source, sku = source_of_job(job)
        if source.upper() != 'SSG' or not gift_order_of(out):
            return None
        serial = find_phone_serial(adb_path, want)
        if serial is None:
            return 'SSG 선물 수락 못 함 — 결제 폰이 연결돼 있지 않다(카카오톡에서 직접 수락 필요, 기한 1주일)'
        phone = Phone(adb_path, serial)
        # 득물 구매·롯데ON 선물 송장과 폰 화면을 두고 부딪치지 않게 자물쇠를 잡고 한다
        with PHONE_BUSY:
            try:
                # 주문번호로 카톡 검색해 받는다(스크롤 탐색은 알림이 쌓이면 못 찾는다) — 번호를 모르거나 실패하면 옛 방식으로
                order_no = source_order_no_of(out)
                if order_no:
                    from samba_agent.ops.ssg_gift_search import accept_ssg_gift_by_search

                    try:
                        return 'SSG ' + accept_ssg_gift_by_search(phone, order_no)
                    except GiftAcceptError as e:
                        log.warning('선물 수락(카톡 검색) 실패 — 옛 방식으로 다시: %s', e)
                return 'SSG ' + accept_ssg_gift(phone, model_code_of(sku) or '', sku=sku)
            except GiftAcceptError as e:
                return f'SSG 선물 수락 실패 — {e}(카카오톡에서 직접 수락 필요)'
            except (OSError, subprocess.TimeoutExpired) as e:
                return f'SSG 선물 수락 실패 — 폰 명령 오류 {type(e).__name__}(카카오톡에서 직접 수락 필요)'

    return after
