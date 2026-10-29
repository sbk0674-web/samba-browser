from datetime import date, datetime, timezone
from unittest.mock import Mock

import pytest

from tools.daangn.collector import Candidate, ChatEvidence
from tools.daangn.phone_worker import read_phone_order


def test_no_phone_navigation_until_lock_and_account_verified():
    phone = Mock(unsafe=True)
    phone.verify_account.return_value = False
    candidate = Candidate('서병기', 'room', '신발', peer_name='상대')
    with pytest.raises(ValueError, match='계정'):
        read_phone_order(phone, candidate, ChatEvidence(True, False, '신발', 69000), today=date(2026, 10, 30))
    phone.open_chat.assert_not_called()
    phone.reserve_pickup.assert_not_called()


def test_existing_pickup_is_not_booked_again():
    phone = Mock(unsafe=True)
    phone.verify_account.return_value = True
    phone.open_chat.return_value = True
    phone.progress.return_value = {'payment_confirmed': True, 'sales_account': '서병기',
        'product_name': '신발', 'sale_price': 69000, 'pickup_number': '056',
        'pickup_date': date(2026, 10, 30)}
    candidate = Candidate('서병기', 'room', '신발', peer_name='상대')
    result = read_phone_order(phone, candidate, ChatEvidence(True, False, '신발', 69000), today=date(2026, 10, 30))
    assert result['pickup_number'] == '056'
    phone.reserve_pickup.assert_not_called()


def test_new_inventory_uses_earliest_door_and_rereads_progress():
    phone = Mock(unsafe=True)
    phone.verify_account.return_value = True
    phone.open_chat.return_value = True
    phone.reserve_pickup.return_value = date(2026, 10, 30)
    phone.progress.side_effect = [{'awaiting_pickup': True, 'payment_confirmed': True,
        'sales_account': '서병기', 'product_name': '신발', 'sale_price': 69000,
        'paid_date': date(2026, 10, 30)}, {'payment_confirmed': True, 'sales_account': '서병기',
        'product_name': '신발', 'sale_price': 69000, 'pickup_number': '056',
        'pickup_date': date(2026, 10, 30)}]
    candidate = Candidate('서병기', 'room', '신발', peer_name='상대')
    result = read_phone_order(phone, candidate, ChatEvidence(True, False, '신발', 69000), today=date(2026, 10, 30))
    phone.reserve_pickup.assert_called_once_with(is_musinsa=False, today=date(2026, 10, 30), location='문 앞')
    assert result['pickup_date'] == date(2026, 10, 30)


def test_cutoff_proof_requires_event_and_matching_paid_day():
    phone = Mock(unsafe=True)
    phone.verify_account.return_value = True
    phone.open_chat.return_value = True
    phone.progress.return_value = {'payment_confirmed': True, 'sales_account': '서병기',
        'product_name': '신발', 'sale_price': 69000, 'pickup_number': '056',
        'pickup_date': date(2026, 10, 30), 'paid_date': date(2026, 10, 29)}
    candidate = Candidate('서병기', 'room', '신발', peer_name='상대')
    chat = ChatEvidence(True, False, '신발', 69000, datetime(2026, 10, 29, 3, 6, tzinfo=timezone.utc))
    result = read_phone_order(phone, candidate, chat, today=date(2026, 10, 29))
    assert result['payment_after_cutoff_verified'] is True


def test_new_pickup_before_or_without_cutoff_proof_is_not_reserved():
    phone = Mock(unsafe=True)
    phone.verify_account.return_value = True
    phone.open_chat.return_value = True
    phone.progress.return_value = {'awaiting_pickup': True, 'payment_confirmed': True,
        'sales_account': '서병기', 'product_name': '신발', 'sale_price': 69000,
        'paid_date': date(2026, 10, 29)}
    candidate = Candidate('서병기', 'room', '신발', peer_name='상대')
    with pytest.raises(ValueError, match='기준 시각'):
        read_phone_order(phone, candidate, ChatEvidence(True, False, '신발', 69000), today=date(2026, 10, 29))
    phone.reserve_pickup.assert_not_called()
