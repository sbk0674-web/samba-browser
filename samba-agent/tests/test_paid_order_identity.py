from types import SimpleNamespace

import pytest

from samba_agent.agents.buyer import matching_options
from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.order_identity import paid_option_matches
from samba_agent.agents.payer import order_form_mismatch
from samba_agent.agents.verifier import VerifierAgent

WANTED = 'DK/NAVY(M04) / 100'
PINK = 'PEACH PINK(H24):100'


def test_sold_navy_cannot_fall_back_to_live_pink_same_size():
    assert matching_options([PINK, 'DK/NAVY(M04):100 [품절]'], WANTED) == []
    assert matching_options(['DK/NAVY(M04):100'], WANTED) == ['DK/NAVY(M04):100']
    assert not paid_option_matches(WANTED, PINK)
    assert paid_option_matches(WANTED, 'DK/NAVY(M04):100')
    assert order_form_mismatch('NEPA 2408292 PEACH PINK(H24):100', 'NEPA', WANTED, PINK,
                               product_no='2408292') is not None


@pytest.mark.parametrize(
    'wanted,actual,ok',
    [
        ('BLACK 1개 S', 'S', True),
        ('상세페이지 참조 180', '180', True),
        ('BLK(BLACK) 085(S)', '085(S)', True),
        ('차콜 L', 'L', True),
        ('BLACK 110(XXL)', '110(XXL)', True),
        ('CRE(CREAM) 090(M) NJ3NR86C', '090', True),
        ('CRE(CREAM) 090(M) NJ3NR86C', '095', False),
        ('CRE(CREAM) 090(M) NJ3NR86C', '09', False),
        ('L', '01블랙+워시드브라운 · L', True),
        ('L', '01블랙+워시드브라운 · XL', False),
        ('L', '01블랙 · M', False),
        ('LYONS BLUE 1개 100', 'LYONS BLUE · 100', True),
        ('LYONS BLUE 1개 100', 'LYONS BLUE · 105', False),
        ('LYONS BLUE 1개 100', 'NAVY · 100', False),
        ('BLK(BLACK) 095(L) NJ3NR86A', 'BLK(BLACK) · 095', True),
        ('BLACK 1개 S', 'M', False),
        ('상세페이지 참조 180', '185', False),
        ('BLK(BLACK) 085(S)', '090(M)', False),
        (WANTED, PINK, False),
    ],
)
def test_size_only_detail_matches_size_inside_order_option(wanted, actual, ok):
    assert paid_option_matches(wanted, actual) is ok


def assignment():
    return Assignment(order=OrderRef(order_no='A1', source='29CM', seller='test', sku='NEPA',
                                     option=WANTED), allowed_tools=(), rules='', dry_run=False)


SHIP = {'name': '테스트', 'address': '서울 중구 시험로 47', 'address_detail': '401동 703호'}


def verifier():
    v = object.__new__(VerifierAgent)
    v._wave = SimpleNamespace(get_order=lambda *a, **k: SimpleNamespace(
        order_type='direct', shipping=SimpleNamespace(to_script_args=lambda: SHIP)))
    return v


def test_postcheck_uses_original_option_not_buyers_wrong_selected():
    a = assignment().model_copy(update={'handoff': {'selected': PINK}})
    bad, missing = verifier()._identity_check(a, {'selected': PINK, 'qty': 1, 'shipping': SHIP})
    assert bad == ['option']
    assert not missing


@pytest.mark.parametrize('key', ['selected', 'qty', 'shipping'])
def test_missing_paid_order_identity_never_passes(key):
    source = {'selected': WANTED, 'qty': 1, 'shipping': SHIP}
    source.pop(key)
    _bad, missing = verifier()._identity_check(assignment(), source)
    assert missing


def test_same_postcode_does_not_hide_wrong_room_or_road():
    for updates in ({'address_detail': '401동 1703호'}, {'address': '서울 중구 다른로 47'},
                    {'name': '다른사람'}):
        source = {'selected': WANTED, 'qty': 1, 'shipping': {**SHIP, **updates, 'postal_code': '12345'}}
        bad, _missing = verifier()._identity_check(assignment(), source)
        assert bad


def test_all_identity_fields_must_be_read_from_source():
    assert verifier()._identity_check(assignment(), {'selected': WANTED, 'qty': 1, 'shipping': SHIP}) == ([], [])


def test_detail_repair_is_requested_when_paid_identity_is_missing():
    check = verifier()._detail_validator(assignment(), 'ORD1')
    assert 'option' in check({'source_order_no': 'ORD1', 'paid': 42})
    assert check({'source_order_no': 'ORD1', 'paid': 42, 'selected': WANTED,
                  'qty': 1, 'shipping': SHIP}) is None


def test_actual_wrong_option_is_not_rewritten_to_make_repair_pass():
    check = verifier()._detail_validator(assignment(), 'ORD1')
    assert check({'source_order_no': 'ORD1', 'paid': 42, 'selected': PINK,
                  'qty': 1, 'shipping': SHIP}) is None
    assert verifier()._identity_check(assignment(), {'selected': PINK, 'qty': 1,
                                                   'shipping': SHIP})[0] == ['option']


def test_masked_recipient_is_unverified_even_with_matching_address():
    bad, missing = verifier()._identity_check(assignment(), {'selected': WANTED, 'qty': 1,
        'shipping_text': '배송지정보 테*트 서울 중구 시험로 47 401동 703호'})
    assert not bad
    assert 'recipient' in missing


@pytest.mark.parametrize('separator', [' ', ', ', ' (시험동) '])
def test_combined_source_address_preserves_building_number_boundary(separator):
    source = {'selected': WANTED, 'qty': 1, 'shipping': {
        'name': SHIP['name'], 'address': SHIP['address'] + separator + SHIP['address_detail'],
        'address_detail': None,
    }}
    assert verifier()._identity_check(assignment(), source) == ([], [])


def test_combined_wrong_room_still_fails_even_when_it_contains_requested_digits():
    source = {'selected': WANTED, 'qty': 1, 'shipping': {
        'name': SHIP['name'], 'address': SHIP['address'] + ' 401동 1703호',
        'address_detail': None,
    }}
    bad, missing = verifier()._identity_check(assignment(), source)
    assert bad == ['address_detail']
    assert not missing


@pytest.mark.parametrize(('room', 'verified'), [('703호', True), ('1703호', False)])
def test_visible_shipping_text_also_requires_exact_room_digits(room, verified):
    source = {'selected': WANTED, 'qty': 1,
              'shipping_text': f"{SHIP['name']} 배송지 변경 {SHIP['address']} 401동 {room}"}
    bad, missing = verifier()._identity_check(assignment(), source)
    assert not bad
    assert (not missing) == verified


def test_complete_address_word_may_be_adjacent_to_another_numeric_field():
    from samba_agent.agents.verifier import _address_contains

    assert _address_contains('시험로47|401동703호123', '401동703호')
    assert not _address_contains('시험로474|401동1703호', '시험로47')
    assert not _address_contains('시험로47|401동1703호', '703호')


@pytest.mark.parametrize(('actual', 'status'), [(PINK, 'fail'), (WANTED, 'ok'), (None, 'needs_ai')])
def test_verifier_result_requires_paid_order_identity(actual, status):
    v = verifier()
    v.evidence = []
    v.step = lambda *args: None
    v.note = lambda *args: None
    expected = {'source_order_no': 'ORD1'}
    v.script_json = lambda *args, **kwargs: {**expected, 'selected': actual, 'qty': 1, 'shipping': SHIP}
    v._read_samba = lambda a: (expected, ())
    a = assignment().model_copy(update={'expected': expected, 'handoff': {'selected': PINK}})
    result = v._verify(a)
    assert result.status == status


def test_numeric_free_order_matches_detail_with_color_or_letter():
    # 실기 2026-11-05: 무신사 '260MM FREE' ↔ 'BLACK · 260MM', 롯데온 '260MM FREE' ↔ '260MM(L)'
    from samba_agent.agents.order_identity import paid_option_matches

    assert paid_option_matches('260MM FREE', 'BLACK · 260MM')
    assert paid_option_matches('260MM FREE', '260MM(L)')
    assert not paid_option_matches('260MM FREE', 'BLACK · 250MM')
    assert not paid_option_matches('블랙 260', '화이트 · 260')


def test_detail_reference_placeholder_is_not_an_option_value():
    # 실기 2026-11-05 4298: '상세 이미지 참조 L' ↔ 'BLACK · L'
    from samba_agent.agents.order_identity import paid_option_matches

    assert paid_option_matches('상세 이미지 참조 L', 'BLACK · L')
    assert paid_option_matches('상세페이지 참고 270', 'BLACK · 270')
    assert not paid_option_matches('상세 이미지 참조 M', 'BLACK · L')


def test_괄호_안쪽만_보이는_상세도_같은_옵션():
    # 실기 2026-11-09 무신사 4696: 'BLK(BLACK) 095(L) NJ3NR86A' ↔ 상세 'BLACK · 095'
    from samba_agent.agents.order_identity import paid_option_matches

    wanted = 'BLK(BLACK) 095(L) NJ3NR86A'
    assert paid_option_matches(wanted, 'BLACK · 095')
    assert not paid_option_matches(wanted, 'WHITE · 095')
    assert not paid_option_matches(wanted, 'BLACK · 100')
