# 소싱처 표 — 이름 정규화 · 스크립트 이름 · 등록부 생성 · 스크립트 미작성 소싱처
import pytest

from samba_agent.agents.buyer import ScriptsPendingBuyer, snapshot_args, source_of
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.factory import build_agents
from samba_agent.agents.payer import DEFAULT_CHECKOUT_SCRIPT, checkout_script_for
from samba_agent.agents.registry import DEFAULT_BUYER_RULES, Registry
from samba_agent.bridge.client import BridgeClient
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.sources import Sources

URL = 'http://127.0.0.1:47811'


@pytest.fixture()
def sources() -> Sources:
    return Sources.load(DEFAULT_ROOT)


@pytest.fixture()
def reg() -> Registry:
    return Registry.load(DEFAULT_ROOT)


def _order(source: str, **kw: object) -> OrderRef:
    row = {'order_no': 'A1', 'source': source, 'seller': '포이즌', 'sku': 'SKU-1', 'qty': 1}
    return OrderRef.model_validate(row | kw)


def test_한글이름_id_key_아무거나로_같은_행을_찾는다(sources):
    for name in ('무신사', 'MUSINSA', 'musinsa', ' Musinsa '):
        assert sources.by_id(name).id == 'MUSINSA'
    assert sources.by_id('ABC마트').key == 'abc'
    assert sources.by_id('쿠팡') is None
    assert sources.by_id(None) is None


def test_소싱처_이름을_삼바웨이브_id_로_맞춘다(sources):
    assert sources.normalize('ABC마트') == 'ABCmart'
    assert sources.normalize('29CM') == '29CM'
    # 표에 없는 이름은 그대로 둔다 — 감독자가 unsupported 로 사람에게 넘긴다
    assert sources.normalize('쿠팡') == '쿠팡'


def test_스크립트_이름은_key_에서_나온다(sources):
    musinsa = sources.by_id('무신사')
    assert musinsa.snapshot_script == 'musinsa_product_snapshot'
    assert musinsa.set_shipping_script == 'musinsa_set_shipping'
    assert musinsa.checkout_script_name == 'checkout_enter_musinsa'
    # 29CM 만 앱에 저장된 이름이 규칙과 다르다(checkout_enter_cm29 가 아니다)
    assert sources.by_id('29CM').checkout_script_name == 'checkout_enter_29cm'
    assert sources.by_id('29CM').snapshot_script == 'cm29_product_snapshot'


def test_결제창_진입_스크립트는_한글이름도_받는다():
    assert checkout_script_for('ABC마트') == 'checkout_enter_abc'
    assert checkout_script_for('ABCmart') == 'checkout_enter_abc'
    assert checkout_script_for('쿠팡') == DEFAULT_CHECKOUT_SCRIPT


def test_등록부는_소싱처_표에서_구매_에이전트를_만든다(reg):
    names = reg.names()
    assert 'buyer.musinsa' in names
    assert 'buyer.cm29' in names
    assert reg['buyer.cm29'].match == {'source': '29CM'}
    assert reg['buyer.cm29'].dataset == 'ds.buyer.cm29'
    assert reg['buyer.cm29'].prompts == 'samba/buyer-cm29'
    assert reg['buyer.cm29'].retry == 1
    assert 'run_script' in reg['buyer.cm29'].tools


def test_보류_소싱처는_등록하지_않는다(reg, sources):
    assert sources.by_id('KREAM').status == 'hold'
    assert 'buyer.kream' not in reg.names()
    assert reg.pick('buyer', _order('KREAM'), {}) is None


def test_규칙_파일이_없으면_공통_규칙으로_떨어진다(reg):
    assert reg['buyer.musinsa'].rules == 'rules/buyer_musinsa.md'
    assert reg['buyer.wconcept'].rules == DEFAULT_BUYER_RULES
    assert reg.rules_text(reg['buyer.wconcept']).strip() != ''


def test_흐름을_공유하는_소싱처는_같은_에이전트가_맡는다(reg, sources):
    # 그랜드스테이지는 ABC마트와 같은 a-rt.com 흐름이라 key(=스크립트)를 공유한다
    assert sources.by_id('GrandStage').key == 'abc'
    assert reg.pick('buyer', _order('GrandStage'), {}).name == 'buyer.abc'
    assert reg.pick('buyer', _order('그랜드스테이지'), {}).name == 'buyer.abc'


def test_상품_ID_규칙은_표에서_온다():
    abc = _order('ABCmart', product_url='https://abcmart.a-rt.com/product/new?prdtNo=1010118346')
    assert '"sku": "1010118346"' in snapshot_args('buyer.abc', abc)
    # 규칙이 없는 소싱처는 URL 을 그대로 넘긴다
    musinsa = _order('MUSINSA', product_url='https://www.musinsa.com/products/1')
    assert '"sku": "https://www.musinsa.com/products/1"' in snapshot_args('buyer.musinsa', musinsa)


def test_에이전트_이름으로_소싱처를_찾는다():
    assert source_of('buyer.lotteon').id == 'LOTTEON'
    assert source_of('buyer.abc').id == 'ABCmart'  # key 를 공유하면 표의 첫 행을 따른다


def test_스크립트_미작성_소싱처는_만들어두되_사람에게_넘긴다(reg):
    bridge = BridgeClient(URL, 'a' * 64, allowed=reg['buyer.rexmonde'].tools, busy_wait_s=0.0)
    agents = build_agents(reg, bridge, lambda prompt, model: model(choice='x', reason='r'))
    agent = agents['buyer.rexmonde']
    assert isinstance(agent, ScriptsPendingBuyer)
    spec = reg['buyer.rexmonde']
    result = agent(
        Assignment(
            order=_order('GSShop'),
            allowed_tools=spec.tools,
            rules=reg.rules_text(spec),
            dry_run=True,
        )
    )
    assert result.status == 'needs_human'
    assert result.reason == '스크립트 미작성: REXMONDE'
    # 스크립트가 다 있는 소싱처는 진짜 구매 에이전트다
    assert not isinstance(agents['buyer.musinsa'], ScriptsPendingBuyer)


def test_소싱처_id_가_중복이면_로딩을_거부한다(tmp_path):
    (tmp_path / 'sources.yaml').write_text(
        'sources:\n  - {id: X, key: x, label: 엑스}\n  - {id: X, key: y, label: 와이}\n',
        encoding='utf-8',
    )
    with pytest.raises(ValueError, match='중복'):
        Sources.load(tmp_path)


def test_표의_모르는_필드는_거부한다(tmp_path):
    (tmp_path / 'sources.yaml').write_text(
        'sources:\n  - {id: X, key: x, label: 엑스, hoem: https://x/}\n', encoding='utf-8'
    )
    with pytest.raises(ValueError):
        Sources.load(tmp_path)


def test_ABC마트와_그랜드스테이지는_항상_까대기다():
    from samba_agent.sources import default_sources

    src = default_sources()
    assert src.by_id('ABCmart').order_type == 'kkadaegi'
    assert src.by_id('GrandStage').order_type == 'kkadaegi'
    assert src.by_id('MUSINSA').order_type is None


def test_SSG_는_신세계몰_경로비교_견적을_켜고_사용_중이다(sources):
    """SSG 주문 이행 연동(2026-09-27) — 켜는 것(status active)은 사용자 확인 뒤라 hold 그대로다."""
    ssg = sources.by_id('SSG')
    assert ssg.status == 'active'
    assert ssg.payment_quotes and ssg.mall_item and ssg.route_compare
    assert ssg.allow_department is True  # 사용자 2026-09-27: 신세계백화점(6009)도 허용
    assert ssg.mall_item_script == 'ssg_find_mall_item'
    assert ssg.route_quotes_script == 'ssg_route_quotes'
    assert ssg.charge_pay is False  # SSG MONEY 충전결제는 아직 후보에서 뺀다(현대카드가 더 싸다)


def test_새_필드는_기본이_꺼져_있어_기존_소싱처는_그대로다(sources):
    for sid in ('MUSINSA', '29CM', 'ABCmart', 'GrandStage', 'SHOEMAKER', 'LOTTEON'):
        s = sources.by_id(sid)
        assert not (s.mall_item or s.route_compare or s.allow_department or s.charge_pay), sid
        assert s.routes == []


def test_경로_이름은_정해진_것만_받는다(tmp_path):
    (tmp_path / 'sources.yaml').write_text(
        'sources:\n  - {id: X, key: x, label: 엑스, routes: [direct, coupang]}\n', encoding='utf-8'
    )
    with pytest.raises(ValueError):
        Sources.load(tmp_path)


def test_29cm_는_토스페이를_결제_후보에서_뺀다():
    """실기 2026-10-07: 29CM 토스페이는 현대·LOCA 카드가 '가맹점 미지원' — 현대 견적이 틀려 결제가 card_missing 으로 반복됐다."""
    assert source_of('buyer.cm29').excluded_pay_providers == ['toss']
