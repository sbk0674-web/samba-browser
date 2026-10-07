"""소싱처 주문 대조 — 삼바 기록에 없는 소싱 주문·받는 곳 불일치."""

from datetime import datetime, timedelta, timezone

from samba_agent.ops.source_audit import (
    SourceAudit,
    SourceDetail,
    delivery_mismatch,
    is_ignorable,
    ordered_at,
    parse_detail,
)

KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 9, 30, 12, 0, 0, tzinfo=KST)


def _audit(numbers: dict[str, list[str]], details: dict[str, SourceDetail], known: set[str] | None, alerts: list[str]):
    opened: list[str] = []

    def detail(account: str, no: str) -> SourceDetail | None:
        opened.append(no)
        return details.get(no)

    audit = SourceAudit(
        accounts=lambda: list(numbers),
        list_orders=lambda account: numbers[account],
        detail=detail,
        known_numbers=lambda: known,
        alert=alerts.append,
        now=lambda: NOW,
    )
    return audit, opened


def test_주문번호에서_결제_시각을_읽는다():
    assert ordered_at('202609301104250002') == datetime(2026, 9, 30, 11, 4, 25, tzinfo=KST)
    assert ordered_at('2026093016600508') is None


def test_삼바에_없는_살아_있는_주문만_한_번_알린다():
    alerts: list[str] = []
    numbers = {'edelvise06': ['202609301113310001', '202609301104250002', '202609300900000001', '202609300800000002']}
    details = {
        # 같은 판매 주문을 두 번 산 것 — 첫 결제가 삼바에 없다
        '202609301104250002': SourceDetail('상품 준비 중', '크록스키즈 지비츠', False),
        '202609300900000001': SourceDetail('취소 완료', '노스페이스 햇', False),
        '202609300800000002': SourceDetail('사용 완료', '무신사머니 50만원 상품권', False),
    }
    audit, opened = _audit(numbers, details, {'202609301113310001'}, alerts)
    told = audit.run_once()
    assert len(told) == 1 and '202609301104250002' in told[0] and '크록스키즈' in told[0]
    assert alerts == told
    # 삼바에 있는 주문은 열어 보지 않는다
    assert '202609301113310001' not in opened
    # 다시 돌려도 같은 주문을 또 알리거나 또 열지 않는다
    assert audit.run_once() == [] and len(opened) == 3


def test_방금_결제한_주문과_옛_주문은_알리지_않는다():
    alerts: list[str] = []
    numbers = {'a': ['202609301155000001', '202609271200000001']}
    details = {n: SourceDetail('결제 완료', '상품', False) for n in numbers['a']}
    audit, opened = _audit(numbers, details, set(), alerts)
    assert audit.run_once() == []
    # 방금(5분 전) 결제한 주문은 기입을 기다린다 — 열어 보지도 않는다. 사흘 전 주문은 범위 밖이다
    assert opened == []


def test_삼바_기록을_못_읽으면_아무것도_알리지_않는다():
    alerts: list[str] = []
    audit, opened = _audit({'a': ['202609301104250002']}, {}, None, alerts)
    assert audit.run_once() == [] and opened == [] and alerts == []


def test_주문_작업이_시작되면_멈춘다():
    alerts: list[str] = []
    numbers = {'a': ['202609301104250002'], 'b': ['202609301004250002']}
    details = {n: SourceDetail('결제 완료', '상품', False) for ns in numbers.values() for n in ns}
    audit, opened = _audit(numbers, details, set(), alerts)
    assert audit.run_once(idle=lambda: False) == [] and opened == []


def test_주문_상세에서_상태와_상품_사무실_여부를_읽는다():
    out = {
        'found': True,
        'head': '주문번호 202609301104250002 김사무 경북 경주시 사무실길 58 1층 102호 <전화>',
        'body': '주문 상품 1개 배송중 10.02(금) 이내 도착 예정 크록스키즈 판매자 정보 지비츠 스파이더 맨 5 SET 23SF10010007 / 1개 8,450원',
    }
    d = parse_detail(out, '사무실길 58')
    assert d == SourceDetail('배송중', '지비츠 스파이더 맨 5 SET 23SF10010007', True)
    assert parse_detail({'found': False}, '사무실길 58') is None
    assert parse_detail({**out, 'head': '주문번호 … 제주특별자치도 제주시 …'}, '사무실길 58').to_office is False


def test_취소와_상품권은_넘긴다():
    assert is_ignorable(SourceDetail('취소 완료', '상품', False))
    assert is_ignorable(SourceDetail('사용 완료', '무신사머니 50만원 상품권', False))
    assert not is_ignorable(SourceDetail('취소 요청', '상품', False))
    assert not is_ignorable(SourceDetail('반품 요청', '상품', False))


def test_받는_곳이_기록과_다르면_알릴_글을_준다():
    assert delivery_mismatch(('direct',), True) == '직배로 기록됐는데 소싱처 주문은 사무실로 간다'
    assert delivery_mismatch(('kkadaegi', 'staff_a'), False) == '까대기로 기록됐는데 소싱처 주문은 사무실이 아닌 곳으로 간다'
    assert delivery_mismatch(('direct',), False) is None
    assert delivery_mismatch(('kkadaegi',), True) is None
    # 선물은 소싱처 주문에 고객 주소가 없다 — 보지 않는다
    assert delivery_mismatch(('direct', 'gift'), True) is None
    assert delivery_mismatch((), True) is None
