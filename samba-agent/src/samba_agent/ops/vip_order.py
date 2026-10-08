"""식화 唯品会(VIP) 최저가 주문 — 임성희폰 唯品会 앱으로 산다. 알리페이 비밀번호는 앱 폰 결제 도구가 넣는다.

2026-10-06 실기 성공 순서(A-SW241631819 조던 IB7256-010, vipshop-app-flow 메모리):
검색창(360,95) → 품번 입력 → 搜索(642,93) → 상품 → 사이즈 → '特卖价 抢'(장바구니 담김) → 购物车(207,1431) → 结算(557,1445)
→ 确认订单(支付宝 기본) → 支付宝支付(534,1441) → 알리페이 결제창(국제카드 수수료 3%, Mastercard 8503)
→ phone_approve_payment(provider alipay) → 支付成功 → 查看订单에서 订单编号.
사용자 2026-10-08: "VIP 언제 사람 구매하기로 했어, 지난번에 네가 샀잖아 — 이식 안 했냐".

안전: 확인 화면 배송지 HUBNET, 결제창 주문금액이 상한·상품가와 맞을 때만 비밀번호. 글자로 찾고, 못 찾으면 실기 좌표.
"""

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

VIP = 'com.achievo.vipshop'
_CNY = re.compile(r'[¥￥]\s*(\d+(?:\.\d+)?)')


def _texts(nodes: list[Node]) -> str:
    return ' '.join(f'{n.text or ""} {n.desc or ""}' for n in nodes)


def _tap_text(phone: Phone, nodes: list[Node], word: str, fallback: tuple[int, int] | None) -> bool:
    hit = find_text(nodes, word) or next(
        (n for n in nodes if word in (n.text or n.desc or '')), None
    )
    if hit is not None:
        phone.tap(hit.x, hit.y)
        return True
    if fallback is not None:
        phone.tap(*fallback)
        return True
    return False


def confirm_total(nodes: list[Node]) -> float | None:
    """确认订单 화면의 실付/合计 금액 — 라벨 뒤 첫 ¥ 값, 없으면 화면 아래쪽 ¥ 값."""
    ordered = sorted(nodes, key=lambda n: (n.y, n.x))
    for i, n in enumerate(ordered):
        t = f'{n.text or ""} {n.desc or ""}'
        if any(k in t for k in ('实付', '合计', '应付')):
            for m in ordered[i : i + 4]:
                found = _CNY.search(f'{m.text or ""} {m.desc or ""}')
                if found:
                    return float(found.group(1))
    prices = [
        float(f.group(1)) for n in ordered if (f := _CNY.search(f'{n.text or ""} {n.desc or ""}'))
    ]
    return prices[-1] if prices else None


def buy_on_vip(
    phone: Phone,
    model: str,
    eu_size: str,
    *,
    max_cny: float,
    approve: Callable[[int], str],
    rate: float,
    sleep: Callable[[float], None] = time.sleep,
) -> DewuResult:
    """唯品会 앱에서 model 의 eu_size 를 산다. 상한을 넘거나 화면이 다르면 결제하지 않는다."""

    def wait_for(check: Callable[[list[Node]], bool], seconds: float) -> list[Node]:
        end = time.monotonic() + seconds
        nodes = phone.nodes()
        while not check(nodes) and time.monotonic() < end:
            sleep(1.5)
            nodes = phone.nodes()
        return nodes

    # 1) 검색
    phone._run('shell', 'am', 'force-stop', VIP)
    sleep(1)
    phone.launch(VIP)
    sleep(7)
    phone.tap(360, 95)
    sleep(2)
    phone._run('shell', 'input', 'keyevent', '123')
    phone._run('shell', 'input', 'keyevent', *(['67'] * 30))
    phone._run('shell', 'input', 'text', re.sub(r'[^A-Za-z0-9-]', '', model))
    sleep(1)
    _tap_text(phone, phone.nodes(), '搜索', (642, 93))
    nodes = wait_for(lambda ns: bool(_CNY.search(_texts(ns))), 15)
    if not _CNY.search(_texts(nodes)):
        raise DewuOrderError(f'唯品会 검색 결과에 {model} 상품이 없다(결제 전)')
    # 2) 첫 상품 — 이름에 품번이 든 카드를 우선
    key = re.sub(r'[^A-Z0-9]', '', model.upper())
    card = next(
        (
            n
            for n in nodes
            if key and key in re.sub(r'[^A-Z0-9]', '', (n.text or n.desc or '').upper())
        ),
        None,
    )
    if card is None:
        card = next(
            (
                n
                for n in sorted(nodes, key=lambda n: (n.y, n.x))
                if n.y > 300 and _CNY.search(n.text or '')
            ),
            None,
        )
    if card is None:
        raise DewuOrderError('唯品会 검색 결과에서 상품 카드를 못 찾았다(결제 전)')
    phone.tap(card.x, card.y)
    nodes = wait_for(
        lambda ns: has_text(ns, '抢') or has_text(ns, '加入购物车') or has_text(ns, '立即购买'), 15
    )
    # 3) 사이즈 → 장바구니(特卖价 抢)
    buy_btn = next(
        (n for n in nodes if '抢' in (n.text or '') or '加入购物车' in (n.text or '')), None
    )
    if buy_btn is None:
        raise DewuOrderError('唯品会 상품 화면에서 구매 버튼(抢·加入购物车)을 못 찾았다(결제 전)')
    phone.tap(buy_btn.x, buy_btn.y)
    sleep(2.5)
    nodes = wait_for(lambda ns: size_cell(ns, eu_size) is not None or has_text(ns, '已抢光'), 10)
    if has_text(nodes, '已抢光'):
        raise DewuOrderError(f'唯品会 사이즈 {eu_size} 已抢光(품절 표시) — 결제하지 않음')
    cell = size_cell(nodes, eu_size)
    if cell is None:
        raise DewuOrderError(f'唯品会 사이즈 목록에 {eu_size} 가 없다(결제 전)')
    phone.tap(cell.x, cell.y)
    sleep(1.5)
    nodes = phone.nodes()
    confirm = next(
        (
            n
            for n in sorted(nodes, key=lambda n: -n.y)
            if any(k in (n.text or '') for k in ('确定', '抢', '加入购物车'))
        ),
        None,
    )
    if confirm is not None:
        phone.tap(confirm.x, confirm.y)
        sleep(3)
    # 4) 购物车 → 结算
    _tap_text(phone, phone.nodes(), '购物车', (207, 1431))
    sleep(4)
    _tap_text(phone, phone.nodes(), '结算', (557, 1445))
    nodes = wait_for(lambda ns: has_text(ns, '确认订单') or has_text(ns, '支付宝支付'), 15)
    texts = _texts(nodes)
    if 'HUBNET' not in texts:
        raise DewuOrderError('唯品会 确认订单 배송지가 HUBNET 배대지가 아니다 — 결제하지 않음')
    total = confirm_total(nodes)
    if total is None:
        raise DewuOrderError('唯品会 确认订单 합계를 못 읽었다 — 결제하지 않음')
    if total > max_cny:
        raise DewuOrderError(
            f'唯品会 합계 ¥{total:g} 가 상한 ¥{max_cny:.0f} 을 넘는다 — 결제하지 않음(마진)'
        )
    # 5) 支付宝支付 → 알리페이 결제창 금액 확인 → 비밀번호
    _tap_text(phone, nodes, '支付宝支付', (534, 1441))
    end = time.monotonic() + 20
    while phone.top_package() != ALIPAY and time.monotonic() < end:
        sleep(1.5)
    if phone.top_package() != ALIPAY:
        raise DewuOrderError('알리페이 결제창이 안 떴다(결제 전)')
    charge = alipay_order_amount(phone.nodes())
    for _ in range(6):
        if charge is not None:
            break
        sleep(1.7)
        charge = alipay_order_amount(phone.nodes())
    if charge is None:
        raise DewuOrderError('알리페이 결제창의 주문금액을 못 읽었다 — 결제하지 않음')
    if charge > max_cny or charge > total * 1.02 + 1:
        raise DewuOrderError(
            f'알리페이 결제창 금액 ¥{charge:g} 이 상한·합계(¥{total:g})를 넘는다 — 결제하지 않음'
        )
    out = approve(round(charge * 1.03 * rate)).strip()
    nodes = wait_for(lambda ns: has_text(ns, '支付成功'), 25)
    if not has_text(nodes, '支付成功'):
        raise DewuOrderError(
            f'알리페이 승인 응답 {out[:40]} · 支付成功 이 안 보인다 — 唯品会 주문내역 확인(재결제 금지)',
            paid=True,
        )
    paid_cny = round(charge * 1.03, 2)
    # 6) 주문번호
    _tap_text(phone, phone.nodes(), '查看订单', None)
    sleep(4)
    for _ in range(6):
        found = order_no_after_label(phone.nodes())
        if found:
            return DewuResult(order_no=found, paid_cny=paid_cny, item_cny=charge, rate=rate)
        nodes = phone.nodes()
        num = next((n for n in nodes if re.fullmatch(r'\d{14,25}', (n.text or '').strip())), None)
        if num is not None:
            return DewuResult(
                order_no=num.text.strip(), paid_cny=paid_cny, item_cny=charge, rate=rate
            )
        phone._run('shell', 'input', 'swipe', '360', '1200', '360', '800', '300')
        sleep(1)
    raise DewuOrderError(
        f'결제는 됐는데(¥{paid_cny}) 唯品会 주문번호를 못 읽었다 — 주문내역 확인', paid=True
    )
