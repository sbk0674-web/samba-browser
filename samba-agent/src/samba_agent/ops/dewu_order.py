"""중국 크림(식화) 주문 — 임성희폰 得物 앱으로 사고 알리페이 비밀번호는 앱 폰 결제 도구가 키마스터에서 넣는다.

사용자 2026-10-01: "식화>더우 결제도 하네스한테 넘겨". 사람이 하던 순서(실기 A-SN241417042, 得物 110213474374883854):
得物 검색(품번) → 상품 → 立即购买 → EU 사이즈 칸 → '再领¥N' 쿠폰 → 하단 결제 → 알리페이 결제창('CVV를 입력하세요' =
6자리 결제 비밀번호) → phone_approve_payment(provider='alipay') → '支付成功' → 완료 → 我·订单의 주문 상세 '订单编号'.

원가 = 알리페이 청구 위안(상품 + 국제카드 수수료 3%) × CNY/KRW 환율(크림 엔진과 같은 frankfurter) × 현대카드 청구할인 0.973, 배송비 8,500원 고정.
판매처가 淘宝·唯品会 이면 得物을 열지 않고 사람에게 넘긴다(식화 링크로 들어가는 흐름이 생기기 전까지).
"""

import json
import logging
import re
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from samba_agent.ops.ssg_gift_accept import PHONE_BUSY, Node, Phone, find_text, has_text

log = logging.getLogger(__name__)

DEWU = 'com.shizhuang.duapp'
ALIPAY = 'com.eg.android.AlipayGphone'
CN_SHIPPING_FEE = 8500
# 알리페이 국제카드 = 현대카드(Mastercard 8503) — 원가 공식의 카드 청구할인 ×0.973 (사용자 지시, 전 소싱처 공통 [cost-formula-all-sources])
HYUNDAI_BILLING_FACTOR = 0.973
# 크림 판매 수수료 — 삼바 정산금(revenue)이 판매가와 같으면(수수료 미계산) 이 비율을 빼고 마진을 본다
KREAM_FEE_RATE = 0.08
FX_URL = 'https://api.frankfurter.dev/v1/latest?base=CNY&symbols=KRW'
FX_FALLBACK_URL = 'https://open.er-api.com/v6/latest/CNY'
_PRICE = re.compile(r'^¥\s*(\d+(?:\.\d+)?)$')
LINE_BREAK = chr(10)
_ORDER_NO = re.compile(r'^\d{15,22}$')


class DewuOrderError(Exception):
    """사람에게 넘길 사유(개인정보 없음). paid=True 면 결제는 끝났다(재결제 금지)."""

    def __init__(self, reason: str, paid: bool = False, out_of_stock: bool = False) -> None:
        super().__init__(reason)
        self.paid = paid
        # 得物 화면에서 품절을 직접 확인했다 — 재고X·취소중 으로 마감해도 되는 사유
        self.out_of_stock = out_of_stock


@dataclass
class DewuResult:
    order_no: str
    paid_cny: float
    item_cny: float
    rate: float

    @property
    def cost_krw(self) -> int:
        # 원가 = 알리페이 최종 청구 위안 × 환율 × 카드 청구할인(현대 ×0.973)
        return round(self.paid_cny * self.rate * HYUNDAI_BILLING_FACTOR)


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


_PRICE_ANY = re.compile(r'^¥\s*(?:\d+(?:\.\d+)?|--)$')
# 의류 사이즈 표기 차이: 삼바 '2XL' ↔ 得物 'XXL', 셀 글자 'L(身高178-182cm)'
_SIZE_ALIASES = {
    '2XL': ('XXL', '2XL'),
    '3XL': ('XXXL', '3XL'),
    'XXL': ('XXL', '2XL'),
    'XXXL': ('XXXL', '3XL'),
}


def size_cell(nodes: list[Node], size: str) -> Node | None:
    """사이즈 칸 — 글자가 그 값이거나 '값(' 로 시작하는 칸(의류는 '(身高…)' 설명이 붙는다). 2XL↔XXL 도 같이 본다."""
    want = _SIZE_ALIASES.get(size.upper(), (size,))
    for n in nodes:
        t = n.text.strip()
        if not t:
            continue
        for w in want:
            if t == w or t.upper().startswith(w.upper() + '('):
                return n
    return None


def header_price(nodes: list[Node]) -> float | None:
    """구매창 위쪽(y<330)의 '¥564' 가격. 위쪽이 안 읽히면(의류 구매창은 사이즈 표가 길어 머리글이 트리에 없다,
    실기 2026-10-05) 아래 결제 단추 줄(y≥1300)의 '¥473' 을 쓴다 — 고른 사이즈의 값이다."""
    for n in sorted(nodes, key=lambda n: n.y):
        m = _PRICE.match(n.text.replace(' ', ''))
        if m and n.y < 330:
            return float(m.group(1))
    # 아래 줄에 결제 버튼이 둘이면(품牌官方 ¥1090 / 일반배송 ¥631, 실기 2026-10-08) 가장 싼 쪽이 일반배송이다
    prices = [
        float(m.group(1))
        for n in nodes
        if n.y >= 1300 and (m := _PRICE.match(n.text.replace(' ', '')))
    ]
    if prices:
        return min(prices)
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


_LABELED_AMOUNT = re.compile(r'(?:订单金额|주문금액)[,，:：\s]*[¥￥]\s*(\d+(?:,\d{3})*(?:\.\d+)?)')
_AMOUNT = re.compile(r'^[¥￥]?\s*(\d+(?:,\d{3})*(?:\.\d+)?)$')


def alipay_order_amount(nodes: list[Node]) -> float | None:
    """알리페이 결제창의 '주문금액(订单金额)' 위안 값. 못 읽으면 None.

    구매창 머리글 가격(¥674)과 실제 결제 금액(¥1090)이 달랐던 사고(2026-10-08 아식스 카야노 14)를 막으려고,
    비밀번호를 넣기 전에 결제창이 청구하려는 금액을 직접 읽는다. 수수료(3%)는 따로 줄에 붙으므로 뺀 값이다.
    """
    labels = ('订单金额', '주문금액', 'Order total')

    def shown(n: Node) -> str:
        # 淘宝 앱 안 결제창은 글자가 접근성 설명(content-desc)에만 있다 — '订单金额,¥ 549.00' 한 덩어리로 온다(실기 2026-10-08)
        return (n.text or n.desc or '').strip()

    for n in nodes:
        combined = _LABELED_AMOUNT.search(shown(n))
        if combined:
            try:
                return float(combined.group(1).replace(',', ''))
            except ValueError:
                return None
    ordered = sorted(nodes, key=lambda n: (n.y, n.x))
    for i, n in enumerate(ordered):
        if any(label in shown(n) for label in labels):
            # 같은 줄 오른쪽이나 바로 다음 요소에서 금액을 찾는다
            for m in ordered[i : i + 4]:
                found = _AMOUNT.match(shown(m).replace('¥ ', '¥').replace('￥ ', '￥'))
                if found:
                    try:
                        return float(found.group(1).replace(',', ''))
                    except ValueError:
                        return None
    return None
    return None


def dismiss_subsidy_dialog(phone: Phone, sleep: Callable[[float], None]) -> bool:
    """'领取补贴 — 실명인증(去实名)' 팝업이 떠 있으면 '再想想'(다시 생각)으로 닫는다. 닫았으면 True.

    국가 보조금 안내 팝업이다 — 실명인증을 하지 않고 보조금 없이 그대로 결제한다(실기 2026-10-08: 이 팝업이 결제 단추를 막아
    '알리페이 결제창이 안 떴다'로 6시간 멈췄다). 去实名 은 절대 누르지 않는다.
    """
    nodes = phone.nodes()
    if not has_text(nodes, '去实名'):
        return False
    later = find_text(nodes, '再想想')
    if later is None:
        return False
    phone.tap(later.x, later.y)
    sleep(2)
    return True


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

    # 1) 검색 — 지난 화면(주문 목록 검색칸 등)에 휘둘리지 않게 앱을 껐다 켜서 홈부터 시작한다(2026-10-05)
    phone._run('shell', 'am', 'force-stop', DEWU)
    sleep(1)
    phone.launch(DEWU)
    sleep(6)
    nodes = phone.nodes()
    box = None
    for _ in range(6):
        # 지난 시도가 남긴 상품·구매 화면에서 시작할 수 있다 — 검색창이 보일 때까지 뒤로 간다
        # (실기 2026-10-03: 상품 화면의 '立即购买' 를 보고 멈춰 '검색창을 못 찾았다')
        # 검색 화면의 입력칸은 id 가 etSearch 다(글자가 비어 있어도) — 글자 위치 추정보다 먼저 본다(실기 2026-10-05)
        box = next((n for n in nodes if (n.rid or '').endswith('id/etSearch')), None)
        # 주문 목록의 검색칸('品牌名/商品名/订单号')도 etSearch 다 — 거기선 상품이 안 나온다(실기 2026-10-05). 뒤로 간다
        if box is not None and has_text(nodes, '订单号'):
            box = None
        elif box is None:
            box = next(
                (n for n in nodes if n.y < 140 and n.x < 520 and n.text and n.text != '搜索'),
                None,
            )
        if box is not None and find_text(nodes, '搜索') is not None:
            break
        if box is None and phone.top_package() == DEWU:
            # 홈 화면이면 위쪽 검색 막대(flSearchB)를 눌러 검색 화면으로 들어간다 — 오른쪽 '搜索' 단추는 추천어로 바로
            # 검색해 버린다(실기 2026-10-05)
            home = next(
                (
                    n
                    for n in nodes
                    if n.y < 160 and (n.rid or '').endswith(('id/flSearchB', 'id/bgSearchView'))
                ),
                None,
            ) or next((n for n in nodes if n.y < 160 and '搜索' in (n.text or '')), None)
            if home is not None:
                phone.tap(home.x, home.y)
                sleep(2)
                nodes = phone.nodes()
                continue
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
    # 지난 검색어가 칸에 남아 있으면 뒤에 붙는다 — 커서를 끝으로 보내고 지운다(앞에 있으면 지워지지 않았다, 2026-10-05)
    phone._run('shell', 'input', 'keyevent', '123')
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
        # 결과가 '全部' 탭이면 '商品' 머리글 아래, 바로 상품 목록이면 정렬 줄('综合 … 筛选') 아래가 카드다(실기 2026-10-05)
        title = find_text(ns, '商品') or (find_text(ns, '综合') if find_text(ns, '筛选') else None)
        # 한 줄의 두 카드는 y 가 몇 px 다르다(실기 2026-10-05: 613 / 610) — y 로만 세우면 오른쪽 카드(다른 상품)를
        # 먼저 연다. 60px 단위 줄로 묶어 왼쪽 카드부터
        return next(
            (
                n
                for n in sorted(ns, key=lambda n: (n.y // 60, n.x))
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
    nodes = wait_for(lambda ns: size_cell(ns, eu_size) is not None or has_text(ns, '暂时缺货'), 10)
    if has_text(nodes, '暂时缺货'):
        # 상품 전체가 품절이면 사이즈 칸은 모두 '¥--' 이고 가격 글자가 칸과 따로 잡히지 않아 '가격을 못 읽었다'(unknown)로
        # 끝났다(실기 2026-10-07 리복 클럽씨 85 EU 43: 네 번 같은 사유) — 화면 머리글 '暂时缺货' 로 품절을 확정한다
        raise DewuOrderError(
            f'得物 확정 품절 — 상품 머리글 暂时缺货(EU {eu_size} 포함 전 사이즈 ¥--)',
            out_of_stock=True,
        )
    cell = size_cell(nodes, eu_size)
    if cell is None:
        raise DewuOrderError(f'得物 사이즈 목록에 EU {eu_size} 가 없다')
    # 신발은 값이 칸 아래, 의류는 같은 줄 오른쪽에 붙는다(실기 2026-10-05 'L(身高178-182cm) ¥385')
    below = next(
        (
            n
            for n in nodes
            if (abs(n.x - cell.x) < 60 and 0 < n.y - cell.y < 70)
            or (abs(n.y - cell.y) < 25 and 0 < n.x - cell.x < 200 and _PRICE_ANY.match(n.text))
        ),
        None,
    )
    if below is not None and '--' in below.text:
        raise DewuOrderError(f'得物 확정 품절 — EU {eu_size} 판매 없음(¥--)', out_of_stock=True)
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
    # 하단 버튼이 둘이면(品牌官方 ¥1090 / 일반배송 ¥631) 싼 일반배송을 누른다 — 왼쪽(비싼 쪽)을 눌러 ¥1090 을 결제한 사고(2026-10-08)
    buttons = [n for n in nodes if n.y > 1380 and _PRICE.match(n.text.replace(' ', ''))]
    pay = min(
        buttons,
        key=lambda n: float(_PRICE.match(n.text.replace(' ', '')).group(1)),  # type: ignore[union-attr]
        default=None,
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
        # 보조금 실명인증 팝업이 주문 확인 화면을 가리고 있으면 먼저 닫는다(가려진 동안은 确认订单·立即支付 가 안 보인다)
        if dismiss_subsidy_dialog(phone, sleep):
            sleep(1.5)
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
            # 보조금 실명인증 팝업이 가렸으면 닫고 立即支付 를 한 번 더 누른다
            if phone.top_package() == DEWU and dismiss_subsidy_dialog(phone, sleep):
                again = find_text(phone.nodes(), '立即支付')
                if again is not None:
                    phone.tap(again.x, again.y)
            # 지난 시도가 남긴 같은 사이즈의 미결제 주문이 있으면 그 주문을 去支付 로 결제한다(새 주문을 또 만들지 않는다)
            if phone.top_package() == DEWU:
                waiting = phone.nodes()
                if has_text(waiting, '未支付的订单'):
                    if not has_text(waiting, eu_size):
                        raise DewuOrderError(
                            f'得物에 다른 사이즈의 미결제 주문이 남아 있다 — 사람이 취소해야 한다(EU {eu_size} 아님)'
                        )
                    go_pay = find_text(waiting, '去支付')
                    if go_pay is not None:
                        phone.tap(go_pay.x, go_pay.y)
                        sleep(2)
        if phone.top_package() != ALIPAY:
            raise DewuOrderError('알리페이 결제창이 안 떴다(결제 전)')
    # 결제창이 실제로 청구하려는 금액을 비밀번호 전에 확인한다 — 구매창에서 읽은 가격과 다르거나 상한을 넘으면 멈춘다
    # 결제창이 뜬 직후에는 금액 글자가 아직 그려지지 않는다(실기 2026-10-08 A-SW242583238: 바로 읽어 '못 읽었다'로 멈춤)
    # — 금액이 보일 때까지 최대 10초 다시 읽는다
    charge = alipay_order_amount(phone.nodes())
    for _ in range(6):
        if charge is not None:
            break
        sleep(1.7)
        charge = alipay_order_amount(phone.nodes())
    if charge is None:
        raise DewuOrderError('알리페이 결제창의 주문금액을 못 읽었다 — 결제하지 않음')
    if charge > max_cny:
        raise DewuOrderError(
            f'알리페이 결제창 금액 ¥{charge:g} 이 상한 ¥{max_cny:.0f} 을 넘는다(구매창 가격 ¥{price:g}) — 결제하지 않음(마진)'
        )
    if charge > price * 1.02 + 1:
        raise DewuOrderError(
            f'알리페이 결제창 금액 ¥{charge:g} 이 구매창 가격 ¥{price:g} 과 다르다 — 결제하지 않음'
        )
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


def _buy_taobao_pc(
    pc_call: Callable[[str, dict[str, object]], str],
    detail: object,
    *,
    eu: str,
    max_cny: float,
    rate: float,
) -> tuple[str, ...] | None:
    """식화 판매처 목록 → 화이트리스트 淘宝 가게(싼 순) → PC 샵백 경유 구매.

    돌려주는 값: ('done', 주문번호, 청구위안, 가게, 상품위안) · ('paid?', 사유) · ('fail', 사유)
    """
    import os

    from samba_agent.ops.shihuo_link import ShihuoLinkError, fetch_suppliers, whitelisted_taobao
    from samba_agent.ops.taobao_pc import TaobaoPcError, buy_on_taobao_pc
    from samba_agent.repair.agent import _run_sync

    expiry = os.environ.get('SAMBA_TAOBAO_CARD_EXPIRY', '').strip()
    if not re.fullmatch(r'\d{2}/\d{2}', expiry):
        return ('fail', '카드 유효기간(SAMBA_TAOBAO_CARD_EXPIRY)이 없다 — 淘宝 PC 구매 안 함')
    source_url = str(getattr(detail, 'source_url', '') or '')
    try:
        rows = _run_sync(fetch_suppliers(source_url, eu))
    except (ShihuoLinkError, Exception) as e:  # noqa: BLE001 — 식화 접속 실패는 다음 순위로
        return ('fail', f'식화 판매처 목록을 못 읽었다: {type(e).__name__}: {str(e)[:80]}')
    reasons: list[str] = []
    for cand in whitelisted_taobao(rows):
        if cand.price_cny > max_cny:
            reasons.append(f'{cand.name} ¥{cand.price_cny:g} > 상한 ¥{max_cny:.0f}')
            continue
        try:
            res = buy_on_taobao_pc(pc_call, cand.url, max_cny=max_cny, expiry=expiry, eu_size=eu)
        except TaobaoPcError as e:
            if e.paid:
                return ('paid?', str(e))
            reasons.append(f'{cand.name}: {e}')
            continue
        return ('done', res.order_no, res.charge_cny, cand.name, res.item_cny)
    return (
        'fail',
        ' / '.join(reasons) or '식화에 화이트리스트 淘宝 가게(상품 주소 있는 행)가 없다',
    )


def make_shihuo_handler(
    wave: object,
    approve: Callable[[int], str],
    *,
    adb: str | None = None,
    phone_serial: str | None = None,
    rate_of: Callable[[], float] = cny_krw_rate,
    buyer_factory: Callable[[], Any] | None = None,
    approve_other: Callable[[int], str] | None = None,
    phone_buyer_enabled: bool = False,
    pc_call: Callable[[str, dict[str, object]], str] | None = None,
) -> Callable[[object, object], tuple[str, str | None, str]]:
    """워커가 SHIHUO 주문에 부르는 처리기 — (작업, 주문) → (결과 'done'|'needs_human', 오류 코드, 보고 한 줄)."""
    import os

    from samba_agent.ops.ssg_gift_accept import DEFAULT_ADB, DEFAULT_PHONE, find_phone_serial

    adb_path = adb or os.environ.get('SAMBA_ADB') or DEFAULT_ADB
    want = phone_serial or os.environ.get('SAMBA_PAY_PHONE') or DEFAULT_PHONE

    def handle(job: object, order: object) -> tuple[str, str | None, str]:
        order_no = str(getattr(order, 'order_no', ''))
        # 조회·기입은 삼바웨이브 행 id 로(같은 주문번호의 다른 행과 구분) — 없으면 주문번호
        wave_key = str(getattr(order, 'wave_key', '') or order_no)
        detail = wave.get_order(wave_key)  # type: ignore[attr-defined]
        # 식화 판매처가 唯品会·淘宝 라도 得物에서 같은 품번을 팔 수 있다(사용자 2026-10-06: 조던 IB7256-010) —
        # 판매처로 거르지 않고 得物을 검색한다. 없으면 검색 단계가 needs_human 으로 돌려준다
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
        sale = float(getattr(detail, 'sale_price', 0) or 0)
        if sale > 0 and revenue >= sale:
            # 삼바 정산금이 판매가 그대로면 수수료가 안 빠진 값이다 — 크림 수수료(8%)를 빼고 본다
            # (실기 2026-10-06 뉴발란스 880: 92,000 그대로 보고 사서 실제 정산 84,640 < 원가 90,883 역마진)
            revenue = round(sale * (1 - KREAM_FEE_RATE))
        # 마진 > 0: 청구 위안(상품 × 1.03) × 환율 × 청구할인 0.973 + 배송비 8,500 < 정산금
        max_cny = (
            (revenue - CN_SHIPPING_FEE) / (rate * HYUNDAI_BILLING_FACTOR) / 1.03
            if revenue > 0
            else 0
        )
        if max_cny <= 0:
            return 'needs_human', 'margin', '정산금을 몰라 마진을 볼 수 없다 — 결제하지 않음'
        seller_name = str(getattr(detail, 'source_seller', '') or '').strip()
        serial = find_phone_serial(adb_path, want)
        if serial is None:
            return 'needs_human', 'unknown', '결제 폰(임성희폰)이 연결돼 있지 않다'
        # 식화 화이트리스트 판매처 중 최저가에서 산다. 최저가가 淘宝·唯品会 이면 폰 구매 AI 가 식화 앱 링크로 들어가 사고
        # (淘宝 검색으로 사면 블랙리스트 가게를 고른다 — 사용자 2026-10-08), 거기서 못 사면(품절·상한 초과) 다음 순위인 得物로
        # 넘어간다. 어디서든 마진이 남는 가격(max_cny 이내)일 때만 결제한다
        res = None
        shop = '得物'
        failures: list[str] = []
        if seller_name and '淘宝' in seller_name and pc_call is not None:
            pc = _buy_taobao_pc(
                pc_call,
                detail,
                eu=eu,
                max_cny=max_cny,
                rate=rate,
            )
            if pc is not None and pc[0] == 'done':
                order_no, charge_cny = pc[1], pc[2]
                cost = round(charge_cny * rate * HYUNDAI_BILLING_FACTOR)
                wave.record_sourcing(  # type: ignore[attr-defined]
                    wave_key,
                    sourcing_order_number=order_no,
                    cost=cost,
                    shipping_fee=CN_SHIPPING_FEE,
                    sourcing_account_id=wave.only_sourcing_account_id('TAOBAO'),  # type: ignore[attr-defined]
                    notes=(
                        f'淘宝 {pc[3]}(식화 화이트리스트) PC 샵백 경유 결제 ¥{charge_cny:g}(상품 ¥{pc[4]:g}+카드수수료 3%)'
                        f' × {rate:g} × 현대카드 청구할인 {HYUNDAI_BILLING_FACTOR} · 중국 배송비 {CN_SHIPPING_FEE:,} 고정'
                    ),
                )
                margin = (revenue - cost - CN_SHIPPING_FEE) / revenue * 100
                return (
                    'done',
                    None,
                    f'淘宝 {order_no} 원가 {cost:,}원 + 배송비 {CN_SHIPPING_FEE:,} · 마진 {margin:.1f}%',
                )
            if pc is not None and pc[0] == 'paid?':
                return 'needs_human', 'pay_interrupted', pc[1]
            # 淘宝 에서 못 샀다(품절·상한·화면) — 다음 순위 得物 로 넘어간다(마진 상한은 得物 쪽도 그대로)
            log.info('淘宝 PC 구매 실패 — 다음 순위 得物: %s', pc[1] if pc else '')
            seller_name = '得物'
        if seller_name and '得物' not in seller_name and not phone_buyer_enabled:
            # 淘宝는 샵백(PC 브라우저)을 켜고 사야 한다 — 폰 앱 구매는 샵백 적립이 빠진다(사용자 2026-10-08 반복 지적).
            # PC 샵백 구매 흐름이 생기기 전까지 득물도 열지 않고 사람에게 넘긴다
            price = float(getattr(detail, 'source_price_cny', 0) or 0)
            return (
                'needs_human',
                'unknown',
                f'식화 최저가 판매처가 {seller_name}{f" ¥{price:g}" if price else ""} 이다 — 샵백을 켠 PC 구매 흐름이 '
                '아직 없어 폰 앱·得物으로 사지 않았다. 사람이 샵백 경유로 구매',
            )
        if seller_name and '得物' not in seller_name:
            from samba_agent.operator.phone_buyer import PhoneBuyer, PhoneToolbox

            price_hint = float(getattr(detail, 'source_price_cny', 0) or 0)
            product_name = getattr(detail, 'product_name', '')
            seller_line = seller_name + (f' ¥{price_hint:g}' if price_hint else '')
            ctx = LINE_BREAK.join(
                [
                    '# 구매 대상',
                    f'품번 {model} · EU 사이즈 {eu} · 상품 {product_name}',
                    f'식화 최저가 판매처: {seller_line}',
                    f'결제 상한(마진 > 0): 상품가 ¥{max_cny:.0f} 이하 · 환율 {rate:g}',
                ]
            )
            try:
                with PHONE_BUSY:
                    tb = PhoneToolbox(
                        Phone(adb_path, serial),
                        approve_other or approve,
                        max_cny=max_cny,
                        rate=rate,
                    )
                    res = (buyer_factory() if buyer_factory else PhoneBuyer()).buy(tb, ctx)
                shop = f'{seller_name}(식화 링크, 폰 AI)'
            except DewuOrderError as e:
                if e.paid:
                    return 'needs_human', 'pay_interrupted', str(e)
                failures.append(f'{seller_name}: {e}')
        if res is None:
            try:
                # 폰을 쓰는 주기 작업(롯데ON 선물 송장·得物 송장)과 겹치지 않게 — 겹치면 카카오톡이 앞으로 와 화면을 못 읽는다
                with PHONE_BUSY:
                    res = buy_on_dewu(
                        Phone(adb_path, serial),
                        model,
                        eu,
                        max_cny=max_cny,
                        approve=approve,
                        rate=rate,
                    )
            except DewuOrderError as e:
                if e.paid:
                    return 'needs_human', 'pay_interrupted', str(e)
                reasons = ' / '.join([*failures, f'得物: {e}'])
                if e.out_of_stock and not failures:
                    # 得物 화면에서 확인한 품절 — 재고X·취소중 으로 마감하고 근거를 메모에 남긴다(사용자 2026-10-07)
                    flagged = ''
                    try:
                        from samba_agent.wave.flags import FlagMarker

                        flagged = (
                            FlagMarker(wave).mark(  # type: ignore[arg-type]
                                wave_key, 'out_of_stock', f'{e} (임성희폰 得物 앱 직접 확인)'
                            )
                            or ''
                        )
                    except Exception as exc:  # noqa: BLE001 — 표시 실패가 보고를 막으면 안 된다
                        flagged = f'재고X 표시 실패: {type(exc).__name__}'
                    return 'needs_human', 'out_of_stock', f'{e} · {flagged}'.strip(' ·')
                fail = 'margin' if '마진' in reasons else 'unknown'
                return 'needs_human', fail, reasons
        note = (
            f'{shop} 앱(임성희폰) 결제 ¥{res.paid_cny:g}(상품 ¥{res.item_cny:g}+알리페이 카드수수료) × {res.rate:g} × 현대카드 청구할인 {HYUNDAI_BILLING_FACTOR}'
            f' · 중국 배송비 {CN_SHIPPING_FEE:,} 고정'
        )
        # 주문계정(得物 계정)을 같이 넣어야 삼바 상태가 배송대기중으로 넘어간다(사용자 2026-10-01: 계정을 안 골라
        # 주문접수로 남았다)
        site_key = 'TAOBAO' if '淘宝' in shop else ('VIPSHOP' if '唯品会' in shop else 'DEWU')
        account_id = wave.only_sourcing_account_id(site_key)  # type: ignore[attr-defined]
        wave.record_sourcing(  # type: ignore[attr-defined]
            wave_key,
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
            f'{shop} {res.order_no} 원가 {res.cost_krw:,}원 + 배송비 {CN_SHIPPING_FEE:,} · 마진 {margin:.1f}%',
        )

    return handle
