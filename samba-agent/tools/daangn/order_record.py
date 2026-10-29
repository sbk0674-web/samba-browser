"""당근 화면에서 확인한 주문 정보를 삼바 주문 수집 형식으로 바꾼다."""

from datetime import date, datetime, timedelta, timezone
import math
import re
import xml.etree.ElementTree as ET
from urllib.parse import urlparse


def read_progress_evidence(xml: str) -> dict:
    """바로구매 진행 화면에서 결제 및 수거번호 증거만 읽는다."""
    root = ET.fromstring(xml)
    texts = [node.get("text", "").strip() for node in root.iter("node")]
    if "바로구매 진행 현황" not in texts:
        raise ValueError("바로구매 진행 화면 확인 필요")
    paid = [x for x in texts if re.fullmatch(r"결제완료\s*\d{1,2}월\s*\d{1,2}일\s*결제완료", x)]
    if len(paid) != 1:
        raise ValueError("결제완료 및 결제일 확인 필요")
    pickups = set()
    for i, text in enumerate(texts[:-1]):
        if text == "수거 번호":
            match = re.fullmatch(r"당근\s+(\d+)", texts[i + 1])
            if match:
                pickups.add(match.group(1))
    if len(pickups) != 1:
        raise ValueError("수거번호 확인 필요")
    if any(re.search(r"판매\s*취소\s*완료|거래\s*취소\s*완료|환불\s*완료", text) for text in texts):
        raise ValueError("취소된 거래 확인 필요")
    return {"payment_confirmed": True, "payment_date_text": paid[0],
            "pickup_number": pickups.pop()}


def read_pickup_date(xml: str, *, now: date) -> date:
    """진행 현황의 수거예정 날짜만 읽는다. 임의의 시각은 만들지 않는다."""
    root = ET.fromstring(xml)
    texts = [node.get("text", "").strip() for node in root.iter("node")]
    if "바로구매 진행 현황" not in texts:
        raise ValueError("바로구매 진행 화면 확인 필요")
    dates = set()
    for text in texts:
        m = re.fullmatch(r"(\d{1,2})월\s*(\d{1,2})일(?:\([월화수목금토일]\))?\s*수거\s*예정", text)
        if not m:
            continue
        month, day = map(int, m.groups())
        try:
            scheduled = date(now.year, month, day)
            if scheduled < now - timedelta(days=31):
                scheduled = date(now.year + 1, month, day)
        except ValueError:
            continue
        if now - timedelta(days=31) <= scheduled <= now + timedelta(days=31):
            dates.add(scheduled)
    if len(dates) != 1:
        raise ValueError("수거예정 날짜 확인 필요")
    return dates.pop()


def match_registered_order(xml: str, listing: dict, *, account: str) -> dict:
    """결제완료 화면을 같은 계정의 등록 상품과 대조한다."""
    evidence = read_progress_evidence(xml)
    title = str(listing.get("title") or "").strip()
    amount = listing.get("price")
    if (listing.get("status") != "published_verified"
            or listing.get("phone_owner") != account or not title
            or isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0):
        raise ValueError("계정 또는 등록 상품 확인 필요")
    root = ET.fromstring(xml)
    texts = [node.get("text", "").strip() for node in root.iter("node")]
    price_text = f"{amount:,}원"
    if texts.count(title) != 1 or price_text not in texts:
        raise ValueError("상품명 또는 판매금액 불일치")
    source_url = str(listing.get("source_url") or "").strip()
    source = urlparse(source_url)
    if source.scheme != "https" or not source.netloc:
        raise ValueError("원본 링크 확인 필요")
    return {**evidence, "sales_account": account, "product_name": title,
            "sale_price": amount, "source_url": source_url,
            "product_option": listing.get("size")}


def match_owned_order(xml: str, *, account: str, chat_title: str, chat_price: int,
                      product_image: str | None = None) -> dict:
    """채팅과 폰의 상품·금액이 정확히 같을 때 보유 재고 주문으로 묶는다."""
    if not account or not chat_title or isinstance(chat_price, bool) or not isinstance(chat_price, int) or chat_price <= 0:
        raise ValueError("계정 및 상품 확인 필요")
    evidence = read_progress_evidence(xml)
    texts = [node.get("text", "").strip() for node in ET.fromstring(xml).iter("node")]
    if texts.count(chat_title.strip()) != 1 or f"{chat_price:,}원" not in texts:
        raise ValueError("채팅과 폰의 상품명 또는 판매금액 불일치")
    result = {**evidence, "sales_account": account, "product_name": chat_title.strip(),
              "sale_price": chat_price, "source_site": "보유재고"}
    if product_image:
        url = urlparse(product_image)
        if url.scheme != "https" or not url.netloc:
            raise ValueError("상품 사진 주소 확인 필요")
        result["product_image"] = product_image
    return result


def build_submission(order: dict) -> dict:
    """결제 시각 또는 확인된 결제일과 기준 이후 증거가 있을 때 전송한다."""
    paid_at = order.get("paid_at")
    paid_date = order.get("paid_date")
    cutoff = datetime(2026, 10, 29, 10, tzinfo=timezone(timedelta(hours=9)))
    if paid_at is not None:
        if (order.get("payment_time_verified") is not True
                or not isinstance(paid_at, datetime) or paid_at.utcoffset() is None):
            raise ValueError("결제 시각 확인 필요")
        if paid_at < cutoff:
            raise ValueError("수집 시작 전 주문")
    elif (not isinstance(paid_date, date) or isinstance(paid_date, datetime)
          or paid_date < cutoff.date()
          or (paid_date == cutoff.date() and order.get("payment_after_cutoff_verified") is not True)):
        raise ValueError("결제 시각 또는 기준 이후 결제일 확인 필요")
    if order.get("payment_confirmed") is not True:
        raise ValueError("결제완료 확인 필요")
    if not str(order.get("pickup_number") or "").isdecimal():
        raise ValueError("수거번호 확인 필요")
    if not order.get("sales_account") or not order.get("product_name"):
        raise ValueError("계정 및 상품 확인 필요")
    amount = order.get("sale_price")
    if (isinstance(amount, bool) or not isinstance(amount, (int, float))
            or not math.isfinite(amount) or amount <= 0):
        raise ValueError("판매금액 확인 필요")
    data = {k: order[k] for k in ("pickup_number", "sales_account", "product_name",
            "sale_price", "payment_confirmed")}
    if paid_at is not None:
        data["paid_at"] = paid_at.isoformat()
    else:
        data["paid_date"] = paid_date.isoformat()
        data["payment_after_cutoff_verified"] = order.get("payment_after_cutoff_verified") is True
    pickup_date = order.get("pickup_date")
    if pickup_date is not None:
        if not isinstance(pickup_date, date) or isinstance(pickup_date, datetime):
            raise ValueError("수거일 확인 필요")
        data["pickup_date"] = pickup_date.isoformat()
    for key in ("product_option", "product_image", "source_url", "source_site"):
        if order.get(key):
            data[key] = order[key]
    return data


def submit_collected_order(client, order: dict) -> dict:
    """기존 삼바 하네스 인증 연결로 주문을 한 번 전송한다."""
    payload = build_submission(order)
    response_error = None
    try:
        result = client._request("POST", "/daangn/collected-orders", json=payload)
    except Exception as exc:
        status = getattr(exc, "status", None)
        if status is not None and status < 500:
            raise
        response_error = exc
        result = None
    if result is not None and (not isinstance(result, dict) or not result.get("id") or not isinstance(result.get("created"), bool)):
        raise ValueError("저장 결과 확인 필요")
    try:
        saved = client._request("GET", f"/daangn/collected-orders/{payload['pickup_number']}")
        same = (isinstance(saved, dict) and saved.get("id")
                and (result is None or saved.get("id") == result["id"])
                and saved.get("order_number") == f"당근 {payload['pickup_number']}"
                and saved.get("sales_account") == payload["sales_account"]
                and saved.get("product_name") == payload["product_name"]
                and (saved.get("product_option") or "") == (payload.get("product_option") or "")
                and saved.get("sale_price") == payload["sale_price"]
                and (datetime.fromisoformat(saved.get("paid_at") or "") == order["paid_at"]
                     if "paid_at" in payload else
                     datetime.fromisoformat(saved.get("paid_at") or "").astimezone(timezone(timedelta(hours=9))).date().isoformat() == payload["paid_date"])
                and all(saved.get(k) == payload[k] for k in ("source_url", "product_image") if k in payload))
        if "pickup_date" in payload:
            pickup_time = datetime.fromisoformat(saved.get("ship_by_at") or "")
            same = same and pickup_time.astimezone(timezone(timedelta(hours=9))).date().isoformat() == payload["pickup_date"]
    except Exception:
        if response_error is not None:
            raise response_error
        raise ValueError("저장 결과 재확인 실패") from None
    if not same:
        raise ValueError("저장된 주문 정보가 일치하지 않습니다")
    return result if result is not None else {"id": saved["id"], "created": False}


def make_order_record(order: dict, *, channel_id: str, tenant_id: str) -> dict:
    """결제와 수거가 확인된 주문만 변환한다. 없는 금액은 추정하지 않는다."""
    if order.get("payment_confirmed") is not True:
        raise ValueError("결제완료 확인 필요")
    required = ("pickup_number", "sales_account", "product_name", "paid_at")
    if any(not str(order.get(k) or "").strip() for k in required):
        raise ValueError("수거번호, 계정, 상품명, 결제일 확인 필요")
    if not channel_id or not tenant_id:
        raise ValueError("판매처와 테넌트 확인 필요")
    amount = order.get("sale_price")
    if (isinstance(amount, bool) or not isinstance(amount, (int, float))
            or not math.isfinite(amount) or amount <= 0):
        raise ValueError("판매금액 확인 필요")
    paid_at = order["paid_at"]
    if not isinstance(paid_at, datetime) or paid_at.utcoffset() is None:
        raise ValueError("시간대가 포함된 결제일 필요")
    pickup = str(order["pickup_number"]).strip()
    if not pickup.isdecimal():
        raise ValueError("수거번호 확인 필요")
    result = {
        "tenant_id": tenant_id,
        "channel_id": channel_id,
        "channel_name": "당근마켓",
        "source": "daangn",
        "order_number": f"당근 {pickup}",
        "sales_account": str(order["sales_account"]).strip(),
        "product_name": str(order["product_name"]).strip(),
        "sale_price": amount,
        "total_payment_amount": amount,
        "paid_at": paid_at,
        "payment_status": "completed",
        "notes": f"당근 수거번호: {pickup}",
    }
    for key in ("product_option", "product_image", "source_url", "source_site"):
        value = order.get(key)
        if value:
            if key in ("product_image", "source_url"):
                url = urlparse(str(value))
                if url.scheme not in ("http", "https") or not url.netloc:
                    raise ValueError(f"{key} 주소 확인 필요")
            result[key] = value
    return result
