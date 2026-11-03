from types import SimpleNamespace

import pytest

from samba_agent.agents.contracts import Assignment, OrderRef
from samba_agent.agents.verifier import VerifierAgent


def check_source(address, detail='401동 703호', *, raw=False):
    shipping = {'name': '테스트', 'address': '경기도 시험시 시험로 47',
                'address_detail': '401동 703호'}
    verifier = object.__new__(VerifierAgent)
    verifier._wave = SimpleNamespace(get_order=lambda *a, **kw: SimpleNamespace(
        order_type='direct', shipping=SimpleNamespace(to_script_args=lambda: shipping)))
    assignment = Assignment(order=OrderRef(order_no='ALIAS1', source='MUSINSA',
        seller='test', sku='TEST', option='BLACK L'), allowed_tools=(), rules='', dry_run=False)
    source = {'selected': 'BLACK L', 'qty': 1}
    if raw:
        source['shipping_text'] = f'테스트 배송지 {address} {detail}'
    else:
        source['shipping'] = {**shipping, 'address': address, 'address_detail': detail}
    return verifier._identity_check(assignment, source)


@pytest.mark.parametrize('raw', [False, True])
def test_same_province_abbreviation_does_not_hide_verified_address(raw):
    assert check_source('경기 시험시 시험로 47', raw=raw) == ([], [])


@pytest.mark.parametrize('raw', [False, True])
def test_province_alias_still_rejects_different_room(raw):
    mismatch, missing = check_source('경기 시험시 시험로 47', '401동 1703호', raw=raw)
    assert 'address_detail' in mismatch + missing


@pytest.mark.parametrize('address', ['충청남도 시험시 시험로 47',
                                    '경기 시험시 시험로 474',
                                    '경기 다른시 시험로 47'])
def test_province_alias_does_not_accept_other_province_road_or_city(address):
    mismatch, missing = check_source(address)
    assert 'address' in mismatch + missing
