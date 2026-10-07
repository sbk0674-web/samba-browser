"""가격X·재고X 표시 — 토글 버튼이라 이미 붙어 있으면 누르지 않고, 누른 뒤 태그로 확인한다."""

from samba_agent.wave.client import (
    WaveOrderDetail,
    infer_lotteon_prefix,
    infer_musinsa_product_id,
    infer_source,
)
from samba_agent.wave.flags import FlagMarker, flag_for


class _Wave:
    def __init__(self, tags: list[str], changed: bool = True) -> None:
        self.tags = tags
        self.changed = changed
        self.calls: list[tuple[str, str, str | None]] = []

    def get_order(self, order_no: str) -> WaveOrderDetail:
        return WaveOrderDetail(order_number=order_no, action_tag=','.join(self.tags))

    def set_cancel_requested(self, order_no: str, reason: str, flag: str | None = None) -> bool:
        self.calls.append((order_no, reason, flag))
        if flag and flag not in self.tags:
            self.tags.append(flag)
        return self.changed


def test_실패_사유별_표시():
    assert flag_for('margin') == ('no_price', '가격X')
    assert flag_for('out_of_stock') == ('no_stock', '재고X')
    assert flag_for('unknown') is None
    assert flag_for(None) is None


def test_가격X_태그와_취소요청을_API_로_한_번에():
    wave = _Wave(['kkadaegi'])
    out = FlagMarker(wave).mark('A1', 'margin')  # type: ignore[arg-type]
    assert out == '가격X 표시함 · 취소요청으로 바꿈'
    assert wave.calls == [('A1', 'margin', 'no_price')]


def test_이미_취소요청이면_그대로_알린다():
    wave = _Wave(['no_stock'], changed=False)
    assert FlagMarker(wave).mark('A1', 'out_of_stock') == '재고X 표시함 · 이미 취소요청'  # type: ignore[arg-type]


def test_해당_없는_사유는_아무것도_안_한다():
    wave = _Wave([])
    assert FlagMarker(wave).mark('A1', 'captcha') is None  # type: ignore[arg-type]
    assert wave.calls == []


def test_상품명_끝_숫자로_무신사_상품번호를_추정한다():
    """소싱처 미등록 주문(사용자 2026-09-25) — 10자리 품번은 건너뛰고 마지막 5~8자리 숫자."""
    assert (
        infer_musinsa_product_id('매장정품 르무통 LEMOUTON 5009530519 메이트 오렌지 3347853')
        == '3347853'
    )
    assert infer_musinsa_product_id('남자데님팬츠 05415547 와이드 쿨 데님 415547 3colo') == '415547'
    assert infer_musinsa_product_id('나이키 에어포스') is None
    o = WaveOrderDetail(order_number='N', source_site='', product_name='르무통 메이트 블랙 3347848')
    assert (o.source_site, o.source_url, o.source_inferred) == (
        'MUSINSA',
        'https://www.musinsa.com/products/3347848',
        True,
    )
    kept = WaveOrderDetail(order_number='K', source_site='29CM', product_name='티셔츠 1234567')
    assert (kept.source_site, kept.source_inferred) == ('29CM', False)


def test_상품명_끝_번호로_소싱처를_가른다():
    """LE+10자리 롯데온 · 10자리 ABC마트 · 5~8자리 무신사 — 마지막 번호로 정한다(사용자 2026-09-25)."""
    assert infer_source(
        '나이키 DV5456 300 코트 버로우 로우 리크래프트 보이그레이드 통기성 커플샌들 1010109335'
    ) == (
        'ABCmart',
        '1010109335',
    )
    assert infer_source(
        '노스페이스 NP6KP12B 남성 MA 트레이닝 팬츠 카고팬츠 레귤러핏 LE1215528857'
    ) == (
        'LOTTEON',
        'LE1215528857',
    )
    assert infer_source('르무통 LEMOUTON 5009530519 메이트 오렌지 3347853') == (
        'MUSINSA',
        '3347853',
    )
    assert infer_source('티셔츠 123456789') == ('FashionPlus', '123456789')  # 9자리는 패션플러스
    assert infer_source('수영복 A4FL1LH08 1000618616029') == (
        'SSG',
        '1000618616029',
    )  # 13자리(1000…)는 SSG
    assert infer_source('티셔츠 12345678901') is None  # 11자리는 모른다
    o = WaveOrderDetail(order_number='L', source_site='', product_name='팬츠 LE1215528857')
    assert (o.source_site, o.source_url, o.inferred_product_id) == (
        'LOTTEON',
        'https://www.lotteon.com/p/product/LE1215528857',
        'LE1215528857',
    )


def test_상품명이_잘려_롯데온_번호_뒷자리가_없으면_접두어만_둔다():
    """실기 2026-10-07 현대H몰 '… 여자로퍼 LE122077228' → 수집상품 LE1220772281. 소싱처는 추정하지 않는다."""
    assert (
        infer_lotteon_prefix('스케쳐스 여성 클레오 플렉스 웨지 여성플랫슈즈 여자로퍼 LE122077228')
        == 'LE122077228'
    )
    assert infer_lotteon_prefix('나이키 러닝 탑 LE12203144') == 'LE12203144'
    assert infer_lotteon_prefix('팬츠 LE1215528857') is None  # 온전한 번호는 추정 쪽
    assert infer_lotteon_prefix('LE122077228 차콜') is None  # 끝이 아니면 잘린 것이 아니다
    assert infer_lotteon_prefix('티셔츠 LE12345') is None  # 너무 짧다
    o = WaveOrderDetail(order_number='H', source_site='', product_name='여자로퍼 LE122077228')
    assert (o.source_site, o.source_inferred, o.inferred_product_prefix) == (
        '',
        False,
        'LE122077228',
    )
    kept = WaveOrderDetail(order_number='K', source_site='SSG', product_name='여자로퍼 LE122077228')
    assert kept.inferred_product_prefix is None
