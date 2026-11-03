import json
from datetime import date
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from tools.daangn.android_phone import AndroidPhone
from tools.daangn.collector import Candidate, ChatEvidence
from tools.daangn.phone_worker import read_phone_order
from tools.daangn.pickup_dates import choose_pickup_date


@pytest.mark.parametrize('source', [{}, None, {'source_url': 'https://other.example/item'},
                                    {'source_site': '보유재고'}, {'source_verified': True}])
def test_unknown_source_never_reserves_or_claims_owned_stock(source):
    phone = Mock(unsafe=True)
    phone.verify_account.return_value = phone.open_chat.return_value = True
    phone.source_for.return_value = source
    phone.progress.return_value = {'awaiting_pickup': True, 'payment_confirmed': True,
        'sales_account': '김귀옥', 'product_name': '상품', 'sale_price': 17000,
        'paid_date': date(2026, 10, 30)}
    with pytest.raises(ValueError, match='소싱|재고'):
        read_phone_order(phone, Candidate('김귀옥', 'room', '상품', peer_name='상대'),
                         ChatEvidence(True, False, '상품', 17000), today=date(2026, 10, 30))
    phone.reserve_pickup.assert_not_called()


def test_explicit_verified_owned_listing_is_available_to_inventory_path(tmp_path):
    folder = tmp_path / 'owned-stock-1'
    folder.mkdir()
    (folder / 'listing.json').write_text(json.dumps({
        'phone_owner': '김귀옥', 'title': '보유 상품', 'status': 'published_verified',
        'price': 17000, 'source_site': '보유재고',
    }), encoding='utf8')
    phone = object.__new__(AndroidPhone)
    phone.attachments = tmp_path
    assert phone.source_for(SimpleNamespace(account='김귀옥', product_title='보유 상품'), 17000) == {
        'source_site': '보유재고', 'source_verified': True,
    }


def test_musinsa_with_only_tomorrow_visible_is_held():
    xml = ('<hierarchy><node text="택배를 언제 수거할까요?"/>'
           '<node text="10월 31일(토)" bounds="[1,2][30,40]"/></hierarchy>')
    with pytest.raises(ValueError, match='내일|최후'):
        choose_pickup_date(xml, today=date(2026, 10, 30), is_musinsa=True)
    assert choose_pickup_date(xml, today=date(2026, 10, 30), is_musinsa=False)[0] == date(2026, 10, 31)


def test_full_seven_date_xml_selects_november_seventh():
    labels = ['10월 31일(토)', '11월 2일(월)', '11월 3일(화)', '11월 4일(수)',
              '11월 5일(목)', '11월 6일(금)', '11월 7일(토)']
    xml = '<hierarchy><node text="택배를 언제 수거할까요?"/>' + ''.join(
        f'<node text="{label}" bounds="[1,{10+i*10}][30,{20+i*10}]"/>'
        for i, label in enumerate(labels)) + '</hierarchy>'
    assert choose_pickup_date(xml, today=date(2026, 10, 30), is_musinsa=True)[0] == date(2026, 11, 7)


def test_zero_bounds_calendar_is_held_without_making_up_coordinates():
    xml = ('<hierarchy><node text="택배를 언제 수거할까요?"/>'
           '<node text="11월 7일(토)" bounds="[0,0][0,0]"/></hierarchy>')
    with pytest.raises(ValueError, match='位置|위치'):
        choose_pickup_date(xml, today=date(2026, 10, 30), is_musinsa=True)
