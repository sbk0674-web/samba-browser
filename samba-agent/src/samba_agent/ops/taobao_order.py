"""식화 주문 — 임성희폰 淘宝 앱으로 화이트리스트 가게에서 사고 알리페이 비밀번호는 앱 폰 결제 도구가 넣는다.

사용자 2026-10-08: "성공하면 이식하라고 몇 번 말했어". 사람이 한 순서(실기 A-SN241416500, 후랑차오 ¥214.2, 2026-10-07):
淘宝 검색(품번) → 가게가 화이트리스트인 상품 → 옵션창(색상=품번·사이즈) → 立即支付 → 주문 확인 화면
(결제수단을 支付宝(大陆版) 로, 개인정보 국경 간 전송 동의 체크) → 立即支付 → 알리페이 결제창 → phone_approve_payment
→ '支付成功' → 확인 → 我·待发货 의 주문번호.

식화가 알려 준 화이트리스트 가게(后浪潮品奥莱折扣店·品牌官方店) 말고는 절대 사지 않는다 — 가게 이름이 화면에서 읽히지
않으면 결제 전에 멈춘다(사용자: "식화에 나온 화이트리스트 타오바오에서 사야지 다른 판매처에서 사면 안된다").
원가·환율·카드 청구할인은 得物과 같다(dewu_order 의 상수·함수를 그대로 쓴다).
"""

import logging
import re
import time
from collections.abc import Callable

from samba_agent.ops.dewu_order import (
    ALIPAY,
    DewuOrderError,
    DewuResult,
    alipay_order_amount,
    order_no_after_label,
    size_cell,
)
from samba_agent.ops.ssg_gift_accept import Node, Phone, find_text, has_text

log = logging.getLogger(__name__)

TAOBAO = 'com.taobao.taobao'
# 식화 판매처 화이트리스트 중 淘宝 가게 — kream_shadow._SUP_ALLOW_NAMES 와 같아야 한다
ALLOWED_SHOPS = ('后浪潮品奥莱折扣店', '品牌官方店')
# 검색 결과 카드 4곳(왼쪽 위·오른쪽 위·왼쪽 아래·오른쪽 아래) — 실기 720x1600 화면 좌표
RESULT_CARDS = ((180, 400), (540, 400), (180, 1000), (540, 1000))
_CNY = re.compile(r'^[¥￥]\s*(\d+(?:\.\d+)?)$')


class TaobaoOrderError(DewuOrderError):
    """사람에게 넘길 사유 — DewuOrderError 와 같은 처리(paid·out_of_stock)."""


def _texts(nodes: list[Node]) -> list[str]:
    out: list[str] = []
    for n in nodes:
        for t in (n.text, n.desc):
            if t and t.strip():
                out.append(t.strip())
    return out


def shop_name_of(nodes: list[Node]) -> str | None:
    """화면에 보이는 가게 이름 중 화이트리스트에 있는 것. 없으면 None."""
    for t in _texts(nodes):
        for shop in ALLOWED_SHOPS:
            if shop in t:
                return shop
    return None


def total_price(nodes: list[Node]) -> float | None:
    """주문 확인 화면의 합계 위안 — '合计'·'实付款' 오른쪽/다음 줄의 ¥ 값, 없으면 맨 아래 큰 ¥ 값."""
    ordered = sorted(nodes, key=lambda n: (n.y, n.x))
    for i, n in enumerate(ordered):
        if any(k in n.text for k in ('合计', '实付款', '合計')):
            for m in ordered[i : i + 4]:
                found = _CNY.match(m.text.replace(' ', '').strip()) or re.match(
                    r'^(\d+(?:\.\d+)?)$', m.text.strip()
                )
                if found:
                    return float(found.group(1))
    prices = [float(m.group(1)) for n in ordered if (m := _CNY.match(n.text.replace(' ', '')))]
    return prices[-1] if prices else None


def buy_on_taobao(
    phone: Phone,
    model: str,
    size: str,
    *,
    max_cny: float,
    approve: Callable[[int], str],
    rate: float,
    sleep: Callable[[float], None] = time.sleep,
) -> DewuResult:
    """淘宝에서 model·size 를 화이트리스트 가게로 산다. 가게를 못 확인하거나 max_cny 를 넘으면 결제하지 않는다."""

    def wait_for(
        check: Callable[[list[Node]], bool], seconds: float, step: float = 1.5
    ) -> list[Node]:
        end = time.monotonic() + seconds
        nodes = phone.nodes()
        while not check(nodes) and time.monotonic() < end:
            sleep(step)
            nodes = phone.nodes()
        return nodes

    # 1) 검색 — 앱을 껐다 켜서 홈부터, 위 검색 막대로 들어가 품번을 친다
    phone._run('shell', 'am', 'force-stop', TAOBAO)
    sleep(1)
    phone.launch(TAOBAO)
    sleep(6)
    phone.tap(300, 390)
    sleep(2)
    phone._run('shell', 'input', 'keyevent', '123')
    phone._run('shell', 'input', 'keyevent', *(['67'] * 30))
    phone._run('shell', 'input', 'text', re.sub(r'[^A-Za-z0-9-]', '', model))
    sleep(1)
    phone.key('66')
    sleep(7)
    if phone.top_package() != TAOBAO:
        raise TaobaoOrderError('淘宝 앱이 앞에 없다 — 검색 못 함(결제 전)')

    # 2) 결과 카드를 차례로 열어 가게 이름이 화이트리스트인 상품만 고른다
    opened = False
    seen_shops: list[str] = []
    for x, y in RESULT_CARDS:
        phone.tap(x, y)
        sleep(6)
        nodes = phone.nodes()
        shop = shop_name_of(nodes)
        if shop is not None:
            opened = True
            break
        seen_shops.append('?')
        phone.key('4')
        sleep(3)
    if not opened:
        raise TaobaoOrderError(
            f'淘宝 검색 결과 {len(seen_shops)}곳에서 화이트리스트 가게({"·".join(ALLOWED_SHOPS)})를 화면에서 못 찾았다 — 결제하지 않음'
        )

    # 3) 옵션창(색상=품번·사이즈) — 글자로 찾아 누른다. 못 찾으면 멈춘다
    phone.tap(595, 1455)
    sleep(3)
    nodes = phone.nodes()
    color = find_text(nodes, model)
    if color is not None:
        phone.tap(color.x, color.y)
        sleep(2)
        nodes = phone.nodes()
    cell = size_cell(nodes, size)
    if cell is None:
        raise TaobaoOrderError(f'淘宝 옵션창에서 사이즈 {size} 칸을 못 찾았다 — 결제하지 않음')
    phone.tap(cell.x, cell.y)
    sleep(2)
    nodes = phone.nodes()
    if has_text(nodes, '缺货') or has_text(nodes, '无货'):
        raise TaobaoOrderError(
            f'淘宝 사이즈 {size} 품절 표시 — 결제하지 않음(재고 확인)', out_of_stock=True
        )

    # 4) 立即支付 → 주문 확인 화면: 가게·합계·배송지를 확인한다
    pay = find_text(nodes, '立即支付') or find_text(nodes, '立即购买')
    if pay is not None:
        phone.tap(pay.x, pay.y)
    else:
        phone.tap(360, 1442)
    sleep(5)
    nodes = phone.nodes()
    shop2 = shop_name_of(nodes)
    if shop2 is None:
        raise TaobaoOrderError(
            '淘宝 주문 확인 화면에서 화이트리스트 가게 이름을 못 읽었다 — 결제하지 않음'
        )
    if not has_text(nodes, 'HUBNET'):
        raise TaobaoOrderError('淘宝 배송지가 HUBNET 배대지가 아니다 — 결제하지 않음')
    price = total_price(nodes)
    if price is None:
        raise TaobaoOrderError('淘宝 주문 확인 화면의 합계를 못 읽었다 — 결제하지 않음')
    if price > max_cny:
        raise TaobaoOrderError(
            f'淘宝 합계 ¥{price:g} 가 상한 ¥{max_cny:.0f} 을 넘는다 — 결제하지 않음(마진)'
        )

    # 5) 결제수단 = 支付宝(大陆版) — '更多支付方式' 로 열어 글자로 고른다, 개인정보 국경 간 전송 동의 체크
    if '支付宝' not in ' '.join(_texts(nodes)):
        more = find_text(nodes, '更多支付方式')
        if more is not None:
            phone.tap(more.x, more.y)
            sleep(2.5)
            nodes = phone.nodes()
    ali = next((n for n in nodes if '支付宝' in n.text and '大陆' in n.text), None) or next(
        (n for n in nodes if '支付宝' in n.text and len(n.text.strip()) <= 12), None
    )
    if ali is None:
        raise TaobaoOrderError('淘宝 결제수단에서 支付宝 를 못 찾았다 — 결제하지 않음')
    phone.tap(ali.x, ali.y)
    sleep(2.5)
    nodes = phone.nodes()
    consent = next(
        (n for n in nodes if any(k in n.text for k in ('同意', '跨境')) and n.y > 1100), None
    )
    if consent is not None:
        phone.tap(46, consent.y)
        sleep(1)
        nodes = phone.nodes()
    go = find_text(nodes, '立即支付')
    phone.tap(go.x, go.y) if go is not None else phone.tap(360, 1461)
    end = time.monotonic() + 20
    while phone.top_package() != ALIPAY and time.monotonic() < end:
        sleep(1.5)
    if phone.top_package() != ALIPAY:
        raise TaobaoOrderError('알리페이 결제창이 안 떴다(결제 전)')

    # 6) 결제창이 청구하려는 금액을 비밀번호 전에 확인한다
    charge = alipay_order_amount(phone.nodes())
    if charge is None:
        raise TaobaoOrderError('알리페이 결제창의 주문금액을 못 읽었다 — 결제하지 않음')
    if charge > max_cny:
        raise TaobaoOrderError(
            f'알리페이 결제창 금액 ¥{charge:g} 이 상한 ¥{max_cny:.0f} 을 넘는다 — 결제하지 않음(마진)'
        )
    if charge > price * 1.02 + 1:
        raise TaobaoOrderError(
            f'알리페이 결제창 금액 ¥{charge:g} 이 주문 확인 합계 ¥{price:g} 과 다르다 — 결제하지 않음'
        )
    out = approve(round(price * 1.03 * rate)).strip()
    if not out.startswith('ok'):
        raise TaobaoOrderError(f'알리페이 결제 승인 실패: {out[:80]}')
    nodes = wait_for(lambda ns: has_text(ns, '支付成功'), 25)
    if not has_text(nodes, '支付成功'):
        raise DewuOrderError(
            '알리페이 완료 화면(支付成功)이 안 보인다 — 淘宝 주문내역 확인(재결제 금지)', paid=True
        )
    amounts = [float(n.text) for n in nodes if re.fullmatch(r'\d+\.\d{2}', n.text)]
    paid_cny = amounts[0] if amounts else round(price * 1.03, 2)
    done = find_text(nodes, '완료') or find_text(nodes, '完成')
    if done is not None:
        phone.tap(done.x, done.y)
        sleep(3)
    order_no = latest_taobao_order_no(phone, sleep)
    if order_no is None:
        raise DewuOrderError(
            f'결제는 됐는데(¥{paid_cny}) 淘宝 주문번호를 못 읽었다 — 주문내역 확인', paid=True
        )
    return DewuResult(order_no=order_no, paid_cny=paid_cny, item_cny=price, rate=rate)


def latest_taobao_order_no(phone: Phone, sleep: Callable[[float], None]) -> str | None:
    """결제 완료 뒤 → 我 → 待发货 첫 주문 상세의 '订单编号' 숫자."""
    for _ in range(6):
        nodes = phone.nodes()
        pending = next((n for n in nodes if n.text.strip().startswith('待发货')), None)
        if pending is not None:
            phone.tap(pending.x, pending.y)
            sleep(3)
            break
        mine = find_text(nodes, '我的淘宝')
        if mine is not None:
            phone.tap(mine.x, mine.y)
            sleep(3)
            continue
        phone.key('4')
        sleep(1.5)
    nodes = phone.nodes()
    first = next((n for n in sorted(nodes, key=lambda n: n.y) if '实付款' in n.text), None)
    if first is None:
        return None
    phone.tap(360, max(first.y - 40, 300))
    sleep(3)
    for _ in range(8):
        found = order_no_after_label(phone.nodes())
        if found:
            phone.key('4')
            return found
        phone._run('shell', 'input', 'swipe', '360', '1200', '360', '800', '300')
        sleep(1)
    return None
