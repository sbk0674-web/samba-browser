# 淘宝 PC 구매 — 화면 해석(2026-10-08 실기 화면 그대로)
from samba_agent.ops.taobao_pc import cashier_charge, elements, find_id, shop_ok, submit_price

CASHIER = """URL: https://cashiersa127.alipay.com/business/cashiermain.htm?orderId=1
INTERACTIVE ELEMENTS:
[1] link "找人代付" href=https://shenghuo.alipay.com/x
[2] label "MasterCard ****8503 565.47元 含信用卡服务费（费率3.00%）：16.47元"
[3] radio "MasterCard****8503565.47元含信用卡服务费（费率3.00%）：16.47元" name=pay value="on"
[4] label "有效期"
[5] textbox "月/年" value=""
[6] label "安全码"
[7] textbox "安全码" value=""
[16] button "确认付款"
[17] clickable "确认付款"
"""

CONFIRM = """INTERACTIVE ELEMENTS:
[29] clickable "HUBNET-manol"
[40] link "后浪潮品奥莱折扣店"
[84] clickable "人民币"
[86] clickable "韩元KRW及其他币种"
[88] clickable "提交订单￥549"
"""


def test_입력칸은_value_가_붙어도_이름으로_찾고_같은_이름의_label_은_고르지_않는다():
    assert find_id(CASHIER, r'^月/年$', role='textbox') == 5
    assert find_id(CASHIER, r'^安全码$', role='textbox') == 7
    assert find_id(CASHIER, r'^安全码$') == 6  # role 없이 찾으면 label 이 먼저다
    assert find_id(CASHIER, r'^确认付款$', role='button') == 16
    assert (5, 'textbox', '月/年') in elements(CASHIER)


def test_결제대_카드_청구액과_주문_합계를_읽는다():
    assert cashier_charge(CASHIER) == 565.47
    assert submit_price(CONFIRM) == 549.0


def test_화이트리스트_가게가_화면에_있어야_한다():
    assert shop_ok(CONFIRM)
    assert not shop_ok(CONFIRM.replace('后浪潮品奥莱折扣店', '鞋之正义'))
