from datetime import date, datetime, timezone
from unittest.mock import Mock

import httpx

from tools.daangn.chat_bridge import ChatBridge
from tools.daangn.collector import collect_round
from tools.daangn.order_record import submit_collected_order
from tools.daangn.phone_worker import read_phone_order
from tools.daangn.runtime import CollectionState


def test_chat_payment_to_pickup_to_idempotent_saved_order(tmp_path, monkeypatch):
    from tools.daangn import runtime
    monkeypatch.setattr(runtime, 'RECEIPTS', tmp_path)
    stamp = int(datetime(2026, 10, 29, 3, 6, tzinfo=timezone.utc).timestamp() * 1000)
    def handler(req):
        if req.method == 'GET':
            return httpx.Response(200, json={'ok': True, 'candidates': [{
                'accountId': 1, 'accountLabel': '서병기', 'roomId': 'room',
                'productTitle': '신발 230mm', 'peerName': '상대', 'lastAt': stamp,
                'productThumb': 'https://example.com/shoe.jpg',
                'lastAtPrecise': True, 'previewSignal': 'pickup_request'}]})
        return httpx.Response(200, json={'ok': True, 'signal': {'ready': True, 'payment': True,
            'cancelled': False, 'productMatches': True, 'salePrice': 69000, 'systemNotice': True,
            'paymentEventAt': '2026-10-29T12:06:00+09:00'}})
    chat = ChatBridge('http://127.0.0.1', 'test', accounts={'서병기'},
                      client=httpx.Client(transport=httpx.MockTransport(handler)))
    phone = Mock(unsafe=True)
    phone.verify_account.return_value = True
    phone.open_chat.return_value = True
    phone.source_for.return_value = {}
    phone.reserve_pickup.return_value = date(2026, 10, 30)
    phone.progress.side_effect = [
        {'awaiting_pickup': True, 'payment_confirmed': True, 'sales_account': '서병기',
         'product_name': '신발 230mm', 'sale_price': 69000, 'paid_date': date(2026, 10, 29)},
        {'payment_confirmed': True, 'sales_account': '서병기', 'product_name': '신발 230mm',
         'sale_price': 69000, 'pickup_number': '056', 'paid_date': date(2026, 10, 29),
         'pickup_date': date(2026, 10, 30)}]
    wave = Mock()
    wave._request.side_effect = [
        {'id': 'ord_test', 'created': True},
        {'id': 'ord_test', 'order_number': '당근 056', 'sales_account': '서병기',
         'product_name': '신발 230mm', 'sale_price': 69000,
         'paid_at': '2026-10-28T15:00:00+00:00', 'ship_by_at': '2026-10-29T15:00:00+00:00',
         'product_image': 'https://example.com/shoe.jpg'}]
    state = CollectionState(str(tmp_path / 'state.sqlite'))
    def run():
        return collect_round(chat=chat, inspect_phone=lambda candidate, evidence: read_phone_order(
            phone, candidate, evidence, today=date(2026, 10, 29)),
            submit=lambda data: submit_collected_order(wave, data),
            already_done=state.done, mark_done=state.mark)
    assert run() == [{'status': 'saved', 'id': 'ord_test', 'pickup_number': '056'}]
    assert run() == []
    assert phone.reserve_pickup.call_count == 1
    assert [call.args[0] for call in wave._request.call_args_list] == ['POST', 'GET']
