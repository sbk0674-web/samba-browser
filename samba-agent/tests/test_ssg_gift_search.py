"""SSG 선물 수락(카톡 검색) — 주문번호에서 검색어·받는 분 이름을 뽑는 순수 함수와 방 안 판정."""

import pytest

from samba_agent.ops.ssg_gift_accept import GiftAcceptError, Node, source_order_no_of
from samba_agent.ops.ssg_gift_search import (
    accept_ssg_gift_by_search,
    in_ssg_room,
    matching_notice,
    order_code_of,
    product_words_of,
    recipient_of,
    room_node,
    same_bubble_button,
)


def test_검색어는_주문번호_끝_6자리():
    assert order_code_of('2026-10-04-DCB6EC') == 'DCB6EC'
    assert order_code_of('20261004DB7BCE') == 'DB7BCE'
    assert order_code_of('abc') == ''
    assert order_code_of('') == ''


def test_room_header_accessibility_description_is_recognized():
    block = Node('알림톡 차단', '', '', 551, 197)
    title = Node(text='', rid='com.kakao.talk:id/toolbar_default_title_text', desc='SSG닷컴', x=175, y=88)
    assert in_ssg_room([block, title])
    assert not in_ssg_room([title])
    wrong = Node(text='', rid=title.rid, desc='다른 채널', x=175, y=88)
    assert not in_ssg_room([block, wrong])


@pytest.mark.parametrize('model,accepted', [('HM9594-002', True), ('DV5457-131', False)])
@pytest.mark.parametrize('verify_only', [False, True])
def test_already_received_screen_requires_matching_product(monkeypatch, model, accepted, verify_only):
    from samba_agent.ops import ssg_gift_search as module

    notice = Node('F3C7AE 전달해드릴게요!', '', '', 300, 400)
    button = Node('선물 받으러 가기', '', '', 360, 700)

    class FakePhone:
        opened = False

        def top_package(self):
            return 'com.kakao.talk'

        def wake(self):
            pass

        def _run(self, *args):
            pass

        def key(self, code):
            pass

        def launch(self, package):
            pass

        def input_text(self, text):
            pass

        def tap(self, x, y):
            if (x, y) == (button.x, button.y):
                self.opened = True

        def nodes(self):
            if self.opened:
                return [Node('선물 받기 완료 ' + model, '', '', 360, 410)]
            return [notice]

    monkeypatch.setattr(module, 'wait_foreground', lambda *args: True)
    monkeypatch.setattr(module, 'in_ssg_room', lambda ns: True)
    monkeypatch.setattr(module, 'recipient_of', lambda text: 'recipient')
    monkeypatch.setattr(module, 'matching_notice', lambda *args: notice)
    monkeypatch.setattr(module, 'same_bubble_button', lambda *args: button)
    if accepted:
        result = accept_ssg_gift_by_search(FakePhone(), '20261011F3C7AE', sku='나이키 HM9594', model_code='HM9594', verify_only=verify_only, sleep=lambda _: None)
        assert '상품 대조' in result
    else:
        with pytest.raises(GiftAcceptError, match='상품과 다르다'):
            accept_ssg_gift_by_search(FakePhone(), '20261011F3C7AE', sku='나이키 HM9594', model_code='HM9594', verify_only=verify_only, sleep=lambda _: None)


@pytest.mark.parametrize('verify_only', [False, True])
def test_missing_option_check_never_uses_fixed_coordinate_on_delivery_form(monkeypatch, verify_only):
    from samba_agent.ops import ssg_gift_search as module
    notice = Node('F3C7AE 전달해드릴게요!', '', '', 300, 400)
    button = Node('선물 받으러 가기', '', '', 360, 700)

    class FakePhone:
        opened = False
        def top_package(self): return 'com.kakao.talk'
        def wake(self): pass
        def _run(self, *args): pass
        def key(self, code): pass
        def launch(self, package): pass
        def input_text(self, text): pass
        def tap(self, x, y):
            if (x, y) == (button.x, button.y): self.opened = True
            elif self.opened: raise AssertionError('unverified coordinate tap')
        def nodes(self):
            if self.opened:
                return [Node('배송정보 나이키 HM9594-002', '', '', 360, 410), Node('선물 받기', '', '', 360, 1404)]
            return [notice]

    monkeypatch.setattr(module, 'wait_foreground', lambda *args: True)
    monkeypatch.setattr(module, 'in_ssg_room', lambda ns: True)
    monkeypatch.setattr(module, 'recipient_of', lambda text: 'recipient')
    monkeypatch.setattr(module, 'matching_notice', lambda *args: notice)
    monkeypatch.setattr(module, 'same_bubble_button', lambda *args: button)
    with pytest.raises(GiftAcceptError, match='독립 재확인' if verify_only else '옵션/배송지 확인'):
        accept_ssg_gift_by_search(FakePhone(), '20261011F3C7AE', sku='나이키 HM9594', model_code='HM9594', verify_only=verify_only, sleep=lambda _: None)


def test_받는_분_이름을_알림에서_읽는다():
    assert recipient_of('이은채님에게 임성희님의 마음을 담은 선물을 전달해드릴게요!') == '이은채'
    assert recipient_of('받는 분 없음') is None


def test_결제_결과의_소싱_주문번호를_꺼낸다():
    out = {'results': {'payer': {'payload': {'source_order_no': '20261004DCB6EC'}}, 'buyer.ssg': {'payload': {}}}}
    assert source_order_no_of(out) == '20261004DCB6EC'
    assert source_order_no_of({'results': {}}) == ''


def test_주문번호를_모르면_검색하지_않고_실패한다():
    class _Phone:  # 호출되면 안 된다
        def __getattr__(self, name):
            raise AssertionError(f'폰을 만지면 안 된다: {name}')

    with pytest.raises(GiftAcceptError, match='주문번호'):
        accept_ssg_gift_by_search(_Phone(), '')  # type: ignore[arg-type]


def test_foreground_failure_tries_explicit_activity_without_tapping_other_app(monkeypatch):
    from samba_agent.ops import ssg_gift_search as module

    calls = []

    class FakePhone:
        def wake(self):
            pass

        def top_package(self):
            return 'com.kakao.talk'

        def key(self, code):
            calls.append(('key', code))

        def launch(self, package):
            calls.append(('launch', package))

        def _run(self, *args):
            calls.append(args)

        def nodes(self):
            raise AssertionError('다른 앱 화면은 읽거나 누르지 않는다')

    monkeypatch.setattr(module, 'wait_foreground', lambda *args: False)
    with pytest.raises(GiftAcceptError, match='앞으로 열지 못했다'):
        accept_ssg_gift_by_search(FakePhone(), '20261011F3C7AE', sleep=lambda _: None)
    assert ('shell', 'am', 'start', '-n', 'com.kakao.talk/.activity.SplashActivity') in calls


def test_alipay_foreground_is_preserved_without_phone_actions():
    class Phone:
        def top_package(self):
            return 'com.eg.android.AlipayGphone'

        def __getattr__(self, name):
            raise AssertionError('알리페이 복구 중 조작 금지: ' + name)

    with pytest.raises(OSError, match='알리페이 복구'):
        accept_ssg_gift_by_search(Phone(), '20261011F3C7AE')


@pytest.mark.parametrize('package', ['com.eg.android.AlipayGphone', 'com.shizhuang.duapp'])
def test_user_phone_screen_never_falls_back_to_legacy_accept(monkeypatch, package):
    from samba_agent.ops import ssg_gift_accept as module
    calls = []

    class Phone:
        def __init__(self, *args): pass
        def top_package(self): return package
        def __getattr__(self, name):
            raise AssertionError('User screen must not be operated: ' + name)

    monkeypatch.setattr(module, 'find_phone_serial', lambda *args: 'test-phone')
    monkeypatch.setattr(module, 'Phone', Phone)
    monkeypatch.setattr(module, 'gift_order_of', lambda out: True)
    monkeypatch.setattr(module, 'source_order_no_of', lambda out: '20261011F3C7AE')
    monkeypatch.setattr(module, 'accept_ssg_gift', lambda *args, **kwargs: calls.append(True) or 'legacy')
    hook = module.make_after_done(lambda job: ('SSG', '나이키 HM9594'))
    result = hook(object(), {})
    assert calls == []
    assert '실패' in result


def test_같은_말풍선_버튼만_고른다():
    target = Node('임성희님의 마음을 담은 선물이 이아님에게 도착했어요!', '', '', 320, 500)
    far_other = Node('선물 받으러 가기', '', '', 320, 900)
    close = Node('선물 받으러 가기', '', '', 320, 730)

    assert same_bubble_button([target, far_other, close], target, ('선물 받으러 가기',)) == close


def test_받는사람과_상품이_맞는_수락알림만_고른다():
    words = product_words_of('■ 상품명: 여성 나이키 스포츠웨어 플리스 재킷')
    wrong = Node('임성희님의 마음을 담은 선물이 이아님에게 도착했어요!\n■ 상품명 : 아디다스 팬츠', '', '', 320, 300)
    right = Node('임성희님의 마음을 담은 선물이 이아님에게 도착했어요!\n■ 상품명 : 나이키 플리스 재킷', '', '', 320, 600)

    assert matching_notice([wrong, right], '이아', words) == right


def test_검색결과_행에_미리보기가_붙어도_ssg방을_고른다():
    row = Node('SSG닷컴 김정님이 받으신 선물에 배송지가 확인되었어요!', '', '', 359, 397)

    assert room_node([row]) == row
