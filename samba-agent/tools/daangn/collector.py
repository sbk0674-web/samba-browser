"""당근 채팅 신호와 폰의 결제·상품 증거를 대조해 주문 수집에 전달한다.

채팅 미리보기나 거래완료 문구만으로는 저장하지 않는다. 연결 실패·모호한
증거는 보류하며, 저장 응답이 불명확한 경우 재전송은 submit 쪽에서 막는다.
"""

from dataclasses import dataclass
from datetime import date, datetime
from typing import Callable


class SourceUnavailable(RuntimeError):
    """사이트·브릿지 실패는 이번 회차의 다른 방 접근도 중단한다."""


@dataclass(frozen=True)
class Candidate:
    account: str
    room_id: str
    product_title: str
    product_image: str | None = None
    account_id: int | None = None
    # 폰에서 해당 채팅을 찾는 데만 사용하며 기록하지 않는다.
    peer_name: str | None = None
    last_at: int = 0
    preview_signal: str = 'unknown'
    last_at_precise: bool = False


@dataclass(frozen=True)
class ChatEvidence:
    payment_confirmed: bool
    cancelled: bool
    product_title: str
    sale_price: int
    payment_event_at: datetime | None = None


def collect_candidate(candidate: Candidate, *, inspect_chat: Callable,
                      inspect_phone: Callable, submit: Callable) -> dict:
    """한 채팅을 처리한다. 폰 접근과 저장은 해당 증거가 모두 맞을 때만 한다."""
    if not candidate.account or not candidate.room_id or not candidate.product_title:
        raise ValueError('계정과 채팅 상품 확인 필요')
    chat = inspect_chat(candidate)
    if not isinstance(chat, ChatEvidence) or not chat.payment_confirmed or chat.cancelled:
        return {'status': 'skipped'}
    if (chat.product_title != candidate.product_title or isinstance(chat.sale_price, bool)
            or not isinstance(chat.sale_price, int) or chat.sale_price <= 0):
        return {'status': 'held', 'reason': '채팅 상품 확인 실패'}

    # inspect_phone 은 공유 잠금·연결·계정 확인 뒤에만 폰을 열고,
    # 수거일이 없을 때 무신사 상품은 가장 늦은 날, 보유 재고는 가장 빠른 날을 예약한다.
    phone = inspect_phone(candidate, chat)
    if not isinstance(phone, dict) or phone.get('payment_confirmed') is not True:
        return {'status': 'held', 'reason': '폰 결제 확인 실패'}
    if (phone.get('sales_account') != candidate.account
            or phone.get('product_name') != candidate.product_title
            or phone.get('sale_price') != chat.sale_price
            or not str(phone.get('pickup_number') or '').isdecimal()
            or not isinstance(phone.get('pickup_date'), date)):
        return {'status': 'held', 'reason': '폰 주문 정보 불일치'}
    # 감지 시각은 결제 시각이 아니다. build_submission 의 검증을 통과해야 한다.
    if candidate.product_image and not phone.get('product_image'):
        phone = {**phone, 'product_image': candidate.product_image}
    result = submit(phone)
    if not isinstance(result, dict) or not result.get('id'):
        raise ValueError('저장 결과 확인 필요')
    return {'status': 'saved', 'id': result['id'], 'pickup_number': phone['pickup_number']}


def collect_round(*, chat, inspect_phone: Callable, submit: Callable,
                  already_done: Callable, mark_done: Callable, limit: int = 15, offset: int = 0) -> list[dict]:
    """계정별 채팅을 확인한다. 실패한 건은 재전송하지 않고 다음 주기에 다시 확인한다."""
    if not 1 <= limit <= 50:
        raise ValueError('한 번에 확인할 채팅 수가 잘못됐습니다')
    candidates = chat.candidates()
    # 신호가 드러난 방을 먼저 확인한다. 일반 메시지로 덮인 방도 본문 확인 대상이다.
    urgent = sorted((c for c in candidates if c.preview_signal in ('pickup_request', 'pickup_scheduled')), key=lambda c: -c.last_at)
    ordinary = sorted((c for c in candidates if c.preview_signal not in ('pickup_request', 'pickup_scheduled')), key=lambda c: -c.last_at)
    if urgent:
        start = offset % len(urgent)
        urgent = urgent[start:] + urgent[:start]
    if ordinary:
        start = offset % len(ordinary)
        ordinary = ordinary[start:] + ordinary[:start]
    # 보류된 수거 안내가 많아도 일반 메시지에 가려진 새 주문을 확인한다.
    budget = max(1, limit * 2 // 3) if ordinary else limit
    candidates = urgent[:budget] + ordinary + urgent[budget:]
    results = []
    for candidate in candidates:
        if len(results) >= limit:
            break
        if already_done(candidate):
            continue
        try:
            result = collect_candidate(candidate, inspect_chat=chat.inspect,
                                       inspect_phone=inspect_phone, submit=submit)
            if result['status'] == 'saved':
                mark_done(candidate, result)
            results.append(result)
        except SourceUnavailable:
            results.append({'status': 'held', 'reason': '확인 또는 저장 실패'})
            break
        except (RuntimeError, ValueError, OSError):
            # 한 폰의 연결 문제는 다른 계정 주문을 막지 않는다.
            results.append({'status': 'held', 'reason': '폰 또는 주문 확인 실패'})
    return results
