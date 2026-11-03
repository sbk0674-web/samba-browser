import pytest

from samba_agent.ops.ssg_gift_accept import SSG_APP, GiftAcceptError, Node
from samba_agent.ops.ssg_gift_repair import GiftRepairTools, GiftScreenRepairer
from samba_agent.ops.ssg_gift_search import gift_check_button


class FakePhone:
    def __init__(self, nodes):
        self.current = nodes
        self.taps = []

    def top_package(self):
        return SSG_APP

    def nodes(self):
        return self.current

    def tap(self, x, y):
        self.taps.append((x, y))


def product():
    return Node('다이나핏 YUS23G30 베이지 270', '', '', 360, 400)


def test_ad_overlay_blocks_script_button_tap():
    phone = FakePhone(
        [product(), Node('', 'close', '', 0, 0), Node('옵션/배송지 확인', '', '', 360, 1434)]
    )
    with pytest.raises(GiftAcceptError, match='광고'):
        gift_check_button(phone, phone.nodes())
    assert phone.taps == []


def test_bottom_home_overlap_requires_visual_repair():
    phone = FakePhone(
        [
            product(),
            Node('옵션/배송지 확인', '', '', 360, 1434),
            Node('', 'SSG.COM 홈으로 이동', '', 360, 1428),
        ]
    )
    with pytest.raises(GiftAcceptError, match='하단'):
        gift_check_button(phone, phone.nodes())
    assert phone.taps == []


def test_kakao_browser_close_is_not_an_advertisement():
    from samba_agent.ops.ssg_gift_accept import CLOSE_ID

    check = Node('옵션/배송지 확인', '', '', 360, 1200)
    phone = FakePhone([product(), check, Node('', '닫기', CLOSE_ID, 50, 100)])
    assert gift_check_button(phone, phone.nodes()) == check


def test_repair_cannot_accept_before_door_selection_or_touch_payment():
    phone = FakePhone(
        [
            product(),
            Node('선물 받기', '', '', 360, 1404),
            Node('부재 시 문앞에 놓아주세요', '', '', 150, 1094),
        ]
    )
    tools = GiftRepairTools(phone, 'YUS23G30', 'YUS23G30')
    with pytest.raises(GiftAcceptError, match='문앞'):
        tools.act('accept', 360, 1404)
    with pytest.raises(GiftAcceptError):
        tools.act('pay', 360, 1404)
    tools.act('door', 150, 1094)
    tools.act('accept', 360, 1404)
    assert len(phone.taps) == 2


def test_repair_requires_current_matching_product_and_completion():
    phone = FakePhone([product(), Node('선물 받기 완료!', '', '', 360, 250)])
    tools = GiftRepairTools(phone, 'YUS23G30', 'YUS23G30')
    assert tools.completed()
    tools.door_selected = True
    assert not tools.completed()
    phone.current.append(Node('부재 시 문앞에 놓아주세요', '', '', 360, 850))
    assert tools.completed()
    phone.current = [Node('다른 상품 DV1234 선물 받기 완료!', '', '', 360, 250)]
    assert not tools.completed()
    with pytest.raises(GiftAcceptError, match='상품'):
        tools.act('check', 360, 1404)


def test_after_done_runs_gift_repair_and_keeps_first_failure(monkeypatch):
    from samba_agent.ops import evidence
    from samba_agent.ops import ssg_gift_accept as module
    from samba_agent.ops import ssg_gift_search as search

    phone = FakePhone([product()])
    monkeypatch.setattr(module, 'find_phone_serial', lambda *args: 'test')
    monkeypatch.setattr(module, 'Phone', lambda *args: phone)
    monkeypatch.setattr(module, 'gift_order_of', lambda out: True)
    monkeypatch.setattr(module, 'source_order_no_of', lambda out: '20261027314231')
    monkeypatch.setattr(evidence, 'save_phone_shot', lambda *args: 'first.png')

    def fail(*args, **kwargs):
        raise GiftAcceptError('옵션/배송지 확인 뒤 배송정보 입력 화면이 안 떴다')

    monkeypatch.setattr(search, 'accept_ssg_gift_by_search', fail)
    calls = []

    def repair(*args, **kwargs):
        calls.append(kwargs['problem'])
        return '선물 받기 완료(AI 복구)'

    hook = module.make_after_done(lambda job: ('SSG', 'YUS23G30'), gift_repair=repair)
    assert '완료' in hook(object(), {})
    assert '배송정보' in calls[0]

    hook = module.make_after_done(lambda job: ('SSG', 'YUS23G30'), gift_repair=lambda *a, **k: None)
    monkeypatch.setattr(
        module,
        'accept_ssg_gift',
        lambda *a, **k: (_ for _ in ()).throw(AssertionError('legacy must not run')),
    )
    assert '배송정보' in hook(object(), {})


def test_ai_repair_has_no_purchase_tools_and_requires_screen_proof():
    phone = FakePhone([product(), Node('선물 받기', '', '', 360, 1404)])
    captured = []

    async def query(*, prompt, options):
        captured.append(options)
        yield '선물 수락 완료라고 말해도 화면 증거 없이는 성공 아님'

    repair = GiftScreenRepairer(model='test-model', query_fn=query)
    assert repair(phone, sku='YUS23G30', model_code='YUS23G30', problem='광고') is None
    assert captured[0].tools == []
    assert captured[0].allowed_tools == ['mcp__giftrepair__screen', 'mcp__giftrepair__act']


def test_password_screen_is_never_given_to_repair_ai():
    phone = FakePhone([product(), Node('결제 비밀번호', '', '', 360, 600)])
    with pytest.raises(GiftAcceptError, match='비밀번호'):
        GiftRepairTools(phone, 'YUS23G30', 'YUS23G30').read()
