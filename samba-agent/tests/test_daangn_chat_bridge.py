import httpx
import pytest
from datetime import datetime, timezone

from tools.daangn.chat_bridge import ChatBridge
from tools.daangn.collector import collect_candidate


def test_logged_account_candidates_are_inspected_without_sending_chat_messages():
    calls = []
    def handler(req):
        calls.append((req.method, req.url.path))
        assert req.headers['X-Samba-Token'] == 'test'
        if req.url.path.endswith('order-candidates'):
            return httpx.Response(200, json={'ok': True, 'candidates': [
                {'accountId': 1, 'accountLabel': '서병기', 'roomId': 'room',
                 'productTitle': '신발 230mm', 'productThumb': 'https://example.com/a.jpg', 'peerName': '상대'},
                {'accountId': 2, 'accountLabel': '다른 계정', 'roomId': 'other', 'productTitle': '상품'}]})
        return httpx.Response(200, json={'ok': True, 'signal': {'ready': True, 'payment': True,
            'cancelled': False, 'productMatches': True, 'salePrice': 69000}})
    bridge = ChatBridge('http://127.0.0.1', 'test', accounts={'서병기'},
                        client=httpx.Client(transport=httpx.MockTransport(handler)))
    candidates = bridge.candidates()
    assert len(candidates) == 1
    chat = bridge.inspect(candidates[0])
    assert chat.payment_confirmed and chat.sale_price == 69000
    result = collect_candidate(candidates[0], inspect_chat=lambda _: chat,
        inspect_phone=lambda *_: None, submit=lambda _: pytest.fail('불명확한 폰 주문은 저장 금지'))
    assert result['status'] == 'held'
    assert calls == [('GET', '/daangn/order-candidates'), ('POST', '/daangn/inspect-sale')]


def test_missing_live_bridge_stops_without_retry():
    calls = []
    def handler(req):
        calls.append(req)
        return httpx.Response(404)
    bridge = ChatBridge('http://127.0.0.1', 'test', accounts={'서병기'},
                        client=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(RuntimeError, match='404'):
        bridge.candidates()
    assert len(calls) == 1


def test_last_message_time_never_proves_payment_notice_time():
    timestamp = int(datetime(2026, 10, 29, 3, 6, tzinfo=timezone.utc).timestamp() * 1000)
    def handler(req):
        if req.method == 'GET':
            return httpx.Response(200, json={'ok': True, 'candidates': [{
                'accountId': 1, 'accountLabel': '서병기', 'roomId': 'room',
                'productTitle': '신발', 'peerName': '상대', 'lastAt': timestamp,
                'lastAtPrecise': True, 'previewSignal': 'pickup_request'}]})
        return httpx.Response(200, json={'ok': True, 'signal': {'ready': True, 'payment': True,
            'cancelled': False, 'productMatches': True, 'salePrice': 69000, 'systemNotice': True}})
    bridge = ChatBridge('http://127.0.0.1', 'test', accounts={'서병기'},
                        client=httpx.Client(transport=httpx.MockTransport(handler)))
    evidence = bridge.inspect(bridge.candidates()[0])
    assert evidence.payment_event_at is None
