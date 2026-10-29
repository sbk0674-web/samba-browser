from datetime import date, datetime, timezone
import importlib.util
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location(
    "daangn_order_record", Path(__file__).parents[1] / "tools/daangn/order_record.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_paid_order_keeps_pickup_and_does_not_invent_costs():
    record = module.make_order_record(
        {"payment_confirmed": True, "pickup_number": "953", "sales_account": "임귀태",
         "product_name": "나이키 재킷", "product_option": "XS", "sale_price": 27000,
         "paid_at": datetime(2026, 10, 28, tzinfo=timezone.utc),
         "source_url": "https://www.musinsa.com/products/6936295"},
        channel_id="account", tenant_id="tenant",
    )
    assert record["order_number"] == "당근 953"
    assert record["sales_account"] == "임귀태"
    assert "수거번호" in record["notes"]
    assert all(k not in record for k in ("cost", "revenue", "shipping_fee", "fee_rate"))


@pytest.mark.parametrize("change", [
    {"payment_confirmed": False}, {"pickup_number": ""}, {"sale_price": 0},
    {"paid_at": datetime(2026, 10, 28)}, {"source_url": "javascript:alert(1)"},
    {"sale_price": float("nan")}, {"sale_price": float("inf")},
])
def test_incomplete_or_unsafe_order_is_rejected(change):
    order = {"payment_confirmed": True, "pickup_number": "136", "sales_account": "서병기",
             "product_name": "바지", "sale_price": 34000,
             "paid_at": datetime(2026, 10, 28, tzinfo=timezone.utc)}
    order.update(change)
    with pytest.raises(ValueError):
        module.make_order_record(order, channel_id="account", tenant_id="tenant")


def test_progress_evidence_requires_explicit_payment_and_pickup():
    xml = ('<hierarchy><node text="바로구매 진행 현황"/><node text="수거 번호"/>'
           '<node text="당근 953"/><node text="결제완료10월 28일 결제완료"/></hierarchy>')
    result = module.read_progress_evidence(xml)
    assert result["pickup_number"] == "953"
    assert result["payment_confirmed"] is True
    with pytest.raises(ValueError):
        module.read_progress_evidence(xml.replace("결제완료10월 28일 결제완료", "판매완료"))


def test_progress_reads_actual_pickup_date_and_refuses_cancellation():
    xml = ('<hierarchy><node text="바로구매 진행 현황"/><node text="수거 번호"/>'
           '<node text="당근 056"/><node text="결제완료10월 29일 결제완료"/>'
           '<node text="10월 30일(금) 수거 예정"/></hierarchy>')
    assert module.read_pickup_date(xml, now=date(2026, 10, 29)) == date(2026, 10, 30)
    with pytest.raises(ValueError, match="취소"):
        module.read_progress_evidence(xml.replace('</hierarchy>', '<node text="판매 취소 완료"/></hierarchy>'))


def test_progress_links_only_the_exact_registered_item_and_amount():
    xml = ('<hierarchy><node text="바로구매 진행 현황"/><node text="수거 번호"/>'
           '<node text="당근 953"/><node text="결제완료10월 28일 결제완료"/>'
           '<node text="나이키 나일론/코치 재킷 XS"/><node text="27,000원"/></hierarchy>')
    record = module.match_registered_order(xml, {
        "title": "나이키 나일론/코치 재킷 XS", "price": 27000,
        "phone_owner": "임귀태", "source_url": "https://www.musinsa.com/products/6936295",
        "status": "published_verified", "size": "XS",
    }, account="임귀태")
    assert record["pickup_number"] == "953"
    assert record["sale_price"] == 27000
    assert record["source_url"] == "https://www.musinsa.com/products/6936295"
    with pytest.raises(ValueError):
        module.match_registered_order(xml, {"title": "다른 상품", "price": 27000,
          "phone_owner": "임귀태", "status": "published_verified"}, account="임귀태")


def test_owned_stock_requires_exact_chat_and_phone_match():
    xml = ('<hierarchy><node text="바로구매 진행 현황"/><node text="수거 번호"/>'
           '<node text="당근 056"/><node text="결제완료10월 29일 결제완료"/>'
           '<node text="뉴발란스 신발 230mm"/><node text="69,000원"/></hierarchy>')
    data = module.match_owned_order(xml, account="서병기", chat_title="뉴발란스 신발 230mm",
                                   chat_price=69000, product_image="https://example.com/image.jpg")
    assert data["pickup_number"] == "056"
    assert data["source_site"] == "보유재고"
    with pytest.raises(ValueError, match="불일치"):
        module.match_owned_order(xml, account="서병기", chat_title="다른 신발", chat_price=69000)


def test_cutoff_requires_explicit_payment_time():
    xml = ('<hierarchy><node text="바로구매 진행 현황"/><node text="수거 번호"/>'
           '<node text="당근 136"/><node text="결제완료10월 29일 결제완료"/></hierarchy>')
    result = module.read_progress_evidence(xml)
    assert result.get("paid_at") is None


def test_submission_refuses_order_without_proven_payment_time():
    with pytest.raises(ValueError, match="결제 시각"):
        module.build_submission({"payment_confirmed": True, "pickup_number": "136",
                                 "sales_account": "서병기", "product_name": "상품",
                                 "sale_price": 34000})


def test_date_only_submission_requires_cutoff_proof():
    order = {"payment_confirmed": True, "pickup_number": "056", "sales_account": "서병기",
             "product_name": "상품", "sale_price": 69000, "paid_date": date(2026, 10, 29)}
    with pytest.raises(ValueError, match="기준 이후"):
        module.build_submission(order)
    result = module.build_submission({**order, "payment_after_cutoff_verified": True})
    assert result["paid_date"] == "2026-10-29"
    assert "paid_at" not in result


def test_date_only_submit_checks_saved_date_without_assuming_time():
    from unittest.mock import Mock
    order = {"payment_confirmed": True, "pickup_number": "056", "sales_account": "서병기",
             "product_name": "상품", "sale_price": 69000, "paid_date": date(2026, 10, 29),
             "payment_after_cutoff_verified": True}
    client = Mock()
    client._request.side_effect = [{"id": "ord_saved", "created": True},
        {"id": "ord_saved", "order_number": "당근 056", "sales_account": "서병기",
         "product_name": "상품", "sale_price": 69000, "paid_at": "2026-10-28T15:00:00+00:00"}]
    assert module.submit_collected_order(client, order)["id"] == "ord_saved"


def test_submit_uses_existing_internal_api_without_customer_details():
    from unittest.mock import Mock
    client = Mock()
    client._request.side_effect = [{"id": "ord_existing", "created": False},
        {"id": "ord_existing", "order_number": "당근 136", "sales_account": "서병기",
         "product_name": "상품", "sale_price": 34000, "paid_at": "2026-10-29T01:01:00+00:00"}]
    item = {"payment_confirmed": True, "payment_time_verified": True,
            "pickup_number": "136", "sales_account": "서병기", "product_name": "상품",
            "sale_price": 34000, "paid_at": datetime(2026, 10, 29, 1, 1, tzinfo=timezone.utc)}
    assert module.submit_collected_order(client, item)["id"] == "ord_existing"
    args, kwargs = client._request.call_args_list[0]
    assert args == ("POST", "/daangn/collected-orders")
    assert "customer_address" not in kwargs["json"]
    assert client._request.call_args_list[1].args == ("GET", "/daangn/collected-orders/136")


def test_unknown_submit_response_checks_saved_order_without_resubmitting():
    from unittest.mock import Mock
    class Unknown(Exception):
        status = None
    item = {"payment_confirmed": True, "payment_time_verified": True,
            "pickup_number": "136", "sales_account": "서병기", "product_name": "상품",
            "sale_price": 34000, "paid_at": datetime(2026, 10, 29, 1, 1, tzinfo=timezone.utc)}
    client = Mock()
    client._request.side_effect = [Unknown(), {"id": "ord_existing", "order_number": "당근 136",
        "sales_account": "서병기", "product_name": "상품", "sale_price": 34000,
        "paid_at": "2026-10-29T01:01:00+00:00"}]
    assert module.submit_collected_order(client, item) == {"id": "ord_existing", "created": False}
    assert [c.args[0] for c in client._request.call_args_list] == ["POST", "GET"]
