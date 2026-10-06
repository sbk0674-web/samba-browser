"""롯데ON 선물 송장 — 카카오톡 알림 읽기·짝짓기·삼바 기입."""

from pathlib import Path

from samba_agent.ops.lotteon_gift_tracking import (
    GiftNotice,
    SeenStore,
    collect_lotteon_gift_tracking,
    name_key,
    pair_order_no,
    parse_notice,
    product_codes,
    read_notices,
)
from samba_agent.ops.ssg_gift_accept import Node

TRACK = (
    '[롯데ON] 김보냄님의 선물 배송시작 안내\n\n안녕하세요, 이받음님!\n김보냄님께 선물하신 상품의 배송이 시작되었습니다.\n\n'
    '▶ 상품명 : 제트 런 자켓 NJ3LS06J_BLK\n▶ 택배사 : 롯데택배\n▶ 송장번호 : 318400001111'
)
ORDER = (
    '[롯데ON] 선물 배송시작 안내\n\n안녕하세요, 김보냄님\n이받음님께 선물하신 상품의 배송이 시작되었습니다.\n\n'
    '▶ 상품명 : 제트 런 자켓 NJ3LS06J_BLK\n▶ 주문번호 : 2026100217236193\n▶ 주문일자 : 2026-10-01 11\n\n배송시작 당일은 …'
)
DONE = TRACK.replace('배송시작 안내', '배송완료 안내').replace('시작되었습니다', '완료되었습니다')


def test_송장_알림과_주문번호_알림을_읽는다():
    assert parse_notice(TRACK) == GiftNotice(
        '이받음', '제트 런 자켓 NJ3LS06J_BLK', '롯데택배', '318400001111'
    )
    assert parse_notice(ORDER) == GiftNotice(
        '이받음', '제트 런 자켓 NJ3LS06J_BLK', order_no='2026100217236193'
    )
    assert parse_notice(DONE).number == '318400001111'


def test_다른_알림은_넘긴다():
    assert (
        parse_notice('[롯데ON] 선물 주문완료 안내\n▶ 상품명 : 가\n▶ 주문번호 : 2026100217236193')
        is None
    )
    assert (
        parse_notice(
            '[롯데ON] 배송시작 안내\n▶ 상품명 : 러닝 글러브 IK4838\n▶ 주문번호 : 2026100217236193'
        )
        is None
    )
    assert parse_notice('[SSG] 선물 배송시작 안내') is None


def test_받는_사람과_상품이_같은_짝에서만_주문번호를_얻는다():
    track, order = parse_notice(TRACK), parse_notice(ORDER)
    assert pair_order_no(track, [track, order]) == '2026100217236193'
    # 같은 상품을 산 다른 고객의 알림은 짝이 아니다
    other = GiftNotice('박다른', order.product, order_no='2026100299999999')
    assert pair_order_no(track, [track, other]) == ''
    # 같은 사람이 같은 상품을 두 번 샀으면 어느 주문인지 모른다
    again = GiftNotice('이받음', order.product, order_no='2026100288888888')
    assert pair_order_no(track, [track, order, again]) == ''
    assert name_key('홍*동') == name_key('홍O동')


class _Phone:
    """한 쪽에 알림 글들을 보여 주고, 끌면 다음 쪽으로 넘어가는 가짜 폰."""

    def __init__(self, pages: list[list[str]]) -> None:
        self.pages = pages
        self.at = -1  # -1 = 채팅 목록

    def launch(self, package: str) -> None:
        pass

    def top_package(self) -> str:
        return 'com.kakao.talk'

    def nodes(self) -> list[Node]:
        if self.at < 0:
            return [Node('롯데ON', '', '', 100, 600)]
        page = self.pages[min(self.at, len(self.pages) - 1)]
        return [Node(t, '', '', 300, 400 + i * 300) for i, t in enumerate(page)]

    def tap(self, x: int, y: int) -> None:
        self.at = 0

    def key(self, code: str) -> None:
        pass

    def _run(self, *args: str) -> str:
        self.at += 1
        return ''


class _Wave:
    def __init__(self, action: str = 'shipped') -> None:
        self.calls: list[dict[str, object]] = []
        self.action = action

    def write_lotteon_gift_tracking(self, **kw: object) -> dict[str, object]:
        self.calls.append(kw)
        ok = self.action != 'skipped'
        return {
            'ok': ok,
            'action': self.action,
            'reason': '주문번호',
            'order_number': '737',
            'market_sent': True,
        }


def test_새_송장만_한_번_넣는다(tmp_path: Path):
    phone, wave = _Phone([[DONE], [ORDER, TRACK]]), _Wave()
    seen = SeenStore(tmp_path / 'seen.json')
    res = collect_lotteon_gift_tracking(wave, phone, seen, sleep=lambda s: None)
    # 배송시작·배송완료가 같은 송장을 두 번 알려도 한 번만 보낸다
    assert res == {'read': 1, 'sent': 1, 'skipped': 0}
    assert (
        wave.calls[0]['number'] == '318400001111'
        and wave.calls[0]['sourcing_order_number'] == '2026100217236193'
    )
    assert wave.calls[0]['company'] == '롯데택배' and wave.calls[0]['customer_name'] == '이받음'
    # 다음 바퀴 — 기억이 파일에 남아 다시 보내지 않는다
    again = collect_lotteon_gift_tracking(
        wave,
        _Phone([[DONE], [ORDER, TRACK]]),
        SeenStore(tmp_path / 'seen.json'),
        sleep=lambda s: None,
    )
    assert again == {'read': 1, 'sent': 0, 'skipped': 0} and len(wave.calls) == 1


def test_안_맞는_송장은_몇_번만_다시_보낸다(tmp_path: Path):
    wave = _Wave('skipped')
    for _ in range(5):
        collect_lotteon_gift_tracking(
            wave, _Phone([[TRACK]]), SeenStore(tmp_path / 'seen.json'), sleep=lambda s: None
        )
    assert len(wave.calls) == 3


def test_시험_실행은_기억하지_않는다(tmp_path: Path):
    wave = _Wave('dry_run')
    collect_lotteon_gift_tracking(
        wave,
        _Phone([[TRACK]]),
        SeenStore(tmp_path / 'seen.json'),
        dry_run=True,
        sleep=lambda s: None,
    )
    assert wave.calls[0]['dry_run'] is True and not (tmp_path / 'seen.json').exists()


def test_주문_작업이_시작되면_손을_뗀다(tmp_path: Path):
    wave = _Wave()
    res = collect_lotteon_gift_tracking(
        wave,
        _Phone([[TRACK]]),
        SeenStore(tmp_path / 'seen.json'),
        idle=lambda: False,
        sleep=lambda s: None,
    )
    assert res is None and wave.calls == []


class _DeepLinkedPhone(_Phone):
    """방이 카카오톡의 맨 밑 화면인 폰 — 뒤로 가면 카카오톡이 닫히고, 다시 열면 그 방이 뜬다."""

    def __init__(self, pages: list[list[str]]) -> None:
        super().__init__(pages)
        self.at = 0
        self.top = 'com.kakao.talk'

    def launch(self, package: str) -> None:
        self.top, self.at = package, 0

    def top_package(self) -> str:
        return self.top

    def key(self, code: str) -> None:
        if code == '4':
            self.top = 'com.sec.android.app.launcher'


def test_방이_맨_밑_화면이어도_연다(tmp_path: Path):
    wave = _Wave()
    res = collect_lotteon_gift_tracking(
        wave,
        _DeepLinkedPhone([[ORDER, TRACK]]),
        SeenStore(tmp_path / 'seen.json'),
        sleep=lambda s: None,
    )
    assert res == {'read': 1, 'sent': 1, 'skipped': 0}


class _SearchPhone(_Phone):
    """대화내용 검색이 있는 가짜 폰 — '위로' 를 누를 때마다 옛 알림 하나가 더 보인다."""

    def __init__(self, pages: list[list[str]]) -> None:
        super().__init__(pages)
        self.searching = False
        self.typed: list[str] = []

    def nodes(self) -> list[Node]:
        base = super().nodes()
        if self.at < 0:
            return base
        if not self.searching:
            return [Node('', '검색', '', 589, 104), *base]
        return [
            Node('대화내용 검색', '', 'com.kakao.talk:id/edit_text', 396, 104),
            *base,
            Node('', '위로', '', 576, 864),
        ]

    def tap(self, x: int, y: int) -> None:
        if self.at < 0:
            self.at = 0
        elif (x, y) == (589, 104):
            self.searching = True
        elif (x, y) == (576, 864):
            self.at += 1

    def _run(self, *args: str) -> str:
        if args[:3] == ('shell', 'input', 'text'):
            self.typed.append(args[3])
        return ''


def test_검색으로_알림을_하나씩_거슬러_읽고_아는_것만_이어지면_멈춘다(tmp_path: Path):
    phone = _SearchPhone([[TRACK], [ORDER], *([[TRACK]] * 20)])
    out = read_notices(phone, known=lambda n: True, sleep=lambda s: None)
    assert phone.typed == ['ON']
    assert out is not None and len(out) == 2 and out[0].number
    # 끌기(swipe)는 쓰지 않았고, 아는 송장만 이어져 몇 걸음 만에 멈췄다
    assert phone.at < 10


class _SearchByOrderPhone(_SearchPhone):
    """주문번호를 치면 그 알림 짝(주문번호 알림 + 송장 알림)이 보이는 가짜 폰."""

    def __init__(self, hits: dict[str, list[str]]) -> None:
        super().__init__([[]])
        self.hits = hits
        self.query = ''

    def nodes(self) -> list[Node]:
        if self.at < 0:
            return [Node('롯데ON', '', '', 100, 600)]
        texts = self.hits.get(self.query, []) if self.searching and self.query else []
        rows = [Node(t, '', '', 300, 400 + i * 300) for i, t in enumerate(texts)]
        if not self.searching:
            return [Node('[롯데ON] 아무 알림', '', '', 300, 500), Node('', '검색', '', 589, 104)]
        return [
            Node('대화내용 검색', '', 'com.kakao.talk:id/edit_text', 396, 104),
            *rows,
            Node('', '위로', '', 576, 864),
        ]

    def _run(self, *args: str) -> str:
        if args[:3] == ('shell', 'input', 'text'):
            self.query = args[3]
            self.typed.append(args[3])
        return ''

    def key(self, code: str) -> None:
        if code == '4':
            self.searching, self.query = False, ''


class _ListingWave(_Wave):
    def __init__(self, rows: list[dict[str, object]]) -> None:
        super().__init__()
        self.rows = rows

    def list_lotteon_gift_pending(self) -> list[dict[str, object]]:
        return self.rows


def test_송장_없는_주문마다_주문번호로_검색해_송장을_넣는다(tmp_path: Path):
    order_no = ORDER.split('주문번호 : ')[1].split()[0]
    wave = _ListingWave(
        [
            {'order_number': '737', 'sourcing_order_number': order_no},
            {'order_number': '738', 'sourcing_order_number': '2026100100000001'},
        ]
    )
    phone = _SearchByOrderPhone({order_no: [ORDER, TRACK]})
    res = collect_lotteon_gift_tracking(
        wave, phone, SeenStore(tmp_path / 'seen.json'), sleep=lambda s: None
    )
    assert phone.typed == [order_no, '2026100100000001']
    assert res == {'read': 1, 'sent': 1, 'skipped': 0}
    assert wave.calls[0]['sourcing_order_number'] == order_no


def test_품번_후보는_영숫자_섞인_토막만():
    assert product_codes('스케쳐스 남성 아치 핏 모틀리 슬립인스 SC0MFCEY061_I') == ['SC0MFCEY061']
    assert product_codes('제트 런 자켓 NJ3LS06J_BLK 2026') == ['NJ3LS06J']


def test_주문번호_옆에_송장이_없으면_품번으로_다시_찾는다(tmp_path: Path):
    order_no = ORDER.split('주문번호 : ')[1].split()[0]
    wave = _ListingWave(
        [
            {
                'order_number': '737',
                'sourcing_order_number': order_no,
                'product_name': '제트 런 자켓 NJ3LS06J_BLK',
            }
        ]
    )
    phone = _SearchByOrderPhone({order_no: [ORDER], 'NJ3LS06J': [TRACK]})
    res = collect_lotteon_gift_tracking(
        wave, phone, SeenStore(tmp_path / 'seen.json'), sleep=lambda s: None
    )
    assert phone.typed == [order_no, 'NJ3LS06J']
    assert res == {'read': 1, 'sent': 1, 'skipped': 0}
    assert wave.calls[0]['sourcing_order_number'] == order_no
