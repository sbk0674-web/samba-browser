"""당근 폰에서 이미 예약된 주문을 읽거나, 검증 후 수거를 한 번 예약한다."""

from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse


def read_phone_order(phone, candidate, chat, *, today: date) -> dict:
    """phone은 잠금을 보유한 실제 기기여야 하며 실패한 확인은 모두 보류한다."""
    phone.assert_lock()
    phone.assert_connected()
    if phone.verify_account(candidate.account) is not True:
        raise ValueError('폰 계정 확인 실패')
    if not candidate.peer_name or phone.open_chat(candidate.peer_name, candidate.product_title, chat.sale_price) is not True:
        raise ValueError('폰 채팅 상품 확인 실패')
    source = phone.source_for(candidate, chat.sale_price)
    source = source if isinstance(source, dict) else {}
    url = source.get('source_url') or ''
    host = (urlparse(url).hostname or '').lower()
    is_musinsa = host == 'musinsa.com' or host.endswith('.musinsa.com')
    progress = phone.progress(candidate.account, candidate.product_title, chat.sale_price, today)
    if isinstance(progress, dict) and progress.get('awaiting_pickup') is True:
        if (progress.get('payment_confirmed') is not True or progress.get('sales_account') != candidate.account
                or progress.get('product_name') != candidate.product_title or progress.get('sale_price') != chat.sale_price):
            raise ValueError('예약 전 주문 정보 확인 실패')
        paid_date = progress.get('paid_date')
        cutoff_date = date(2026, 10, 29)
        event = chat.payment_event_at
        cutoff = datetime(2026, 10, 29, 10, tzinfo=timezone(timedelta(hours=9)))
        if (not isinstance(paid_date, date) or paid_date < cutoff_date or
                (paid_date == cutoff_date and (event is None or event.utcoffset() is None
                 or event.astimezone(timezone(timedelta(hours=9))) < cutoff
                 or event.astimezone(timezone(timedelta(hours=9))).date() != paid_date))):
            raise ValueError('예약 전 결제 기준 시각 확인 필요')
        selected = phone.reserve_pickup(is_musinsa=is_musinsa, today=today, location='문 앞')
        if not isinstance(selected, date):
            raise ValueError('수거 예약 결과 확인 필요')
        # 완료 응답이 불명확해도 다시 예약하지 않고 진행 현황을 먼저 읽는다.
        progress = phone.progress(candidate.account, candidate.product_title, chat.sale_price, today)
        if not isinstance(progress, dict) or progress.get('pickup_date') != selected:
            raise ValueError('수거 예약일 재확인 실패')
    if not isinstance(progress, dict):
        raise ValueError('주문 진행 현황 확인 실패')
    if (progress.get('payment_confirmed') is not True or progress.get('sales_account') != candidate.account
            or progress.get('product_name') != candidate.product_title or progress.get('sale_price') != chat.sale_price):
        raise ValueError('주문 정보 불일치')
    if is_musinsa:
        progress['source_url'] = url
    else:
        progress['source_site'] = '보유재고'
    if chat.payment_event_at is not None and chat.payment_event_at.utcoffset() is not None:
        event = chat.payment_event_at.astimezone(timezone(timedelta(hours=9)))
        progress['payment_after_cutoff_verified'] = (
            event >= datetime(2026, 10, 29, 10, tzinfo=timezone(timedelta(hours=9)))
            and event.date() == progress.get('paid_date')
        )
    return progress
