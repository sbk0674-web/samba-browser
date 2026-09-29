# 삼바웨이브 내부 API 클라이언트 — 헤더 · 목록 · 상세(배송지) · 소싱 기입 · 오류 사유 매핑
import httpx
import pytest
import respx

from samba_agent.failures import FailReason
from samba_agent.wave.client import WaveClient, WaveError, WaveOrder, wave_fields

BASE = 'https://wave.test'
API = f'{BASE}/api/v1/internal/harness'
TOKEN = 'test-token-not-a-real-secret'  # 테스트 전용 가짜 값
TENANT = 'tenant-1'

ORDER_JSON = {
    'id': 'uuid-1',
    'order_number': '2026092300001',
    'source_site': 'MUSINSA',
    'source_url': 'https://www.musinsa.com/products/123',
    'product_name': '나이키 에어포스',
    'product_option': '옵션:230',
    'quantity': 2,
    'sale_price': 129000,
    'seller': '포이즌',
    'sourcing_account_id': 'acc-1',
    'sourcing_account_username': 'buyer01',
    'sourcing_account_label': '성희',
    'sourcing_account_default': False,
    'action_tag': 'kkadaegi',
    'paid_at': '2026-09-22T05:00:00Z',
    'status': 'pending',
}


def client() -> WaveClient:
    return WaveClient(BASE, TOKEN, TENANT)


@respx.mock
def test_목록은_헤더와_창을_붙여_부르고_주문을_돌려준다():
    route = respx.get(f'{API}/pending-orders').mock(
        return_value=httpx.Response(200, json={'items': [ORDER_JSON], 'count': 1})
    )
    orders = client().pending_orders(days=7, limit=100)
    request = route.calls[0].request
    assert request.headers['X-Internal-Token'] == TOKEN
    assert request.headers['X-Tenant-Id'] == TENANT
    assert dict(httpx.QueryParams(request.url.query.decode())) == {'days': '7', 'limit': '100'}
    assert [o.order_number for o in orders] == ['2026092300001']


def test_옵션_머리말은_떼고_OrderRef_로_옮긴다():
    ref = WaveOrder.model_validate(ORDER_JSON).to_order_ref()
    assert ref.order_no == '2026092300001'
    assert ref.source == 'MUSINSA'
    assert ref.option == '230'  # '옵션:230' 의 머리말을 뗐다
    assert ref.sku == '나이키 에어포스 [230]'
    assert ref.qty == 2
    assert ref.product_url.endswith('/products/123')
    assert ref.account == 'buyer01'
    assert ref.order_type == 'direct'  # 목록 응답에는 주문 종류가 없다


def test_옵션이_사이즈_색상_꼴이면_그대로_쓴다():
    ref = WaveOrder.model_validate({**ORDER_JSON, 'product_option': 'BLACK / 270'}).to_order_ref()
    assert ref.option == 'BLACK / 270'
    assert ref.sku == '나이키 에어포스 [BLACK / 270]'


def test_소싱계정_아이디가_없으면_계정은_비운다():
    """실기: sourcing_account_username 이 null 인 주문이 있다 — 표시 이름으로 로그인할 수는 없다."""
    ref = WaveOrder.model_validate({**ORDER_JSON, 'sourcing_account_username': None}).to_order_ref()
    assert ref.account is None


@respx.mock
def test_상세는_주문_종류와_배송지를_준다():
    respx.get(f'{API}/orders/2026092300001').mock(
        return_value=httpx.Response(
            200,
            json={
                **ORDER_JSON,
                'order_type': 'kkadaegi',
                'shipping': {
                    'name': '홍길동',
                    'phone': '010-1234-5678',
                    'address': '서울특별시 강남구 테헤란로 1',
                    'address_detail': '2층',
                    'postal_code': '06234',
                },
            },
        )
    )
    detail = client().get_order('2026092300001')
    assert detail.order_type == 'kkadaegi'
    assert detail.to_order_ref().order_type == 'kkadaegi'
    assert detail.shipping.to_script_args()['postal_code'] == '06234'
    # 고객 전화번호는 모델에도, 스크립트 인자에도 없다
    assert 'phone' not in detail.shipping.to_script_args()
    assert '5678' not in detail.model_dump_json()


@respx.mock
def test_상세에_배송지가_없어도_빈_배송지로_읽는다():
    respx.get(f'{API}/orders/A1').mock(return_value=httpx.Response(200, json=ORDER_JSON))
    detail = client().get_order('A1')
    assert detail.shipping.name == ''


@respx.mock
def test_소싱_기입은_본문을_싣고_저장된_주문을_돌려준다():
    route = respx.put(f'{API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': ORDER_JSON})
    )
    order = client().record_sourcing(
        'A1', sourcing_order_number='M-777', cost=89000, shipping_fee=2500, notes='자동 처리'
    )
    import json as _json

    body = _json.loads(route.calls[0].request.content)
    assert body == {
        'sourcing_order_number': 'M-777',
        'cost': 89000,
        'shipping_fee': 2500,
        'notes': '자동 처리',
    }
    assert order.order_number == '2026092300001'


@respx.mock
def test_이미_다른_소싱주문번호가_있으면_중복이다():
    respx.put(f'{API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(409, json={'detail': '이미 다른 소싱주문번호가 있습니다'})
    )
    with pytest.raises(WaveError) as e:
        client().record_sourcing('A1', sourcing_order_number='M-777', cost=1)
    assert e.value.reason is FailReason.DUPLICATE
    assert e.value.status == 409


@respx.mock
@pytest.mark.parametrize(
    ('status', 'reason'),
    [
        (403, FailReason.PERMISSION_DENIED),
        (503, FailReason.PERMISSION_DENIED),
        (404, FailReason.UNKNOWN),
        (400, FailReason.UNKNOWN),
    ],
)
def test_상태코드를_실패_사유로_바꾼다(status, reason):
    respx.get(f'{API}/orders/A1').mock(return_value=httpx.Response(status, json={'detail': 'x'}))
    with pytest.raises(WaveError) as e:
        client().get_order('A1')
    assert e.value.reason is reason


@respx.mock
def test_연결이_안_되면_bridge_down_이다():
    respx.get(f'{API}/pending-orders').mock(side_effect=httpx.ConnectError('nope'))
    with pytest.raises(WaveError) as e:
        client().pending_orders()
    assert e.value.reason is FailReason.BRIDGE_DOWN


@respx.mock
def test_오류_메시지에_토큰은_들어가지_않는다():
    respx.get(f'{API}/orders/A1').mock(return_value=httpx.Response(403, json={'detail': '거절'}))
    with pytest.raises(WaveError) as e:
        client().get_order('A1')
    assert TOKEN not in str(e.value)


def test_대조용_사전은_응답에_있는_값만_담는다():
    """목록 모델에 소싱주문번호·매입금액이 없으면 '같다' 가 아니라 아예 담지 않는다."""
    assert wave_fields(WaveOrder.model_validate(ORDER_JSON)) == {}
    filled = WaveOrder.model_validate(
        {**ORDER_JSON, 'sourcing_order_number': 'M-777', 'cost': 89000, 'shipping_fee': 0}
    )
    assert wave_fields(filled) == {
        'source_order_no': 'M-777',
        'real_price': 89000,
        'shipping_fee': 0,
    }


@respx.mock
def test_상세는_요청한_배송_종류를_인자로_보낸다():
    route = respx.get(f'{API}/orders/A1').mock(
        return_value=httpx.Response(
            200, json={'order_number': 'A1', 'order_type': 'kkadaegi', 'contact_phone': '02-1'}
        )
    )
    d = client().get_order('A1', order_type='kkadaegi')
    assert route.calls[0].request.url.params['order_type'] == 'kkadaegi'
    # 연락처는 하네스가 받지 않는다 — 응답에 실려 와도 버린다(배송 연락처는 앱 신원정보)
    assert 'contact_phone' not in d.model_dump()


def test_판매가를_OrderRef_로_옮긴다():
    o = WaveOrder(order_number='A1', product_name='x', sale_price=12345)
    assert o.to_order_ref().sale_price == 12345


def test_플래그는_action_tag_토큰을_소문자로_옮긴다():
    o = WaveOrder(order_number='A1', action_tag=' No_Price, staff_a ,,kkadaegi')
    assert o.to_order_ref().flags == ('no_price', 'staff_a', 'kkadaegi')
    assert WaveOrder(order_number='A1').to_order_ref().flags == ()


def test_정산금이_있으면_OrderRef_로_옮기고_없으면_0이다():
    assert WaveOrder(order_number='A1', revenue=110000).to_order_ref().revenue == 110000
    assert WaveOrder(order_number='A1').to_order_ref().revenue == 0


def test_플래그_토큰은_한글_이름으로_보여_준다():
    from samba_agent.wave.client import flag_text

    assert (
        flag_text(('no_price', 'no_stock', 'staff_a', 'staff_b', 'kkadaegi', 'direct', 'gift'))
        == '가격X, 재고X, 직원A, 직원B, 까대기, 직배, 선물'
    )
    assert flag_text(('hold',)) == 'hold'  # 모르는 토큰은 그대로
    assert flag_text(()) == ''


@respx.mock
def test_record_sourcing_은_판정한_배송_종류를_함께_보낸다():
    import json

    route = respx.put(f'{API}/orders/A1/sourcing').mock(
        return_value=httpx.Response(200, json={'ok': True, 'order': ORDER_JSON})
    )
    client().record_sourcing('A1', sourcing_order_number='M-777', cost=1, order_type='kkadaegi')
    body = json.loads(route.calls.last.request.content)
    assert body['order_type'] == 'kkadaegi'
    # 판정이 없으면 필드를 아예 보내지 않는다
    client().record_sourcing('A1', sourcing_order_number='M-777', cost=1)
    assert 'order_type' not in json.loads(route.calls.last.request.content)


@respx.mock
def test_소싱_계정_id_를_소싱처와_아이디로_찾는다():
    respx.get(f'{API}/sourcing-accounts').mock(
        return_value=httpx.Response(
            200,
            json={'items': [
                {'id': 'sa_1', 'source_site': 'MUSINSA', 'username': 'buyer02'},
                {'id': 'sa_2', 'source_site': 'MUSINSA', 'username': 'buyer01'},
            ]},
        )
    )
    assert client().sourcing_account_id('MUSINSA', 'buyer01') == 'sa_2'
    assert client().sourcing_account_id('MUSINSA', 'nobody') is None


@respx.mock
def test_되읽기는_소싱주문번호로_행을_고른다():
    """한 상품주문번호에 행이 여럿(20260927C5313B 240·260) — 방금 적은 행을 되읽는다."""
    route = respx.get(f'{API}/orders/A1').mock(
        return_value=httpx.Response(200, json={'order_number': 'A1'})
    )
    client().get_order('A1', sourcing_order_number='S-9')
    assert route.calls[0].request.url.params['sourcing_order_number'] == 'S-9'
    client().get_order('A1')
    assert 'sourcing_order_number' not in route.calls[1].request.url.params


def test_옵션_머리말이_여럿이면_모두_뗀다():
    """무신사 292: '옵션1:DEEP PEACH(H25)/옵션2:095' — 가운데 '옵션2:' 가 남아 선택지와 못 맞췄다."""
    o = WaveOrder(order_number='A1', product_option='옵션1:DEEP PEACH(H25)/옵션2:095')
    assert o.option == 'DEEP PEACH(H25)/095'
    assert WaveOrder(order_number='A1', product_option='옵션:230').option == '230'
    assert WaveOrder(order_number='A1', product_option='BLACK / 270').option == 'BLACK / 270'


def test_주문_옵션은_등록_매칭된_소싱처_옵션_이름으로_바꾼다():
    from samba_agent.wave.client import WaveOrderDetail

    base = {'order_number': 'N1', 'source_site': 'MUSINSA', 'seller': 'KT알파쇼핑', 'product_name': '티셔츠'}
    # 마켓 옵션 '01올리브/L' 은 등록 옵션 '01올리브 / L' 로 만든 것이다
    d = WaveOrderDetail(
        **base,
        product_option='01올리브/L',
        source_options=[{'name': '01올리브 / M'}, {'name': '01올리브 / L', 'stock': 0}],
    )
    ref = d.to_order_ref()
    assert ref.option == '01올리브 / L' and ref.market_option == '01올리브/L'
    # 포이즌: 입찰번호로 찾은 등록 옵션이 있으면 그것
    p = WaveOrderDetail(**base, product_option='블랙 S', registered_option='085(WS)')
    assert p.to_order_ref().option == '085(WS)'
    # 매칭이 없거나 둘 이상이면 원래 옵션 그대로
    n = WaveOrderDetail(**base, product_option='블랙 S', source_options=[{'name': '090'}])
    assert n.to_order_ref().option == '블랙 S' and n.to_order_ref().market_option is None
