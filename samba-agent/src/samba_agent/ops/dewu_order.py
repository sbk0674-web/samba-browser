"""중국 크림(식화) 주문 — 임성희폰 得物 앱으로 사고 알리페이 비밀번호는 앱 폰 결제 도구가 키마스터에서 넣는다.

사용자 2026-10-01: "식화>더우 결제도 하네스한테 넘겨". 사람이 하던 순서(실기 A-SN241417042, 得物 110213474374883854):
得物 검색(품번) → 상품 → 立即购买 → EU 사이즈 칸 → '再领¥N' 쿠폰 → 하단 결제 → 알리페이 결제창('CVV를 입력하세요' =
6자리 결제 비밀번호) → phone_approve_payment(provider='alipay') → '支付成功' → 완료 → 我·订单의 주문 상세 '订单编号'.

원가 = 알리페이 청구 위안(상품 + 국제카드 수수료 3%) × CNY/KRW 환율(크림 엔진과 같은 frankfurter), 배송비 8,500원 고정.
판매처가 得物이 아니면(唯品会·淘宝 …) 사람에게 넘긴다 — 그 앱 흐름은 아직 없다.
"""

import json
import logging
import re
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass

from samba_agent.ops.ssg_gift_accept import PHONE_BUSY, Node, Phone, find_text, has_text

log = logging.getLogger(__name__)

DEWU = 'com.shizhuang.duapp'
ALIPAY = 'com.eg.android.AlipayGphone'
CN_SHIPPING_FEE = 8500
FX_URL = 'https://api.frankfurter.dev/v1/latest?base=CNY&symbols=KRW'
FX_FALLBACK_URL = 'https://open.er-api.com/v6/latest/CNY'
_PRICE = re.compile(r'^¥\s*(\d+(?:\.\d+)?)$')
_ORDER_NO = re.compile(r'^\d{15,22}$')


class DewuOrderError(Exception):
    """사람에게 넘길 사유(개인정보 없음). paid=True 면 결제는 끝났다(재결제 금지)."""

    def __init__(self, reason: str, paid: bool = False) -> None:
        super().__init__(reason)
        self.paid = paid


@dataclass
class DewuResult:
    order_no: str
    paid_cny: float
    item_cny: float
    rate: float

    @property
    def cost_krw(self) -> int:
        return round(self.paid_cny * self.rate)


def cny_krw_rate() -> float:
    """CNY → KRW 환율(frankfurter, 안 되면 er-api). 못 받으면 0."""
    # 파이썬 기본 User-Agent 는 frankfurter 가 403 으로 막는다(실기 2026-10-03 — 得物 주문이 환율 0 으로 멈췄다)
    for url, pick in ((FX_URL, 'rates'), (FX_FALLBACK_URL, 'rates')):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (samba-agent)'})
            with urllib.request.urlopen(req, timeout=15) as r:
                rate = float(json.loads(r.read().decode('utf-8'))[pick]['KRW'])
            if rate > 0:
                return rate
        except Exception:  # noqa: BLE001 — 다음 출처로 넘어간다. 다 안 되면 사지 않는다(호출부)
            log.warning('위안 환율 조회 실패: %s', url.split('/')[2])
    return 0.0


def header_price(nodes: list[Node]) -> float | None:
    """구매창 위쪽(y<330)의 '¥564' 가격."""
    for n in sorted(nodes, key=lambda n: n.y):
        m = _PRICE.match(n.text.replace(' ', ''))
        if m and n.y < 330:
            return float(m.group(1))
    return None


_PAY_METHODS = ('支付宝', '云闪付', '微信', '花呗', '银行卡', '度小满', '抖音')


def pay_method_of(nodes: list[Node]) -> str:
    """구매 확인 화면에 고른 결제수단 글자(云闪付·支付宝…). 못 찾으면 빈 글.

    '支付方式' 라벨과 같은 줄(세로 40px 안) 오른쪽 글자를 먼저 보고, 라벨이 없으면 알려진 결제수단 이름이 있는지 본다.
    """
    label = next((n for n in nodes if n.text.strip() == '支付方式'), None)
    if label is not None:
        row = [
            n
            for n in nodes
            if n is not label and n.text.strip() and abs(n.y - label.y) <= 40 and n.x > label.x
        ]
        if row:
            return min(row, key=lambda n: n.x).text.strip()
    hit = next(
        (n for n in nodes if any(m in n.text for m in _PAY_METHODS) and len(n.text.strip()) <= 12),
        None,
    )
    return hit.text.strip() if hit is not None else ''


def order_no_after_label(nodes: list[Node]) -> str | None:
    """주문 상세의 '订单编号' 뒤에 오는 숫자."""
    seen = False
    for n in nodes:
        if n.text == '订单编号':
            seen = True
            continue
        if seen and _ORDER_NO.match(n.text):
            return n.text
    return None


def buy_on_dewu(
    phone: Phone,
    model: str,
    eu_size: str,
    *,
    max_cny: float,
    approve: Callable[[int], str],
    rate: float,
    sleep: Callable[[float], None] = time.sleep,
) -> DewuResult:
    """得物에서 model 의 eu_size 를 산다. max_cny 를 넘으면(쿠폰 반영 뒤) 결제하지 않는다.

    approve(원화 금액) 는 앱의 phone_approve_payment(provider='alipay') 를 부르고 결과 글자('ok'·'refused: …')를 준다.
    """

    def wait_for(
        check: Callable[[list[Node]], bool], seconds: float, step: float = 1.5
    ) -> list[Node]:
        end = time.monotonic() + seconds
        nodes = phone.nodes()
        while not check(nodes) and time.monotonic() < end:
            sleep(step)
            nodes = phone.nodes()
        return nodes

    # 1) 검색 — 홈·상품 화면 어디서 시작해도 뒤로 가며 검색창을 찾는다
    phone.launch(DEWU)
    sleep(4)
    nodes = phone.nodes()
    box = None
    for _ in range(6):
        # 지난 시도가 남긴 상품·구매 화면에서 시작할 수 있다 — 검색창이 보일 때까지 뒤로 간다
        # (실기 2026-10-03: 상품 화면의 '立即购买' 를 보고 멈춰 '검색창을 못 찾았다')
        box = next(
            (n for n in nodes if n.y < 140 and n.x < 520 and n.text and n.text != '搜索'), None
        )
        if box is not None and find_text(nodes, '搜索') is not None:
            break
        box = None
        phone.key('4')
        sleep(1.5)
        nodes = phone.nodes()
        if phone.top_package() != DEWU:
            phone.launch(DEWU)
            sleep(4)
            nodes = phone.nodes()
    if box is None:
        raise DewuOrderError('得物 검색창을 못 찾았다')
    phone.tap(box.x, box.y)
    sleep(2)
    # 지난 검색어가 칸에 남아 있으면 뒤에 붙는다 — 먼저 지운다
    phone._run('shell', 'input', 'keyevent', *(['67'] * 30))
    phone._run('shell', 'input', 'text', re.sub(r'[^A-Za-z0-9-]', '', model))
    sleep(1)
    go = find_text(phone.nodes(), '搜索')
    if go is None:
        raise DewuOrderError('得物 검색 버튼(搜索)을 못 찾았다')
    phone.tap(go.x, go.y)

    # 2) 결과의 '商品' 카드 → 상품 화면
    # '商品' 탭·머리글은 결과보다 먼저 그려진다 — 가격 카드가 보일 때까지 기다린다(실기 2026-10-03: 머리글만 보고
    # '상품이 없다'로 끝났다)
    def _first_card(ns: list[Node]) -> Node | None:
        title = find_text(ns, '商品')
        return next(
            (
                n
                for n in sorted(ns, key=lambda n: (n.y, n.x))
                if title and n.y > title.y and _PRICE.match(n.text.replace(' ', ''))
            ),
            None,
        )

    nodes = wait_for(lambda ns: _first_card(ns) is not None, 20)
    card = _first_card(nodes)
    if card is None:
        raise DewuOrderError(f'得物 검색 결과에 {model} 상품이 없다')
    phone.tap(card.x, card.y)
    nodes = wait_for(lambda ns: find_text(ns, '立即购买') is not None, 15)
    buy = find_text(nodes, '立即购买')
    if buy is None:
        raise DewuOrderError('상품 화면에서 立即购买 를 못 찾았다')
    phone.tap(buy.x, buy.y)
    # 3) 사이즈 칸 — 글자가 EU 값과 똑같은 칸, 가격이 '¥--' 면 판매 없음
    nodes = wait_for(lambda ns: find_text(ns, eu_size) is not None, 10)
    cell = find_text(nodes, eu_size)
    if cell is None:
        raise DewuOrderError(f'得物 사이즈 목록에 EU {eu_size} 가 없다')
    below = next((n for n in nodes if abs(n.x - cell.x) < 60 and 0 < n.y - cell.y < 70), None)
    if below is not None and '--' in below.text:
        raise DewuOrderError(f'得物 EU {eu_size} 판매 없음(¥--)')
    phone.tap(cell.x, cell.y)
    sleep(2)
    nodes = phone.nodes()
    if not has_text(nodes, 'HUBNET'):
        raise DewuOrderError('得物 배송지가 HUBNET 배대지가 아니다 — 결제하지 않음')
    # 4) 쿠폰('再领¥N') 받고 가격
    coupon = next((n for n in nodes if '再领' in n.text), None)
    if coupon is not None:
        phone.tap(coupon.x, coupon.y)
        sleep(3)
        nodes = phone.nodes()
    price = header_price(nodes)
    if price is None:
        raise DewuOrderError('得物 구매창 가격을 못 읽었다')
    if price > max_cny:
        raise DewuOrderError(
            f'得物 가격 ¥{price:g} 가 상한 ¥{max_cny:.0f} 을 넘는다 — 결제하지 않음(마진)'
        )
    # 5) 하단 결제 버튼 → 바로 알리페이가 뜨거나, 먼저 '确认订单'(주문 확인) 화면이 뜬다
    pay = next(
        (
            n
            for n in sorted(nodes, key=lambda n: -n.y)
            if n.y > 1380 and _PRICE.match(n.text.replace(' ', ''))
        ),
        None,
    )
    if pay is None:
        raise DewuOrderError('得物 결제 버튼을 못 찾았다')
    phone.tap(pay.x, pay.y)
    end = time.monotonic() + 20
    while phone.top_package() != ALIPAY and time.monotonic() < end:
        sleep(1.5)
        if phone.top_package() == DEWU and find_text(phone.nodes(), '确认订单') is not None:
            break
    if phone.top_package() != ALIPAY:
        nodes = phone.nodes()
        # 지난 시도가 남긴 미결제 주문이 있으면 '您有未支付的订单' 창이 뜬다 — 같은 상품·사이즈면 그 주문을 결제한다
        # (새 주문을 또 만들지 않는다. 실기 2026-10-03: 결제수단 문제로 멈춘 뒤 미결제 주문이 남아 다음 시도가 막혔다)
        if has_text(nodes, '未支付的订单'):
            if not has_text(nodes, eu_size):
                raise DewuOrderError(
                    f'得物에 다른 사이즈의 미결제 주문이 남아 있다 — 사람이 취소해야 한다(EU {eu_size} 아님)'
                )
            go_pay = find_text(nodes, '去支付')
            if go_pay is None:
                raise DewuOrderError('미결제 주문 창에서 去支付 를 못 찾았다')
            phone.tap(go_pay.x, go_pay.y)
            end = time.monotonic() + 20
            while phone.top_package() != ALIPAY and time.monotonic() < end:
                sleep(1.5)
                if phone.top_package() == DEWU and (
                    find_text(phone.nodes(), '立即支付') is not None
                    or find_text(phone.nodes(), '确认订单') is not None
                ):
                    break
            if phone.top_package() == ALIPAY:
                nodes = []
            else:
                nodes = phone.nodes()
    if phone.top_package() != ALIPAY:
        # 주문 확인 화면 — 결제수단이 알리페이가 아니면(云闪付) 바꾸고 '立即支付' 를 누른다
        # (실기 2026-10-03: 云闪付 가 골라져 있어 알리페이 창이 영영 안 떴다)
        nodes = phone.nodes()
        if find_text(nodes, '确认订单') is None and find_text(nodes, '立即支付') is None:
            raise DewuOrderError('알리페이 결제창이 안 떴다(결제 전)')
        # 결제수단 고르기 — 주문 확인 화면('支付方式 云闪付 / 切换更多支付方式')이거나 결제수단 선택 화면
        # ('微信支付 / 支付宝 / 抖音支付 … 立即支付')이다. 어느 쪽이든 '支付宝' 글자를 눌러 고른다
        picked_ali = False
        if '支付宝' not in pay_method_of(nodes):
            more = find_text(nodes, '切换更多支付方式')
            if more is not None:
                phone.tap(more.x, more.y)
                sleep(2.5)
                nodes = phone.nodes()
            ali = next((n for n in nodes if '支付宝' in n.text and len(n.text.strip()) <= 8), None)
            if ali is not None:
                phone.tap(ali.x, ali.y)
                sleep(2.5)
                nodes = phone.nodes()
                picked_ali = True
            if not picked_ali and '支付宝' not in pay_method_of(nodes):
                seen = ' | '.join(n.text.strip()[:12] for n in nodes if n.text.strip())[:160]
                raise DewuOrderError(
                    f'得物 결제수단을 알리페이로 못 바꿨다(지금 {pay_method_of(nodes) or "모름"}; 화면: {seen}) — 결제하지 않음'
                )
        go = find_text(nodes, '立即支付')
        if go is None:
            raise DewuOrderError('주문 확인 화면에서 立即支付 를 못 찾았다')
        phone.tap(go.x, go.y)
        end = time.monotonic() + 20
        while phone.top_package() != ALIPAY and time.monotonic() < end:
            sleep(1.5)
        if phone.top_package() != ALIPAY:
            raise DewuOrderError('알리페이 결제창이 안 떴다(결제 전)')
    paid_hint = round(price * 1.03 * rate)
    out = approve(paid_hint).strip()
    if not out.startswith('ok'):
        raise DewuOrderError(f'알리페이 결제 승인 실패: {out[:80]}')
    # 6) 支付成功 + 청구 위안 → 완료
    nodes = wait_for(lambda ns: has_text(ns, '支付成功'), 20)
    if not has_text(nodes, '支付成功'):
        raise DewuOrderError(
            '알리페이 완료 화면(支付成功)이 안 보인다 — 得物 주문내역 확인(재결제 금지)', paid=True
        )
    amounts = [float(n.text) for n in nodes if re.fullmatch(r'\d+\.\d{2}', n.text)]
    paid_cny = amounts[0] if amounts else round(price * 1.03, 2)
    done = find_text(nodes, '완료') or find_text(nodes, '完成')
    if done is not None:
        phone.tap(done.x, done.y)
        sleep(3)
    order_no = _latest_order_no(phone, sleep)
    if order_no is None:
        raise DewuOrderError(
            f'결제는 됐는데(¥{paid_cny}) 得物 주문번호를 못 읽었다 — 주문내역 확인', paid=True
        )
    return DewuResult(order_no=order_no, paid_cny=paid_cny, item_cny=price, rate=rate)


def _latest_order_no(phone: Phone, sleep: Callable[[float], None]) -> str | None:
    """我 → 待发货 첫 주문 → 상세의 '订单编号'. 화면 이동은 실기 순서를 따른다."""
    for _ in range(6):
        nodes = phone.nodes()
        tab = find_text(nodes, '我')
        if tab is not None:
            # 아래 탭 막대 요소는 좌표가 0 으로 읽힐 때가 있다(실기 2026-10-03) — 그때는 실측 위치를 누른다
            if tab.y > 1400:
                phone.tap(tab.x, tab.y)
            else:
                phone.tap(630, 1490)
            sleep(3)
            break
        phone.key('4')
        sleep(1.5)
    nodes = phone.nodes()
    # 건수가 붙는다('待发货 1')
    pending = next((n for n in nodes if n.text.strip().startswith('待发货')), None)
    if pending is None:
        return None
    phone.tap(pending.x, pending.y)
    sleep(3)
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


def make_shihuo_handler(
    wave: object,
    approve: Callable[[int], str],
    *,
    adb: str | None = None,
    phone_serial: str | None = None,
    rate_of: Callable[[], float] = cny_krw_rate,
) -> Callable[[object, object], tuple[str, str | None, str]]:
    """워커가 SHIHUO 주문에 부르는 처리기 — (작업, 주문) → (결과 'done'|'needs_human', 오류 코드, 보고 한 줄)."""
    import os

    from samba_agent.ops.ssg_gift_accept import DEFAULT_ADB, DEFAULT_PHONE, find_phone_serial

    adb_path = adb or os.environ.get('SAMBA_ADB') or DEFAULT_ADB
    want = phone_serial or os.environ.get('SAMBA_PAY_PHONE') or DEFAULT_PHONE

    def handle(job: object, order: object) -> tuple[str, str | None, str]:
        order_no = str(getattr(order, 'order_no', ''))
        detail = wave.get_order(order_no)  # type: ignore[attr-defined]
        seller = (detail.source_seller or '').strip()
        if seller != '得物':
            return (
                'needs_human',
                'unknown',
                f'판매처 {seller or "모름"} — 得物 외 판매처는 사람이 산다',
            )
        eu = (detail.registered_option or '').strip()
        model = (detail.source_product_code or '').strip()
        if not eu or not model:
            return (
                'needs_human',
                'unknown',
                f'EU 사이즈({eu or "-"})·품번({model or "-"})이 없어 살 수 없다',
            )
        if model.upper().startswith('SH-'):
            # 식화 자체 코드(SH-상품-스타일)는 得物 검색어가 못 된다 — 엉뚱한 첫 상품을 열고 사이즈를 고를 뻔했다(2026-10-04)
            return (
                'needs_human',
                'unknown',
                f'품번이 식화 코드({model})라 得物 검색 불가 — 삼바 상품관리에 진짜 품번(스타일 코드)을 넣어야 한다',
            )
        rate = rate_of()
        if rate <= 0:
            return 'needs_human', 'unknown', '위안 환율을 못 받아 원가를 낼 수 없다 — 결제하지 않음'
        revenue = float(detail.revenue or 0)
        # 마진 > 0: 청구 위안(상품 × 1.03) × 환율 + 배송비 8,500 < 정산금
        max_cny = (revenue - CN_SHIPPING_FEE) / rate / 1.03 if revenue > 0 else 0
        if max_cny <= 0:
            return 'needs_human', 'margin', '정산금을 몰라 마진을 볼 수 없다 — 결제하지 않음'
        serial = find_phone_serial(adb_path, want)
        if serial is None:
            return 'needs_human', 'unknown', '결제 폰(임성희폰)이 연결돼 있지 않다'
        try:
            # 폰을 쓰는 주기 작업(롯데ON 선물 송장·得物 송장)과 겹치지 않게 — 겹치면 카카오톡이 앞으로 와 화면을 못 읽는다
            with PHONE_BUSY:
                res = buy_on_dewu(
                    Phone(adb_path, serial), model, eu, max_cny=max_cny, approve=approve, rate=rate
                )
        except DewuOrderError as e:
            fail = 'margin' if '마진' in str(e) else ('pay_interrupted' if e.paid else 'unknown')
            return 'needs_human', fail, str(e)
        note = (
            f'得物 앱(임성희폰) 결제 ¥{res.paid_cny:g}(상품 ¥{res.item_cny:g}+알리페이 카드수수료) × {res.rate:g}'
            f' · 중국 배송비 {CN_SHIPPING_FEE:,} 고정'
        )
        # 주문계정(得物 계정)을 같이 넣어야 삼바 상태가 배송대기중으로 넘어간다(사용자 2026-10-01: 계정을 안 골라
        # 주문접수로 남았다)
        account_id = wave.only_sourcing_account_id('DEWU')  # type: ignore[attr-defined]
        wave.record_sourcing(  # type: ignore[attr-defined]
            order_no,
            sourcing_order_number=res.order_no,
            cost=res.cost_krw,
            shipping_fee=CN_SHIPPING_FEE,
            sourcing_account_id=account_id,
            notes=note,
        )
        margin = (revenue - res.cost_krw - CN_SHIPPING_FEE) / revenue * 100
        return (
            'done',
            None,
            f'得物 {res.order_no} 원가 {res.cost_krw:,}원 + 배송비 {CN_SHIPPING_FEE:,} · 마진 {margin:.1f}%',
        )

    return handle
