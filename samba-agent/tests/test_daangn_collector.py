from datetime import date
import importlib.util
from pathlib import Path
from unittest.mock import Mock


spec = importlib.util.spec_from_file_location('daangn_collector', Path(__file__).parents[1] / 'tools/daangn/collector.py')
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def test_unconfirmed_chat_never_opens_phone():
    candidate = module.Candidate('서병기', 'room', '신발')
    phone, submit = Mock(), Mock()
    result = module.collect_candidate(candidate, inspect_chat=lambda _: module.ChatEvidence(False, False, '신발', 69000),
                                      inspect_phone=phone, submit=submit)
    assert result['status'] == 'skipped'
    phone.assert_not_called()
    submit.assert_not_called()


def test_phone_mismatch_never_saves():
    candidate = module.Candidate('서병기', 'room', '신발')
    submit = Mock()
    result = module.collect_candidate(candidate, inspect_chat=lambda _: module.ChatEvidence(True, False, '신발', 69000),
        inspect_phone=lambda *_: {'payment_confirmed': True, 'sales_account': '다른 계정',
                                  'product_name': '신발', 'sale_price': 69000,
                                  'pickup_number': '056', 'pickup_date': date(2026, 10, 30)}, submit=submit)
    assert result['status'] == 'held'
    submit.assert_not_called()


def test_matched_phone_order_is_submitted_with_representative_photo():
    candidate = module.Candidate('서병기', 'room', '신발', 'https://example.com/shoe.jpg')
    phone = {'payment_confirmed': True, 'sales_account': '서병기', 'product_name': '신발',
             'sale_price': 69000, 'pickup_number': '056', 'pickup_date': date(2026, 10, 30)}
    submit = Mock(return_value={'id': 'ord_1'})
    result = module.collect_candidate(candidate, inspect_chat=lambda _: module.ChatEvidence(True, False, '신발', 69000),
                                      inspect_phone=lambda *_: phone, submit=submit)
    assert result == {'status': 'saved', 'id': 'ord_1', 'pickup_number': '056'}
    assert submit.call_args.args[0]['product_image'] == candidate.product_image


def test_round_checks_sale_signals_first_and_stops_after_error():
    unknown = module.Candidate('서병기', 'unknown', '바지')
    pickup = module.Candidate('서병기', 'pickup', '신발', preview_signal='pickup_request')
    chat = Mock()
    chat.candidates.return_value = [unknown, pickup]
    chat.inspect.side_effect = module.SourceUnavailable('연결 실패')
    result = module.collect_round(chat=chat, inspect_phone=Mock(), submit=Mock(),
                                  already_done=lambda _: False, mark_done=Mock())
    assert result == [{'status': 'held', 'reason': '확인 또는 저장 실패'}]
    assert chat.inspect.call_count == 1
    assert chat.inspect.call_args.args[0].room_id == 'pickup'


def test_held_pickup_rooms_do_not_starve_other_new_orders():
    chat = Mock()
    chat.candidates.return_value = [
        module.Candidate('서병기', str(i), '신발', preview_signal='pickup_request')
        for i in range(15)
    ] + [module.Candidate('서병기', 'new', '신발')]
    chat.inspect.return_value = module.ChatEvidence(False, False, '신발', 69000)
    module.collect_round(chat=chat, inspect_phone=Mock(), submit=Mock(),
                         already_done=lambda _: False, mark_done=Mock(), limit=15)
    assert 'new' in [call.args[0].room_id for call in chat.inspect.call_args_list]
