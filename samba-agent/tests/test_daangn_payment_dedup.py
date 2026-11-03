from dataclasses import replace
from datetime import UTC, date, datetime, timedelta, timezone
from unittest.mock import Mock

import pytest

from tools.daangn import runtime
from tools.daangn.collector import Candidate, ChatEvidence, collect_candidate


@pytest.fixture
def case(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime, 'RECEIPTS', tmp_path)
    state = runtime.CollectionState(str(tmp_path / 'state.sqlite'))
    candidate = Candidate('서병기', 'room', '나이키 조거팬츠 M', last_at=100)
    chat = ChatEvidence(True, False, candidate.product_title, 17000,
                        datetime(2026, 10, 30, 6, 9, tzinfo=UTC))
    result = {'id': 'ord_saved', 'pickup_number': '366'}
    return state, candidate, chat, result


def test_saved_payment_survives_message_timestamp_change_and_timezone_display(case):
    state, candidate, chat, result = case
    state.mark(candidate, result, payment_event_at=chat.payment_event_at)
    newer = replace(candidate, last_at=999)
    same_chat = replace(chat, payment_event_at=chat.payment_event_at.astimezone(
        timezone(timedelta(hours=9))))
    assert not state.done(newer)
    assert state.done_payment(newer, same_chat)
    phone, submit = Mock(), Mock()
    response = collect_candidate(newer, inspect_chat=lambda _: same_chat,
                                 inspect_phone=phone, submit=submit, already_paid=state.done_payment)
    assert response['status'] == 'skipped'
    phone.assert_not_called()
    submit.assert_not_called()


def test_new_payment_in_same_room_is_not_silently_dropped(case):
    state, candidate, chat, result = case
    state.mark(candidate, result, payment_event_at=chat.payment_event_at)
    new_payment = replace(chat, payment_event_at=chat.payment_event_at + timedelta(days=1))
    assert not state.done_payment(replace(candidate, last_at=999), new_payment)
    assert not state.done_payment(replace(candidate, account='김귀옥'), chat)
    assert not state.done_payment(replace(candidate, room_id='another-room'), chat)


def test_legacy_saved_room_without_payment_proof_holds_before_phone(case):
    state, candidate, chat, result = case
    state.mark(candidate, result)
    phone = Mock()
    with pytest.raises(ValueError, match='결제'):
        collect_candidate(replace(candidate, last_at=999), inspect_chat=lambda _: chat,
                          inspect_phone=phone, submit=Mock(), already_paid=state.done_payment)
    phone.assert_not_called()


def test_legacy_exact_event_hit_promotes_only_room_receipt_not_an_invented_payment(case):
    state, candidate, chat, result = case
    # Simulate a pre-patch row: its one-way hash does not encode a recoverable room ID.
    import sqlite3
    with sqlite3.connect(state.path) as db:
        db.execute('INSERT INTO collected VALUES (?,?,?)',
                   (state.key(candidate), result['id'], result['pickup_number']))
    assert state.done(candidate)
    with pytest.raises(ValueError, match='결제'):
        state.done_payment(replace(candidate, last_at=999), chat)


def test_saved_room_with_missing_or_naive_payment_time_never_uses_last_at(case):
    state, candidate, chat, result = case
    state.mark(candidate, result, payment_event_at=chat.payment_event_at)
    for event in (None, chat.payment_event_at.replace(tzinfo=None)):
        with pytest.raises(ValueError, match='결제'):
            state.done_payment(replace(candidate, last_at=999), replace(chat, payment_event_at=event))


def test_failed_phone_search_cooldown_is_room_payment_based_not_last_message(case):
    _, candidate, chat, _ = case
    schedule = runtime.CandidateSchedule()
    assert schedule.claim_phone(candidate, chat, 100)
    assert not schedule.claim_phone(replace(candidate, last_at=999), chat, 115)
    assert schedule.claim_phone(candidate, replace(chat, payment_event_at=chat.payment_event_at + timedelta(days=1)), 116)
    assert schedule.claim_phone(candidate, chat, 400)


def test_successful_collection_persists_payment_before_changed_message_is_rechecked(case):
    state, candidate, chat, result = case
    candidate = replace(candidate, product_image='https://example.com/item.jpg')
    phone = Mock(return_value={
        'payment_confirmed': True, 'sales_account': candidate.account,
        'product_name': candidate.product_title, 'sale_price': chat.sale_price,
        'pickup_number': result['pickup_number'], 'pickup_date': date(2026, 11, 3),
    })
    submit = Mock(return_value={'id': result['id']})
    def record(c, evidence, saved):
        state.mark(c, saved, payment_event_at=evidence.payment_event_at)
    first = collect_candidate(candidate, inspect_chat=lambda _: chat, inspect_phone=phone,
                              submit=submit, already_paid=state.done_payment, on_saved_payment=record)
    assert first['status'] == 'saved'
    second = collect_candidate(replace(candidate, last_at=999), inspect_chat=lambda _: chat,
                               inspect_phone=phone, submit=submit, already_paid=state.done_payment,
                               on_saved_payment=record)
    assert second['status'] == 'skipped'
    assert phone.call_count == submit.call_count == 1


def test_failed_submission_does_not_mark_payment_saved(case):
    state, candidate, chat, result = case
    candidate = replace(candidate, product_image='https://example.com/item.jpg')
    record = Mock()
    with pytest.raises(ValueError):
        collect_candidate(candidate, inspect_chat=lambda _: chat,
            inspect_phone=lambda *_: {'payment_confirmed': True, 'sales_account': candidate.account,
                'product_name': candidate.product_title, 'sale_price': chat.sale_price,
                'pickup_number': result['pickup_number'], 'pickup_date': date(2026, 11, 3)},
            submit=lambda _: {}, on_saved_payment=record)
    record.assert_not_called()
    assert not state.done_payment(candidate, chat)
