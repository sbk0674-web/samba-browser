"""식화 淘宝 주문 — PC 삼바 브라우저에서 샵백 경유로 산다(사용자 2026-10-08: "샵백 피시에서 사야지").

흐름(2026-10-08 실기 확인, A-SN241580581 후랑차오 카야노 37)
1. 샵백 淘宝 진입 링크(alink/8906) — 샵백 로그인 프로필(default)에서 연다. 확장앱이 'Cashback Activated' 를 띄운다
2. 식화 판매처 행의 淘宝 상품 주소(item.taobao.com/item.htm?id=…&skuId=…)를 같은 프로필 새 탭에서 연다 — 색상·사이즈가 골라진다
3. 领券购买/立即购买 → 주문 확인: 가게 이름(화이트리스트)·HUBNET 배송지·합계 확인, 결제 통화 '人民币'(알리페이) → 提交订单
4. 알리페이 PC 결제대: 저장 카드(현대 8503) 금액 확인 → 安全码 은 키마스터(fill_secret) → 有效期 는 달력에서 연·월 선택 → 确认付款
   (저장 카드는 비밀번호 단계가 없다 — 确认付款 가 곧 결제다)
5. tbpc-pay-success?biz_order_id=… 가 淘宝 주문번호

안전(코드 수준): 가게 이름이 화이트리스트가 아니거나, 배송지가 HUBNET 이 아니거나, 합계·결제대 금액이 상한을 넘으면 确认付款 를 누르지 않는다.
"""

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass

log = logging.getLogger(__name__)

BridgeCall = Callable[[str, dict[str, object]], str]

SHOPBACK_TAOBAO = 'https://www.shopback.co.kr/redirect/alink/8906'
# 샵백 티몰(Tmall) 4% — 상품 주소가 detail.tmall.com 이면 이쪽으로 들어간다(2026-10-09 확인)
SHOPBACK_TMALL = 'https://www.shopback.co.kr/redirect/alink/8907'
ALLOWED_SHOPS = ('后浪潮品奥莱折扣店', '品牌官方店')
CN_MONTHS = (
    '一月',
    '二月',
    '三月',
    '四月',
    '五月',
    '六月',
    '七月',
    '八月',
    '九月',
    '十月',
    '十一月',
    '十二月',
)
# 이름 뒤에 value="…" 가 붙는다 — 이름은 첫 따옴표 쌍만(실기 2026-10-08: 탐욕 매칭이 'textbox "月/年" value=""' 를 놓쳤다)
_ELEMENT = re.compile(r'^\[(\d+)\]\s+(\w+)\s+"([^"]*)"', re.M)
_CHARGE = re.compile(r'(\d+(?:\.\d+)?)元')
_SUBMIT = re.compile(r'提交订单\s*[¥￥]\s*(\d+(?:\.\d+)?)')
_ORDER_NO = re.compile(r'biz_order_id=(\d{12,25})')


class TaobaoPcError(Exception):
    """사람에게 넘길 사유. paid=True 면 결제됐을 수 있다(재결제 금지)."""

    def __init__(self, reason: str, paid: bool = False) -> None:
        super().__init__(reason)
        self.paid = paid


@dataclass
class TaobaoPcResult:
    order_no: str
    item_cny: float  # 주문 합계(상품가)
    charge_cny: float  # 결제대 청구액(카드 수수료 3% 포함)


def elements(tree: str) -> list[tuple[int, str, str]]:
    """page.get 의 요소 목록 → (id, 종류, 이름)."""
    return [(int(m.group(1)), m.group(2), m.group(3)) for m in _ELEMENT.finditer(tree or '')]


def find_id(tree: str, pattern: str, role: str | None = None) -> int | None:
    """이름이 pattern 에 맞는 첫 요소 id. role 을 주면 그 종류(textbox·button…)만 본다 — 같은 이름의 label 을 집지 않게."""
    rx = re.compile(pattern)
    return next(
        (
            i
            for i, kind, name in elements(tree)
            if rx.search(name) and (role is None or kind == role)
        ),
        None,
    )


def submit_price(tree: str) -> float | None:
    found = _SUBMIT.search(tree or '')
    return float(found.group(1)) if found else None


def cashier_charge(tree: str) -> float | None:
    """결제대의 저장 카드 줄('MasterCard ****8503 565.47元 含信用卡服务费…')에서 청구액."""
    for _i, _kind, name in elements(tree):
        if '8503' in name and '元' in name:
            found = _CHARGE.search(name)
            if found:
                return float(found.group(1))
    return None


def shop_ok(tree: str) -> bool:
    return any(shop in (tree or '') for shop in ALLOWED_SHOPS)


def buy_on_taobao_pc(
    call: BridgeCall,
    item_url: str,
    *,
    max_cny: float,
    expiry: str,
    profile: str = 'default',
    card_account: str = 'edelvise06',
    eu_size: str = '',
    sleep: Callable[[float], None] = time.sleep,
) -> TaobaoPcResult:
    """item_url 상품을 샵백 경유로 산다. expiry 는 'MM/YY'(키마스터 카드 항목의 유효기간 — 비밀 아님)."""

    def js(code: str) -> str:
        return call('run_js', {'code': code})

    def tree() -> str:
        return js('const t=await page.get({interactive:true}); return String(t.tree||t)')

    def click(element_id: int, wait_ms: int) -> str:
        return js(
            f'await page.click({element_id}); await sleep({wait_ms}); return await page.url()'
        )

    def wait_tree(pattern: str, seconds: float = 25) -> str:
        # 화면이 늦게 그려진다(알리페이 결제대 실기 2026-10-08: 9초 뒤에도 비어 있었다) — 필요한 요소가 보일 때까지 다시 읽는다
        rx = re.compile(pattern)
        page = tree()
        waited = 0.0
        while not rx.search(page) and waited < seconds:
            sleep(2.5)
            waited += 2.5
            page = tree()
        return page

    # 1) 샵백 진입 → 2) 상품
    entry = SHOPBACK_TMALL if 'tmall.com' in item_url else SHOPBACK_TAOBAO
    call('new_tab', {'url': entry, 'profile': profile})
    sleep(8)
    call('new_tab', {'url': item_url, 'profile': profile})
    page = wait_tree(r'"(领券购买|立即购买)"')
    buy = find_id(page, r'^(领券购买|立即购买)$')
    if buy is None:
        raise TaobaoPcError(
            '淘宝 상품 화면에서 구매 버튼(领券购买·立即购买)을 못 찾았다 — 품절이거나 로그인 풀림'
        )
    click(buy, 3000)
    # 3) 주문 확인
    page = wait_tree(r'提交订单')
    if not shop_ok(page):
        raise TaobaoPcError('주문 확인 화면에 화이트리스트 가게 이름이 없다 — 결제하지 않음')
    if 'HUBNET' not in page:
        raise TaobaoPcError('주문 확인 배송지가 HUBNET 배대지가 아니다 — 결제하지 않음')
    if eu_size and not re.search(rf'(^|[^\d.]){re.escape(eu_size)}([^\d.]|$)', page):
        raise TaobaoPcError(f'주문 확인 화면에 사이즈 {eu_size} 가 안 보인다 — 결제하지 않음')
    price = submit_price(page)
    if price is None:
        raise TaobaoPcError('주문 확인 합계(提交订单 ¥)를 못 읽었다 — 결제하지 않음')
    if price > max_cny:
        raise TaobaoPcError(
            f'淘宝 합계 ¥{price:g} 가 상한 ¥{max_cny:.0f} 을 넘는다 — 결제하지 않음(마진)'
        )
    rmb = find_id(page, r'^人民币$')
    submit = find_id(page, r'^提交订单')
    if rmb is None or submit is None:
        raise TaobaoPcError('결제 통화(人民币)·提交订单 을 못 찾았다 — 결제하지 않음')
    click(rmb, 1500)
    url = click(submit, 9000)
    if 'alipay.com' not in url:
        raise TaobaoPcError(f'알리페이 결제대로 넘어가지 않았다({url[:60]}) — 결제하지 않음')
    # 4) 결제대 — 금액 확인 → 안전코드(키마스터) → 유효기간(달력) → 确认付款
    page = wait_tree(r'确认付款')
    charge = cashier_charge(page)
    if charge is None:
        raise TaobaoPcError('결제대의 카드 청구액(8503)을 못 읽었다 — 결제하지 않음')
    if charge > price * 1.03 + 1 or charge > max_cny * 1.03 + 1:
        raise TaobaoPcError(
            f'결제대 청구액 ¥{charge:g} 이 합계 ¥{price:g}+수수료 3% 를 넘는다 — 결제하지 않음'
        )
    cvc = find_id(page, r'^安全码$', role='textbox')
    exp = find_id(page, r'^月/年$', role='textbox')
    pay = find_id(page, r'^确认付款$', role='button')
    if cvc is None or exp is None or pay is None:
        raise TaobaoPcError('결제대의 安全码·有效期·确认付款 칸을 못 찾았다 — 결제하지 않음')
    out = call(
        'fill_secret',
        {'elementId': cvc, 'itemType': 'card', 'field': 'card.cvc', 'accountLabel': card_account},
    )
    if not out.strip().startswith('ok'):
        raise TaobaoPcError(f'안전코드를 넣지 못했다: {out[:60]} — 결제하지 않음')
    pick_expiry(js, exp, expiry)
    # 5) 确认付款 = 결제
    click(pay, 9000)
    for _ in range(8):
        url = js('return await page.url()')
        found = _ORDER_NO.search(url)
        if found:
            return TaobaoPcResult(found.group(1), price, charge)
        sleep(3)
    raise TaobaoPcError(
        f'确认付款 뒤 결제 완료 화면(tbpc-pay-success)을 못 봤다(지금 {url[:60]}) — 淘宝 주문내역 확인(재결제 금지)',
        paid=True,
    )


def pick_expiry(js: Callable[[str], str], element_id: int, expiry: str) -> None:
    """有效期 달력(읽기 전용 칸)에서 연·월을 누른다. expiry='MM/YY'.

    달력 팝업은 run_js 호출 사이에 포커스가 빠지며 닫힌다(실기 2026-10-08) — 열기·연도 이동·월 선택을 한 번의 호출에서 끝낸다.
    연도 화살표는 이름 없는 버튼이다: [n-1] button · [n] button "2026" · [n+1] clickable "2026" · [n+2] button
    """
    mm, yy = (expiry or '').split('/')
    year, month = 2000 + int(yy), int(mm)
    code = (
        JS_PICK_EXPIRY.replace('__ID__', str(element_id))
        .replace('__YEAR__', str(year))
        .replace('__MONTH__', CN_MONTHS[month - 1])
    )
    out = js(code).strip()
    if out != 'ok':
        raise TaobaoPcError(f'유효기간을 달력에서 고르지 못했다({out[:40]}) — 결제하지 않음')


JS_PICK_EXPIRY = r"""
const tree = async () => String((await page.get({interactive: true})).tree || '')
let t = await tree()
if (!/\[\d+\] button "20\d\d"/.test(t)) { await page.click(__ID__); await sleep(900); t = await tree() }
for (let k = 0; k < 20; k++) {
  let m = t.match(/\[(\d+)\] button "(20\d\d)"/)
  if (!m) {
    // 연도 화살표를 누르면 연도는 넘어가지만 팝업이 닫힌다(실기 2026-10-08) — 다시 열고 이어 간다
    await page.click(__ID__); await sleep(900); t = await tree()
    m = t.match(/\[(\d+)\] button "(20\d\d)"/)
    if (!m) return 'noyear'
  }
  const id = Number(m[1]), y = Number(m[2])
  if (y === __YEAR__) {
    const mm = t.match(/\[(\d+)\] link "__MONTH__"/)
    if (!mm) return 'nomonth'
    await page.click(Number(mm[1]))
    await sleep(800)
    t = await tree()
    return /textbox "月\/年" value=""/.test(t) ? 'empty' : 'ok'
  }
  await page.click(y < __YEAR__ ? id + 2 : id - 1)
  await sleep(350)
  t = await tree()
}
return 'loop'
"""


def as_json(result: TaobaoPcResult) -> str:
    return json.dumps(result.__dict__, ensure_ascii=False)
