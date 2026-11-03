import xml.etree.ElementTree as ET
from datetime import UTC, date, datetime
from unittest.mock import Mock

import pytest

from tools.daangn.android_phone import AndroidPhone
from tools.daangn.collector import Candidate, ChatEvidence
from tools.daangn.phone_worker import read_phone_order


def card(title='나이키 맨투맨 110', price='17,000원', extra=''):
    return ('<hierarchy>' + ''.join(f'<node text="{x}"/>' for x in (
        title, price, '날짜 선택하기', '진행 현황 보기')) + extra + '</hierarchy>')


def test_verified_chat_payment_card_returns_awaiting_without_opening_progress():
    phone = object.__new__(AndroidPhone)
    xml = card()
    phone._screen = Mock(return_value=(xml, ET.fromstring(xml)))
    phone._tap_unique = Mock(side_effect=AssertionError('must not open progress'))
    result = phone.progress('김귀옥', '나이키 맨투맨 110', 17000, date(2026, 10, 30),
                            payment_event_at=datetime(2026, 10, 30, 6, 9, tzinfo=UTC))
    assert result == {'awaiting_pickup': True, 'payment_confirmed': True,
                      'sales_account': '김귀옥', 'product_name': '나이키 맨투맨 110',
                      'sale_price': 17000, 'paid_date': date(2026, 10, 30)}
    phone._screen.assert_called_once()


@pytest.mark.parametrize('xml', [card(title='다른 상품'), card(price='18,000원'),
                                card(extra='<node text="거래 취소 완료"/>')])
def test_wrong_or_cancelled_card_never_opens_date_or_progress(xml):
    phone = object.__new__(AndroidPhone)
    phone._screen = Mock(return_value=(xml, ET.fromstring(xml)))
    phone._tap_unique = Mock(side_effect=AssertionError('must hold'))
    with pytest.raises(ValueError):
        phone.progress('김귀옥', '나이키 맨투맨 110', 17000, date(2026, 10, 30),
                       payment_event_at=datetime(2026, 10, 30, 6, 9, tzinfo=UTC))


def test_worker_passes_verified_chat_payment_to_progress_and_rereads_after_booking():
    phone = Mock(unsafe=True)
    phone.verify_account.return_value = phone.open_chat.return_value = True
    phone.source_for.return_value = {'source_url': 'https://www.musinsa.com/products/7580605'}
    phone.progress.side_effect = [
        {'awaiting_pickup': True, 'payment_confirmed': True, 'sales_account': '김귀옥',
         'product_name': '나이키 맨투맨 110', 'sale_price': 17000, 'paid_date': date(2026, 10, 30)},
        {'payment_confirmed': True, 'sales_account': '김귀옥', 'product_name': '나이키 맨투맨 110',
         'sale_price': 17000, 'pickup_date': date(2026, 11, 7), 'pickup_number': '123', 'source_site': '보유재고'},
    ]
    phone.reserve_pickup.return_value = date(2026, 11, 7)
    event = datetime(2026, 10, 30, 6, 9, tzinfo=UTC)
    result = read_phone_order(phone, Candidate('김귀옥', 'room', '나이키 맨투맨 110', peer_name='상대'),
                             ChatEvidence(True, False, '나이키 맨투맨 110', 17000, event), today=date(2026, 10, 30))
    assert phone.progress.call_args_list[0].kwargs == {'payment_event_at': event}
    assert result['pickup_number'] == '123' and phone.progress.call_count == 2
    assert result['source_url'] == 'https://www.musinsa.com/products/7580605'
    assert 'source_site' not in result
    phone.reserve_pickup.assert_called_once_with(is_musinsa=True, today=date(2026, 10, 30), location='문 앞')
