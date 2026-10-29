"""삼바 브라우저 당근 채팅 감지 경로. 본문이나 구매자 정보는 파일에 저장하지 않는다."""

from datetime import datetime

import httpx

from tools.daangn.collector import Candidate, ChatEvidence, SourceUnavailable


class ChatBridge:
    def __init__(self, url: str, token: str, *, accounts: set[str], client: httpx.Client | None = None):
        self._url = url.rstrip('/')
        self._token = token
        self._accounts = set(accounts)
        self._client = client or httpx.Client(timeout=15)

    def _request(self, method: str, path: str, **kwargs):
        response = self._client.request(method, self._url + path,
                                        headers={'X-Samba-Token': self._token}, **kwargs)
        if response.status_code != 200:
            raise SourceUnavailable(f'채팅 확인 실패 HTTP {response.status_code}')
        result = response.json()
        if not isinstance(result, dict) or result.get('ok') is not True:
            raise SourceUnavailable('채팅 확인 응답 오류')
        return result

    def candidates(self) -> list[Candidate]:
        result = self._request('GET', '/daangn/order-candidates')
        rows = result.get('candidates')
        if not isinstance(rows, list):
            raise SourceUnavailable('채팅 목록 확인 실패')
        candidates = []
        for row in rows:
            if not isinstance(row, dict) or row.get('accountLabel') not in self._accounts:
                continue
            aid, room, title = row.get('accountId'), row.get('roomId'), row.get('productTitle')
            if isinstance(aid, bool) or not isinstance(aid, int) or aid <= 0 or not isinstance(room, str) or not room or not isinstance(title, str) or not title:
                continue
            candidates.append(Candidate(account=row['accountLabel'], room_id=room, product_title=title,
                product_image=row.get('productThumb') if isinstance(row.get('productThumb'), str) else None,
                account_id=aid, peer_name=row.get('peerName') if isinstance(row.get('peerName'), str) else None,
                last_at=row.get('lastAt') if isinstance(row.get('lastAt'), int) else 0,
                preview_signal=row.get('previewSignal') if row.get('previewSignal') in ('pickup_request', 'pickup_scheduled', 'cancel', 'unknown') else 'unknown',
                last_at_precise=row.get('lastAtPrecise') is True))
        return candidates

    def inspect(self, candidate: Candidate) -> ChatEvidence:
        if candidate.account not in self._accounts or not candidate.account_id:
            raise ValueError('대상 계정 확인 필요')
        data = self._request('POST', '/daangn/inspect-sale',
                             json={'accountId': candidate.account_id, 'roomId': candidate.room_id})
        signal = data.get('signal')
        if not isinstance(signal, dict) or signal.get('ready') is not True or signal.get('productMatches') is not True:
            raise SourceUnavailable('채팅 상품 확인 실패')
        price = signal.get('salePrice')
        if isinstance(price, bool) or not isinstance(price, int) or price <= 0:
            raise SourceUnavailable('채팅 판매금액 확인 실패')
        event_time = None
        # 마지막 메시지는 구매자가 보낸 글일 수 있다. 결제 시각 증거로 쓰지 않는다.
        if signal.get('systemNotice') is True and isinstance(signal.get('paymentEventAt'), str):
            try:
                parsed = datetime.fromisoformat(signal['paymentEventAt'])
                if parsed.utcoffset() is not None:
                    event_time = parsed
            except ValueError:
                pass
        return ChatEvidence(payment_confirmed=signal.get('payment') is True,
                            cancelled=signal.get('cancelled') is True,
                            product_title=candidate.product_title, sale_price=price,
                            payment_event_at=event_time)
