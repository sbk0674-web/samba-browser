"""결제 에이전트 — 코드와 도구만 쓴다. LLM 판단이 없고, 재시도도 없다(등록부 payer 행 retry: 0).

비밀번호·카드번호는 여기를 지나가지 않는다. 앱의 fill_secret 과 phone_approve_payment 가
값을 직접 채우고 우리에게는 돌려주지 않는다(docs/bridge.md). 이 파일과 결과 payload 에는
카드 브랜드명만 남고, 실제 결제 성공 문구를 화면에서 확인하기 전에는 ok 를 내지 않는다.
"""

import json
import re
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse, urlsplit

from samba_agent import local_aliases
from samba_agent.agents.base import AgentBase, AgentFailure, run_agent, split_page_dialogs
from samba_agent.agents.buyer import DIRECT_CARD_METHODS, POINTS_ONLY_METHOD, product_no_of
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text
from samba_agent.sources import default_sources
from samba_agent.wave.client import WaveClient, WaveError

# 결제 성공을 확인하는 문구. 이걸 보기 전에는 ok 를 내지 않는다(브리프 §완료조건)
# a-rt.com 주문내역 첫 주문(번호·일시·금액)을 읽는 run_js 본문 — 탭 열기 다음에 붙인다
_ART_RECENT_ORDER_JS = (
    "await sleep(4000)\n"
    "const t = ((await page.get({})).tree.split('PAGE TEXT:')[1] || '').replace(/\\s+/g, ' ')\n"
    "const m = t.match(/주문번호 (\\d{10,}) 주문일시 (\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d) 총 결제금액 ([\\d,]+) 원/)\n"
    "return JSON.stringify(m ? { no: m[1], at: m[2], amount: m[3] } : {})"
)
# 29CM 결제 확인 폴백 — 주문내역에서 방금 생긴 결제완료 주문을 찾는 앱 저장 스크립트(읽기만)
CM29_RECENT_ORDER_SCRIPT = 'cm29_recent_order'
# 한국 시간(윈도에 tzdata 가 없어 고정 오프셋)
_KST = timezone(timedelta(hours=9))

# 페이코 PC 결제창: 정보제공동의 체크박스를 켜고 '결제' 링크를 누르는 run_js 본문(탭 전환 다음에 붙인다)
_PAYCO_AGREE_PAY_JS = (
    # 동의 체크박스는 숨어 있어 요소 목록에 없다 — 앱의 page.check 가 라벨 글자로 켠다(실기 2026-09-25).
    # 동의가 켜진 게 확인될 때만 '결제'를 누른다
    # 카드 고르기 — 결제창은 마지막에 쓴 카드를 띄운다(실기 2026-09-28: 떠 있던 삼성카드로 2건 결제, 청구할인 없음).
    # 견적이 고른 카드(WANT, 차이 없으면 현대카드)가 보일 때까지 '다음'으로 넘기고, 못 찾으면 결제를 누르지 않는다
    "let picked = null; const seen = []\n"
    "for (let k = 0; k < 12 && !picked; k++) {\n"
    "  const t0 = (await page.get({})).tree\n"
    "  const cards = [...new Set([...t0.matchAll(/([가-힣A-Za-z]+카드)\\s*\\(\\d{4}\\)/g)].map(m => m[1]))]\n"
    "  seen.push(cards.join('|'))\n"
    "  if (cards.length === 1 && WANT.some(w => cards[0].includes(w))) { picked = cards[0]; break }\n"
    "  const nx = (await page.get({ interactive: true })).tree.match(/\\[(\\d+)\\] (?:link|clickable|button) \"다음\"/)\n"
    "  if (!nx) break\n"
    "  await page.click(parseInt(nx[1])); await sleep(900)\n"
    "}\n"
    "if (!picked) return JSON.stringify({ clicked: false, agreed: null, note: 'card-not-found', seen })\n"
    "const agreed = await page.check('전체 동의')\n"
    "if (agreed !== 'checked' && agreed !== 'already') return JSON.stringify({ clicked: false, agreed })\n"
    "await sleep(500)\n"
    "const tr = (await page.get({ interactive: true })).tree\n"
    "const pay = tr.match(/\\[(\\d+)\\] (?:link|clickable|button) \"결제\"/)\n"
    "if (!pay) return JSON.stringify({ clicked: false, agreed, note: 'no pay link' })\n"
    "await page.click(parseInt(pay[1])); await sleep(1500)\n"
    "return JSON.stringify({ clicked: true, agreed, card: picked })"
)
# 페이코 결제창 카드 이름 조각 — 견적 카드 글자에서 카드사를 찾는다(농협은 'NH농협카드'·'농축협카드' 둘 다)
_PAYCO_ISSUERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ('현대', ('현대',)),
    ('삼성', ('삼성',)),
    ('롯데', ('롯데',)),
    ('국민', ('국민', 'KB')),
    ('KB', ('국민', 'KB')),
    ('신한', ('신한',)),
    ('농협', ('농협', '농축협')),
    ('NH', ('농협', '농축협')),
    ('우리', ('우리',)),
    ('BC', ('BC',)),
    ('비씨', ('BC',)),
    ('하나', ('하나',)),
)


def payco_card_names(card: str) -> tuple[str, ...]:
    """견적이 고른 카드 글자에서 페이코 결제창에서 찾을 카드 이름 조각. 카드사가 없으면 현대카드(사용자 2026-09-28)."""
    for key, names in _PAYCO_ISSUERS:
        if key.lower() in card.lower():
            return names
    return ('현대',)

PAY_SUCCESS_MARKERS = ('결제 완료', '결제완료', '주문완료', '주문 완료', '주문이 완료', 'approved')
# 결제 "전" 검사용 — 결제창·주문서에도 흔한 '결제 완료 시 적립' 같은 글자로 멈추지 않게 좁힌다
# (실기: 무신사페이 결제창 문구에 걸려 결제 전 pay_interrupted). 주문 완료 주소의 탭이 있거나,
# 화면에 주문 완료 문구와 주문번호가 함께 있어야 이미 결제된 것으로 본다
# 29CM 완료 주소는 /order/confirmed/<상세번호>?order_serial=ORD… 다(실기 2026-09-25 무신사머니 결제 근거)
_PAID_URL_RE = re.compile(
    r'order/result|order/complete|order-complete|orderComplete|order_complete|order/confirmed'
)
_PAID_TEXT = ('주문이 완료', '주문완료', '주문 완료')


def looks_already_paid(list_tabs_output: str, page: str, host: str | None = None) -> bool:
    """재진입 때 이미 결제가 끝났는지(재결제 금지). 주문 완료 탭이 있거나 완료 문구+주문번호가 함께 보이면 True.

    host 가 있으면 그 사이트의 주문 완료 탭만 본다 — 다른 사이트의 지난 주문 완료 탭이 남아 있으면
    모든 결제가 멈췄다(실기 2026-09-27: ABC 주문 완료 탭 하나로 무신사 5건 pay_interrupted).
    """
    urls = re.findall(r'https?://[^\s"<>]+', list_tabs_output or '')
    if host:
        urls = [u for u in urls if host in u.split('/')[2]]
    if any(_PAID_URL_RE.search(u) for u in urls):
        return True
    return any(t in page for t in _PAID_TEXT) and '주문번호' in page


# 'refused: <reason>' 응답은 공통 껍데기(agents/base.tool)가 사유로 옮긴다(리뷰 지적 — I5).
# 여기서는 접두사 없이 오는 과거 형식만 한 번 더 본다
DECLINED_MARKERS = ('declined', '거절')

# 결제창의 신원정보(주문자) 입력칸을 찾는 검색어 — find_elements 로 elementId 를 얻는다
IDENTITY_QUERY = '주문자'

# 웹 결제 비밀번호 키패드 화면에서 요소 번호를 얻는 검색어. 키패드 경로에서는 앱이 번호를 쓰지
# 않지만(숫자 버튼을 앱이 직접 누른다) fill_secret 스키마가 정수를 요구한다
KEYPAD_QUERY = '비밀번호'

# 시험 입력(dry-run) 응답 표시. 앱은 'refused: dry-run …'(폰) · 'refused: DRY_RUN …'(웹 키패드)로
# 돌려준다 — refusal.py 가 거절로 분류하지 않고 그대로 넘겨 준다
DRY_RUN_MARKERS = ('dry-run', 'dry_run')

# find_elements 응답 한 줄 형식: `[12] textbox "주문자 이름"`(src/shared/snapshot.ts)
ELEMENT_ID_RE = re.compile(r'^\[(\d+)\]', re.MULTILINE)

# 결제수단 이름 → 폰 결제 앱(provider enum, src/main/phone/pay.ts PAY_PROVIDERS)
PAY_PROVIDER_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ('toss', ('토스', 'toss')),
    ('payco', ('페이코', 'payco')),
    ('kakaopay', ('카카오', 'kakao')),
    ('naverpay', ('네이버', 'naver')),
)

# 결제창(팝업) 호스트 → 결제 앱. 결제 앱은 사람이 지정하지 않는다 — 사이트 결제 흐름에서
# 열리는 결제창을 보고 정한다(브리프 §결제앱 자동판별). 앱의 판단표(src/main/agent/tools.ts
# PAY_HOST_PROVIDERS)와 같은 호스트를 쓰되, 값은 이 저장소의 PayProvider(src/main/phone/pay.ts)로
# 맞춘다 — kakao→kakaopay, naver→naverpay
PAY_HOST_PROVIDERS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r'(^|\.)toss\.im$|(^|\.)tosspayments\.com$'), 'toss'),
    (re.compile(r'(^|\.)payco\.com$'), 'payco'),
    (re.compile(r'(^|\.)kakaopay\.com$|(^|\.)kakao\.com$'), 'kakaopay'),
    (re.compile(r'(^|\.)pay\.naver\.com$'), 'naverpay'),
)

# 키패드 입력 뒤 주문 완료 화면이 뜰 때까지 기다리는 시간(ms)
PAY_RESULT_WAIT_MS = 4000
# 완료 문구가 아직 없으면 다시 보는 횟수·간격(최대 약 15초 더)
PAY_RESULT_POLL_TRIES = 5
PAY_RESULT_POLL_WAIT_MS = 3000
# 키패드가 뜰 때까지 팝업을 다시 보는 횟수·간격(최대 약 20초)
KEYPAD_POLL_TRIES = 10
KEYPAD_POLL_WAIT_MS = 2000
# fill_secret 을 부르는 총 횟수 상한(키패드 한 번 입력 기준) — 탭 여럿을 돌아도 이것을 넘지 않는다.
# 실기 2026-09-27 ABC 214·218: 키패드가 아닌 창에 10회씩 불렀다(모두 거절, 입력 없음)
KEYPAD_FILL_MAX_CALLS = 10
# 아직 키패드·비밀번호 칸이 아닌 화면에서 앱이 돌려주는 거절 — 아무것도 누르지 않은 응답만 다시 본다
_KEYPAD_NOT_READY = ('target is not a secret input', 'no active tab', 'element not found')
# 'not found' 중에서도 계정·저장 비밀번호가 없다는 응답은 기다려도 바뀌지 않는다 — 다시 부르지 않는다
_KEYPAD_NOT_FOUND_FINAL = ('password', 'account')


def _keypad_not_ready(out: str) -> bool:
    """키패드가 아직 없어 앱이 아무것도 누르지 않은 응답인가(이때만 다시 부른다).

    그 밖의 응답(ok·handoff·이미 입력함·모르는 문구)은 앱이 숫자를 눌렀을 수 있으므로 다시 부르지 않는다 —
    결과를 모른 채 다시 넣으면 이중결제·결제 수단 잠금 위험이다."""
    low = out.lower()
    if any(k in low for k in _KEYPAD_NOT_READY):
        return True
    return 'not found' in low and not any(k in low for k in _KEYPAD_NOT_FOUND_FINAL)


# 결제창이 결제 대신 로그인 화면을 띄운 경우(네이버페이 창인데 프로필의 네이버 로그인이 풀림 — 실기 2026-09-27
# ABC 214·218). 여기엔 결제 비밀번호를 넣지 않고 바로 사람에게 넘긴다
_LOGIN_HOST_RE = re.compile(r'(^|\.)nid\.naver\.com$|(^|\.)id\.payco\.com$|(^|\.)accounts\.kakao\.com$')
_LOGIN_PATH_RE = re.compile(r'login', re.IGNORECASE)


def _is_login_url(url: str) -> bool:
    """결제창 주소가 로그인 화면인가(네이버·페이코·카카오 로그인 호스트, 또는 경로에 login)."""
    host = _host_of(url)
    if not host:
        return False
    if _LOGIN_HOST_RE.search(host):
        return True
    try:
        path = urlparse(url).path
    except ValueError:
        return False
    return bool(_LOGIN_PATH_RE.search(path))


# PC(웹) 결제창에서 비밀번호 키패드로 끝나는 간편결제 — 폰 승인을 쓰지 않는다(사용자 2026-09-25: 페이코는 PC 결제,
# 폰 결제는 안정화 전까지 쓰지 않는다)
# PC 결제창에서 비밀번호 키패드로 끝내는 결제 — 폰 승인으로 보내지 않는다(모바일 결제는 안정화 전까지 쓰지 않음, 사용자).
# 네이버페이도 PC 결제창(pay.naver.com 비밀번호 키패드, 앱이 글자 인식으로 누름)으로 간다 — 폰 승인 도구로 보내면
# 휴대폰 네이버 앱 경로라 폰이 없어 시간 초과로 끊겼다(실기 2026-09-25 ABC 반스)
PC_PAY_PROVIDERS = frozenset({'payco', 'naverpay'})

# 결제창 로그인 화면에서 앱 login 뒤 결제창이 다시 그려질 때까지 기다리는 시간(ms)
POPUP_LOGIN_SETTLE_MS = 5000


# 상품명에서 대조에 쓰지 않는 흔한 말(브랜드·계절·분류) — 이것만 겹쳐서는 같은 상품이라고 보지 않는다
_GENERIC_WORDS = frozenset(
    ['매장정품', '정품', '봄신발', '가을신발', '여름신발', '겨울신발', '신발', '운동화', '스니커즈', '스니커', '남성', '여성', '남녀공용', '공용', '커플', '키즈', '아동', '나이키', '아디다스', '뉴발란스', '푸마', '반스', '컨버스', '리복', '아식스', '휠라', '스케쳐스', '크록스', '머렐', '노스페이스', 'NIKE', 'ADIDAS', 'PUMA', 'VANS', 'CONVERSE', 'REEBOK', 'ASICS', 'FILA', 'SKECHERS', 'CROCS', 'MERRELL', '캐주얼화', '스포츠화', '조깅화', '러닝화', '슬리퍼', '샌들', '모자', '가방', '티셔츠', '블랙', '화이트', '그레이', '네이비', 'BLACK', 'WHITE', 'GREY', 'GRAY', 'NAVY']
)


def _name_words(product_name: str) -> list[str]:
    """상품명 고유 단어 — 한글 2자 이상 또는 영숫자 4자 이상, 흔한 말·순수 숫자 제외."""
    out = []
    for w in re.split(r'[\s/()\[\],·_:-]+', product_name):
        if w.isdigit() or w in _GENERIC_WORDS or w.upper() in _GENERIC_WORDS or w.startswith('옵션'):
            continue
        if (re.search(r'[가-힣]', w) and len(w) >= 2) or len(w) >= 4:
            out.append(w)
    return out


def _sizes(option: str | None, selected: str) -> list[str]:
    return re.findall(r'(?<![\d.])(\d{2,3}(?:\.5)?)(?![\d.])', f'{option or ""} {selected}')


def order_form_keys(product_name: str, option: str | None, selected: str = '') -> bool:
    """대조할 근거(고유 단어·사이즈)가 있는가."""
    return bool(_name_words(product_name) or _sizes(option, selected))


def _found_ratio(words: list[str], hay: str) -> tuple[int, int]:
    """고유 단어 중 hay 에 든 개수와 전체 개수(대소문자 무시)."""
    low = hay.lower()
    return sum(1 for w in words if w.lower() in low), len(words)


def _mostly_found(words: list[str], hay: str) -> bool:
    """고유 단어의 절반 이상(올림)이 hay 에 있는가. 한글·영문 단어를 따로 세어 한쪽이라도 넘으면 된다.

    사이트 상품명은 한글·영문을 같이 쓰고(예: '데이즈 런 키즈 DAZE RUN KD') 주문서는 한쪽만 보여 주기도 해서
    (ABC 주문서: '휠라 DAZE RUN KD') 문자 종류별로 본다.
    """
    groups = (
        [w for w in words if re.search(r'[가-힣]', w)],
        [w for w in words if not re.search(r'[가-힣]', w)],
    )
    for g in groups:
        hit, total = _found_ratio(g, hay)
        if total and hit * 2 >= total:
            return True
    return False


def _has_number(text: str, number: str) -> bool:
    return bool(re.search(rf'(?<!\d){re.escape(number)}(?!\d)', text))


def order_form_mismatch(
    page: str,
    product_name: str,
    option: str | None,
    selected: str = '',
    *,
    site_name: str = '',
    product_no: str = '',
    trust_site: bool = False,
) -> str | None:
    """주문서 글자에 이 주문의 옵션·상품이 맞는가. 다르면 그 사유, 같으면 None(순수 함수).

    - 옵션: 주문 옵션(또는 구매가 고른 selected)에 든 숫자 사이즈 하나라도 주문서에 있어야 한다(숫자가 없으면 건너뜀)
    - 상품: 아래 중 하나면 같은 상품이다
      1) 상품번호(product_no, 6자리 이상)가 주문서 글자·탭 주소(get_page 의 URL 줄)에 있다
      2) 주문 상품명의 고유 단어(흔한 말·순수 숫자 제외) 하나라도 주문서에 있다(고유 단어가 없으면 건너뜀)
      3) 구매가 산 사이트 상품 페이지에서 읽은 상품명(site_name)이 주문 상품명과 같은 상품이고(주문 고유 단어 절반 이상이
         site_name 에 있다) 주문서에 site_name 고유 단어가 절반 이상(한글·영문 따로) 있다 — 주문서가 영문명만 보이고
         모델코드를 안 보이는 사이트(ABC: 삼바 '우먼스 에어 맥스 인비고' ↔ 주문서 'WMNS NIKE AIR MAX INVIGOR')
    진짜 다른 상품(2026-09-26: 나이키 코르테즈 주문에 아디다스 아디스타 주문서)은 어느 쪽도 맞지 않아 막힌다.
    """
    text = re.sub(r'\s+', ' ', page or '')
    low = text.lower()
    sizes = _sizes(option, selected)
    if sizes and not any(re.search(rf'(?<![\d.]){re.escape(x)}(?![\d.])', text) for x in sizes):
        return f'옵션 {sorted(set(sizes))} 이 주문서에 없다'
    pno = re.sub(r'\D', '', product_no or '')
    if len(pno) >= 6 and _has_number(text, pno):
        return None
    words = _name_words(product_name)
    if not words or any(w.lower() in low for w in words):
        return None
    site_words = _name_words(site_name)
    if site_words and _mostly_found(words, site_name) and _mostly_found(site_words, text):
        return None
    # 4) 사이트 상품명의 모델 토큰(기호 뺀 영숫자 5자 이상, 예: 'P-6000' → 'p6000')이 주문서 글자에 있다 —
    #    ABC 주문서는 스타일코드 없이 'NIKE P-6000' 만 보인다(실기 2026-09-28 B07648: CN0149 로 못 맞춰 결제 안 됨)
    compact_text = re.sub(r'[^0-9a-z가-힣]', '', low)
    compact_name = re.sub(r'[^0-9a-z가-힣]', '', product_name.lower())
    # 띄어쓰기만 다른 고유 단어(주문 '트래퍼햇' ↔ 주문서 '트래퍼 햇') — 세 자 이상 단어가 공백 없는 주문서에 있다
    # (실기 2026-09-30 롯데온 포이즌: 색상·상품 모두 맞는데 상품명 단어 대조로 결제를 막았다)
    if any(len(w) >= 3 and re.sub(r'[^0-9a-z가-힣]', '', w.lower()) in compact_text for w in words):
        return None
    site_tokens = [
        re.sub(r'[^0-9a-z가-힣]', '', tok)
        for tok in re.split(r'\s+', (site_name or '').lower())
        if tok.upper() not in _GENERIC_WORDS and tok not in _GENERIC_WORDS
    ]
    for c in site_tokens:
        if len(c) >= 5 and not c.isdigit() and c in compact_name and c in compact_text:
            return None
    # 5) 구매가 상품번호로 확인한 상품 페이지에서 만든 주문서(trust_site)면 — 주문서에 사이트 상품명 토큰(3자 이상,
    #    흔한 말 제외)이 대부분 있으면 같은 상품이다. 삼바 상품명은 한글 설명('통기성 커플샌들 빅 로우'), ABC 주문서는
    #    영문명('BIG NIKE LOW')뿐이라 단어로는 못 맞춘다(실기 2026-09-28 B15960)
    if trust_site:
        toks = [c for c in site_tokens if len(c) >= 3 and not c.isdigit()]
        if toks and sum(1 for c in toks if c in compact_text) >= max(1, (len(toks) + 1) // 2):
            return None
    return f'상품명 단어 {words[:6]} 가 주문서에 없다' + (
        f'(사이트 상품명 {site_words[:6]} 로도 못 맞춤)' if site_words else ''
    )


# 도착예정일 — '10/03(토) 도착'·'10.03(토) 도착 예정'·'10월 3일(토) 도착'. 3일을 넘으면 메모에 남긴다(사용자 2026-09-30)
ARRIVAL_MEMO_DAYS = 3
_ARRIVAL_RE = re.compile(
    r'(\d{1,2})\s*(?:[./]|월\s*)\s*(\d{1,2})\s*일?\s*\(?([월화수목금토일])?\)?\s*(?:까지\s*|이내\s*)?(?:도착|배송\s*완료)'
)


def arrival_eta(page: str, today: date) -> tuple[date, int] | None:
    """주문서 글자에서 도착예정일과 오늘부터 며칠 뒤인지. 여럿이면 가장 늦은 날, 못 읽으면 None."""
    found: list[date] = []
    for m in _ARRIVAL_RE.finditer(re.sub(r'\s+', ' ', page or '')):
        month, day = int(m.group(1)), int(m.group(2))
        try:
            d = date(today.year, month, day)
        except ValueError:
            continue
        if d < today - timedelta(days=30):
            d = date(today.year + 1, month, day)  # 연말에 본 1월 날짜
        if today <= d <= today + timedelta(days=60):
            found.append(d)
    if not found:
        return None
    d = max(found)
    return d, (d - today).days


def arrival_memo(page: str, today: date) -> str | None:
    """도착예정일이 3일을 넘으면 메모 한 줄, 아니면 None."""
    eta = arrival_eta(page, today)
    if eta is None or eta[1] <= ARRIVAL_MEMO_DAYS:
        return None
    d, days = eta
    wd = '월화수목금토일'[d.weekday()]
    return f'[도착예정] {d.month:02d}/{d.day:02d}({wd}) — 결제일 기준 {days}일'


def is_cross_buy(a: Assignment) -> bool:
    """교차 비교로 주문 소싱처가 아닌 사이트에서 샀는가."""
    bought = a.handoff.get('buy_source')
    if not bought:
        return False
    src = default_sources()
    return src.normalize(str(bought)) != src.normalize(str(a.order.source or ''))


def expect_name(a: Assignment) -> str:
    """주문서 대조에 쓸 상품명. 교차 구매면 산 사이트 상품명(스냅샷 product_name), 아니면 삼바웨이브 sku."""
    if is_cross_buy(a) and a.handoff.get('product_name'):
        return str(a.handoff.get('product_name'))
    return a.order.sku or ''


# 카드 직접 결제(H몰 롯데카드) — 결제하기 뒤 뜨는 카드사 결제창(KSNET 안심클릭 kspay.ksnet.to → 롯데카드 앱카드·간편결제·
# 일반결제)은 에이전트가 누르지 않는다. 사람이 폰(카드사 앱)으로 승인하는 동안 주문 완료를 기다린다(사용자 2026-09-27:
# 모르면 사람 승인 경로). 기다리는 총 시간 = 횟수 × 간격(약 3분)
DIRECT_CARD_WAIT_TRIES = 36
DIRECT_CARD_POLL_MS = 5000
# 주문 완료 화면 글자(카드 직접 결제 대기 중 확인) — 결제 성공 문구와 같다(주문서 글자에는 없다)
_DIRECT_CARD_DONE = PAY_SUCCESS_MARKERS


def direct_card_of(a: Assignment) -> str | None:
    """이 결제가 소싱처 direct_card(주문서 '카드' 탭 직접 결제)면 카드사 이름, 아니면 None."""
    src = default_sources().by_id(str(a.handoff.get('buy_source') or a.order.source or ''))
    card = str(a.options.get('card') or a.handoff.get('card') or '').strip()
    if src is None or not src.direct_card or card not in DIRECT_CARD_METHODS:
        return None
    return str(a.handoff.get('card_issuer') or src.direct_card)


def web_pay_provider(card: str) -> str | None:
    """웹 결제 비밀번호의 제공자 — 무신사페이는 musinsapay, 페이코는 payco, 사이트 머니(무신사머니·SSG PAY…)는 site, 모르면 None."""
    if '무신사페이' in card or 'musinsapay' in card.lower():
        return 'musinsapay'
    if '페이코' in card or 'payco' in card.lower():
        return 'payco'
    if '네이버' in card or 'naver' in card.lower():
        return 'naver'
    # 슈마커 '간편결제'(슈마커PAY)는 사이트 결제 비밀번호다(키마스터 site 항목, 실기 2026-09-26)
    if any(k in card for k in ('머니', 'SSG PAY', 'L.pay', '충전결제', '스마일', '간편결제')):
        return 'site'
    return None


def _host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or '').lower()
    except ValueError:
        return ''


def _pay_host_provider(url: str) -> str | None:
    """결제창 URL 의 호스트가 폰 결제 앱(토스·페이코·카카오·네이버)이면 그 이름, 아니면 None(웹 결제창)."""
    host = _host_of(url)
    for pattern, provider in PAY_HOST_PROVIDERS:
        if pattern.search(host):
            return provider
    return None


# run_script checkout_enter_* 직후 결제창(팝업)이 아직 하나도 없을 때 한 번 더 보기 전 기다리는
# 시간(ms) — 사이트가 팝업을 띄우는 타이밍과 어긋나 곧장 웹 결제 경로로 새지 않게 한다(리뷰 지적 — Minor 4)
PAY_POPUP_WAIT_MS = 2000
# 결제창 '결제하기' 버튼이 뜰 때까지 다시 보는 횟수·간격(중간 bridge 페이지를 지나는 시간)
PAY_BUTTON_POLL_TRIES = 12
PAY_BUTTON_POLL_WAIT_MS = 700

# list_tabs 응답에서 팝업 kind 만 그물망으로 건질 때 쓰는 보조 정규식.
# 정상 응답은 JSON 배열(id·kind·title·url·…)이지만, 형식이 바뀌어도 최소한
# "kind":"popup" 옆의 url 값은 이걸로 건진다(문자열 형식 대비)
POPUP_URL_FALLBACK_RE = re.compile(r'"kind"\s*:\s*"popup"[^{}]*?"url"\s*:\s*"([^"]*)"')

# 소싱처별 "결제창 진입" 저장 스크립트 이름은 소싱처 표(sources.yaml)가 준다 —
# checkout_enter_<key>(29CM 만 checkout_enter_29cm 으로 표에 적어 둔 예외).
# 표에 없는 소싱처는 기본 checkout_enter 로 진입한다
DEFAULT_CHECKOUT_SCRIPT = 'checkout_enter'


def checkout_script_for(source: str) -> str:
    """소싱처(한글 이름·id 어느 쪽이든) → 결제창 진입 스크립트 이름."""
    found = default_sources().by_id(source)
    return found.checkout_script_name if found else DEFAULT_CHECKOUT_SCRIPT


# dry_run 이면 결제 에이전트가 절대 부르지 않는 부수효과 도구(허용 목록에 있어도 막는다).
# 코드 흐름상 dry_run 은 결제창 진입 뒤 곧바로 끝나 이 도구들을 호출하지 않지만, buyer.py 처럼
# tool() 에서도 한 번 더 막아 이중으로 지킨다(불변조건)
DRY_RUN_BLOCKED_TOOLS = frozenset({'fill_secret', 'phone_approve_payment'})

# 사업자등록번호의 가명 열쇠 — 실제 값은 local-aliases.json 의 같은 열쇠에 'biz:<번호>' 로 둔다
BIZ_NO_ALIAS = 'biz:0000000000'

# 결제 직전 재조회에서 '아직 미처리' 로 보는 삼바웨이브 상태(플레이북 §5-1)
WAVE_PENDING_STATUS = 'pending'

# 결제 성공 화면에서 소싱처 주문번호를 뽑는 표현 — 기록·검증이 이 값으로 대조한다(리뷰 지적 — I2)
SOURCE_ORDER_NO_RE = re.compile(r'주문\s?번호[^0-9A-Za-z]{0,4}([A-Za-z0-9][A-Za-z0-9-]{4,31})')


# 결제 앱 안에서 고를 카드의 검색어(플레이북 §0) — 카드사 이름 조각 → phone_approve_payment 의 card 값
CARD_APP_CODES: tuple[tuple[tuple[str, ...], str], ...] = (
    (('현대',), '현대'),
    (('KB', '국민'), 'Smart'),
    (('롯데',), 'LOCA'),
    (('신한',), '11번가'),
    (('농협', 'NH'), 'zgm'),
)


def card_app_code(issuer: object) -> str | None:
    """카드사 이름('농협카드') → 결제 앱 검색어('zgm'). 표에 없으면 이름 그대로, 비어 있으면 None"""
    text = str(issuer or '').strip()
    if not text:
        return None
    for names, code in CARD_APP_CODES:
        if any(n in text for n in names):
            return code
    return text


def _pay_provider(*candidates: object) -> str | None:
    """결제수단 이름에서 폰 결제 앱을 고른다. 못 고르면 None — 결제하지 않는다."""
    for candidate in candidates:
        text = str(candidate or '').lower()
        if not text:
            continue
        for provider, keywords in PAY_PROVIDER_KEYWORDS:
            if any(k in text for k in keywords):
                return provider
    return None


def _popups_and_active_tabs(list_tabs_output: str) -> tuple[list[dict[str, object]], set[str]]:
    """list_tabs 출력(list_tabs, src/main/agent/tools.ts)에서 팝업 창 목록과 활성 탭 id 집합을
    뽑는다. 결제창은 kind가 popup 인 창이다(주소 검색창 등 다른 팝업도 섞일 수 있어 호스트로
    다시 거른다). 팝업이 여럿일 때 우선순위를 매기려면 openerId(팝업을 연 탭)와 active(그 탭이
    지금 활성 탭인지)가 있어야 하므로, 정상 JSON 응답에서만 그 값을 함께 돌려준다 — 형식이 바뀌어
    문자열만 훑는 예비 경로에서는 URL만 남고 우선순위 정보는 없다."""
    try:
        targets = json.loads(list_tabs_output)
    except (json.JSONDecodeError, TypeError):
        targets = None
    if isinstance(targets, list):
        popups = [
            t for t in targets if isinstance(t, dict) and t.get('kind') == 'popup' and t.get('url')
        ]
        active_tab_ids = {
            str(t['id'])
            for t in targets
            if isinstance(t, dict)
            and t.get('kind') == 'tab'
            and t.get('active') is True
            and t.get('id')
        }
        return popups, active_tab_ids
    fallback = [
        {'url': m.group(1)} for m in POPUP_URL_FALLBACK_RE.finditer(list_tabs_output) if m.group(1)
    ]
    return fallback, set()


def _pay_provider_from_host(url: str) -> str | None:
    """팝업 URL 호스트로 결제 앱을 고른다. 앱의 payProviderOfUrl(tools.ts)과 같은 표를 쓴다."""
    try:
        host = (urlsplit(url).hostname or '').lower()
    except ValueError:
        return None
    if not host:
        return None
    for pattern, provider in PAY_HOST_PROVIDERS:
        if pattern.search(host):
            return provider
    return None


def _element_id(found: str) -> int | None:
    """find_elements 응답에서 첫 요소 번호를 뽑는다. 없으면 None."""
    m = ELEMENT_ID_RE.search(found)
    return int(m.group(1)) if m else None


def _element_id_of(page: str, pattern: str) -> int | None:
    """get_page 요소 목록에서 `[N] <pattern>` 으로 시작하는 첫 줄의 번호. 없으면 None."""
    m = re.search(r'^\[(\d+)\] ' + pattern, page, re.MULTILINE)
    return int(m.group(1)) if m else None


# 카카오페이 카톡결제 탭을 누른 뒤·결제요청을 누른 뒤 기다리는 시간(ms)
KAKAO_TAB_WAIT_MS = 1500
KAKAO_REQUEST_WAIT_MS = 2500


def _other_tab_on_host(listed: str, host: str, skip: str) -> str | None:
    """list_tabs 응답에서 그 호스트의 일반 탭(skip 제외) 하나의 id. 없으면 None."""
    try:
        rows = json.loads(listed)
    except ValueError:
        return None
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or str(row.get('id') or '') == skip:
            continue
        if row.get('kind', 'tab') == 'tab' and host in _host_of(str(row.get('url') or '')):
            return str(row['id'])
    return None


def _active_tab_id(listed: str) -> str | None:
    """list_tabs 응답(JSON 배열)에서 활성 탭 id. 형식이 아니면 None."""
    try:
        rows = json.loads(listed)
    except ValueError:
        return None
    if not isinstance(rows, list):
        return None
    for row in rows:
        if isinstance(row, dict) and row.get('active') and row.get('id'):
            return str(row['id'])
    return None


def _amount_krw(value: object) -> int | None:
    """결제 금액(원 단위 양의 정수). 모르거나 0 이하면 None — 앱 스키마가 거절한다."""
    try:
        amount = round(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return amount if amount > 0 else None


# 주문 완료 주소 속 주문번호(무신사 …/order/result/202609241804480002)
# 29CM 완료 주소의 경로 번호는 주문상세 번호라 쓰지 않고 order_serial(주문번호 ORD…)을 읽는다
RESULT_URL_ORDER_NO_RE = re.compile(
    r'order/(?:result|complete)/([A-Za-z0-9-]{6,32})'
    r'|order/confirmed/[^\s"]*?[?&]order_serial=([A-Za-z0-9-]{6,32})'
)


def _source_order_no(page: str, tabs: str = '') -> str | None:
    """결제 성공 화면(없으면 주문 완료 탭 주소)에서 소싱처 주문번호를 뽑는다. 못 찾으면 None.

    실기: 무신사페이 완료 화면 글자에 '주문번호' 표기가 없어 기록이 멈췄다 — 완료 탭 주소에는 번호가 있다.
    """
    # 완료 화면 주소의 번호가 가장 확실하다 — 화면 글자의 '주문번호'는 다른 주문(추천·최근 주문·다른 탭)일 수 있다
    # (실기 2026-09-28 무신사 3474468594: 주소는 …/order/result/202609281237190008 인데 글자에서
    # 2026092815965556 을 읽어 기입했다). 화면 첫 줄(URL: …)을 먼저 본다
    m = RESULT_URL_ORDER_NO_RE.search(page.splitlines()[0] if page.strip() else '')
    if m:
        return m.group(1) or m.group(2)
    m = SOURCE_ORDER_NO_RE.search(page)
    if m:
        return m.group(1)
    m = RESULT_URL_ORDER_NO_RE.search(tabs)
    return (m.group(1) or m.group(2)) if m else None


def recent_art_order(agent: AgentBase, a: Assignment) -> str | None:
    """a-rt.com(ABC마트·그랜드스테이지) 주문내역에서 10분 안에 생긴 결제완료 주문번호. 아니면 None."""
    source = str(a.handoff.get('buy_source') or a.order.source or '')
    host = {'ABCmart': 'abcmart.a-rt.com', 'GrandStage': 'grandstage.a-rt.com'}.get(source)
    account = str(a.handoff.get('account') or a.order.account or '')
    if not host or not account:
        return None
    code = (
        f"await tabs.open({{ url: 'https://{host}/mypage/claim/claim-order-main', "
        f"profile: {json.dumps(account)} }})\n" + _ART_RECENT_ORDER_JS
    )
    try:
        raw = agent.tool('run_js', code=code, safety='no_pay')
        found = json.loads(raw[raw.index('{'):]) if '{' in raw else {}
    except (AgentFailure, ValueError):
        return None
    no, at = str(found.get('no') or ''), str(found.get('at') or '')
    if not no or not at:
        return None
    try:
        placed = datetime.strptime(at, '%Y-%m-%d %H:%M:%S').replace(tzinfo=_KST)
    except ValueError:
        return None
    if abs((datetime.now(_KST) - placed).total_seconds()) > 600:
        return None
    agent.note('결제 확인(주문내역)', f'{no} {at} {found.get("amount")}원')
    return no


def recent_cm29_order(agent: AgentBase, a: Assignment) -> str | None:
    """29CM 주문내역에서 10분 안 결제완료 주문 중 이번 상품명·옵션이 맞는 하나의 주문번호. 아니면 None.

    앱 저장 스크립트 cm29_recent_order(읽기만)가 목록·상세를 읽는다. 이름·옵션이 안 맞거나 여러 건이면
    스크립트가 order_no 를 비워 돌려주고, 그러면 사람에게 넘긴다(재결제 금지).
    """
    if str(a.handoff.get('buy_source') or a.order.source or '') != '29CM':
        return None
    account = str(a.handoff.get('account') or a.order.account or '')
    name = str(a.handoff.get('product_name') or '') or expect_name(a)
    option = str(a.handoff.get('selected') or '') or (a.order.option or '')
    if not account or not name:
        return None
    args = {'profile': account, 'name': name, 'option': option, 'withinMin': 10}
    try:
        raw = agent.tool(
            'run_script',
            name=CM29_RECENT_ORDER_SCRIPT,
            args=json.dumps(args, ensure_ascii=False),
        )
        found = json.loads(raw[raw.index('{'):]) if '{' in raw else {}
    except (AgentFailure, ValueError):
        return None
    if not isinstance(found, dict):
        return None
    no, at = str(found.get('order_no') or ''), str(found.get('at') or '')
    if not no.startswith('ORD') or not at:
        why = str(found.get('note') or '')[:120]
        agent.note('결제 확인(주문내역)', mask_text(f'29CM 못 찾음: {why}'))
        return None
    try:
        placed = datetime.strptime(at, '%Y-%m-%d %H:%M').replace(tzinfo=_KST)
    except ValueError:
        return None
    # 스크립트도 보지만 여기서 한 번 더 — 분 단위 표기라 1분 여유를 둔다
    if abs((datetime.now(_KST) - placed).total_seconds()) > 660:
        return None
    method = str(found.get('method') or '')
    agent.note('결제 확인(주문내역)', f'{no} {at} {found.get("paid")}원 {method}'.strip())
    return no


class PayerAgent(AgentBase):
    """모든 소싱처의 결제를 맡는다. 등록부에서 retry: 0 이다 — 여기서도 다시 부르지 않는다."""

    _dry_run: bool = True
    # 삼바웨이브 내부 API 클라이언트. factory 가 꽂는다(없으면 결제 직전 재조회를 건너뛴다)
    _wave: 'WaveClient | None' = None

    def set_wave(self, wave: 'WaveClient | None') -> None:
        """삼바웨이브 클라이언트를 꽂는다. 배선은 factory 가 한다."""
        self._wave = wave

    def __call__(self, assignment: Assignment) -> AgentResult:
        self._dry_run = assignment.dry_run
        self.reset_repairs()
        return run_agent(lambda: self._pay(assignment), lambda: self.evidence)

    def _recheck_wave(self, a: Assignment) -> None:
        """결제창 진입 전 SAMBA 재조회(플레이북 §5-1) — 그사이 누가 샀거나 상태가 바뀌었는지 본다.

        소싱주문번호가 이미 있으면 중복 구매라 끝내고, 상태가 미처리(pending)가 아니면
        (취소·반품·다른 작업자 처리 등) 사람에게 넘긴다. 조회 자체가 실패해도 확인 못 한 채
        결제하지 않는다. 삼바웨이브가 없으면 건너뛴다(앱 저장 스크립트 경로).
        """
        if self._wave is None:
            return
        self.step('payer: 결제 직전 SAMBA 재조회')
        try:
            current = self._wave.get_order(a.order.order_no)
        except WaveError as e:
            raise AgentFailure(
                'needs_human', f'결제 직전 SAMBA 재조회 실패(결제하지 않음): {e}', e.reason
            ) from e
        sourcing_no = (current.sourcing_order_number or '').strip()
        # 재구매 — 소싱처에서 취소한 주문을 다시 사는 경우(작업 옵션 rebuy_of = 취소한 소싱주문번호).
        # 삼바웨이브에 남은 번호가 그 번호와 같을 때만 통과한다(실기 2026-09-28: 카드 잘못 결제 2건 취소 뒤 재구매)
        rebuy_of = str(a.options.get('rebuy_of') or '').strip()
        if rebuy_of and sourcing_no == rebuy_of:
            self.note('결제 직전 재조회', f'재구매 — 취소한 소싱주문 {rebuy_of} 을 새 주문으로 바꾼다')
            return
        if sourcing_no:
            raise AgentFailure(
                'fail', f'이미 소싱주문번호가 있다: {sourcing_no}', FailReason.DUPLICATE
            )
        status = (current.status or '').strip()
        if status.lower() != WAVE_PENDING_STATUS:
            raise AgentFailure(
                'needs_human', f'상태 변경: {status or "(비어 있음)"}', FailReason.UNKNOWN
            )
        self.note('결제 직전 재조회', f'상태 {status} · 소싱주문번호 없음')

    def tool(self, name: str, /, **args: object) -> str:
        """dry_run 이면 부수효과 도구는 허용 목록에 있어도 아예 부르지 않는다(불변조건).

        딱 하나의 예외가 시험 입력이다 — `dryRunDigits` 를 실어 부르면 앱이 결제 비밀번호를
        그 자리수만 누르고 취소한다(결제는 끝나지 않는다). 그 인자가 없으면 여전히 막는다.
        """
        dry_digits = args.get('dryRunDigits')
        allowed_dry_call = isinstance(dry_digits, int) and dry_digits > 0
        if self._dry_run and name in DRY_RUN_BLOCKED_TOOLS and not allowed_dry_call:
            raise AgentFailure(
                'fail',
                f'dry_run 에서는 부수효과 도구를 부르지 않는다: {name}',
                FailReason.PERMISSION_DENIED,
            )
        return super().tool(name, **args)

    def _list_tabs_popups(self) -> tuple[list[dict[str, object]], set[str]]:
        """list_tabs 를 불러 팝업 목록과 활성 탭 id 집합을 돌려준다. list_tabs 자체가 실패하면
        (브릿지 오류 등) 결제창을 못 본 채로 찍어 승인하면 안 되므로 바로 사람에게 넘긴다 —
        이때 사유를 UNKNOWN 으로 뭉개지 않고 브릿지가 준 fail_reason 을 그대로 살린다(리뷰 지적 — Minor 3)."""
        try:
            listed = self.tool('list_tabs')
        except AgentFailure as e:
            raise AgentFailure(
                'needs_human',
                f'결제창 목록을 확인할 수 없다: {e.reason}',
                e.fail_reason,
            ) from e
        self._last_listed = listed
        return _popups_and_active_tabs(listed)

    def _restore_kakao_tab(self, kakao_tab: str, helper_tab: str | None) -> None:
        """폰 승인 뒤 — 앞에 띄웠던 소싱처 탭을 닫고 카카오페이 결제창 탭으로 돌아간다(실패해도 확인 단계가 다시 본다)."""
        try:
            if helper_tab:
                self.tool('close_tab', id=helper_tab)
            self.tool('switch_tab', id=kakao_tab)
        except AgentFailure as e:
            self.note('카카오페이', mask_text(f'결제창 탭으로 못 돌아감({e.reason[:80]})'))

    def _kakao_talk_request(self, a: Assignment) -> tuple[str, str | None] | None:
        """카카오페이 결제창의 '카톡결제' 탭에서 휴대폰·생년월일을 앱(fill_secret)이 채우고 결제요청을 누른다.

        번호·생년월일은 하네스를 지나가지 않는다. 결제창이 카톡결제 화면이 아니면(이미 요청됨 등) 아무것도 하지 않는다.
        키마스터에 값이 없으면(not found) 결제하지 않고 사람에게 넘긴다."""
        self.step('payer: 카카오페이 카톡결제 요청')
        page = self.tool('get_page')
        if 'kakaopay.com' not in page.split('\n', 1)[0]:
            return None
        tab = _element_id_of(page, r'tab "카톡결제"')
        if tab is not None:
            self.tool('click', id=tab)
            self.tool('wait', ms=KAKAO_TAB_WAIT_MS)
            page = self.tool('get_page')
        fields = (
            (r'textbox "휴대폰번호"', 'payment.phone', 'digits'),
            (r'textbox "생년월일', 'payment.birth', 'yymmdd'),
        )
        for pattern, field, fmt in fields:
            element_id = _element_id_of(page, pattern)
            if element_id is None:
                raise AgentFailure(
                    'needs_human', f'카카오페이 카톡결제 칸 없음({field})', FailReason.UNKNOWN
                )
            out = self.tool(
                'fill_secret',
                elementId=element_id,
                itemType='password',
                provider='kakao',
                field=field,
                format=fmt,
            )
            if not out.strip().lower().startswith('ok'):
                raise AgentFailure(
                    'needs_human',
                    f'카카오페이 카톡결제 입력 실패({field}): {mask_text(out[:100])}',
                    FailReason.UNKNOWN,
                )
        button = _element_id_of(self.tool('get_page'), r'button "결제요청"')
        if button is None:
            raise AgentFailure('needs_human', '카카오페이 결제요청 버튼 없음', FailReason.UNKNOWN)
        self.tool('click', id=button)
        self.tool('wait', ms=KAKAO_REQUEST_WAIT_MS)
        self.note('카카오페이', '카톡결제 요청 보냄(휴대폰·생년월일은 키마스터 값)')
        # 폰 승인은 지금 앞 탭의 사이트 계정으로 결제 계정을 고른다 — 카카오페이 화면이 앞이면 계정을 못 찾아
        # 'no-account' 로 거절된다(실기 2026-09-30). 승인 동안 구매 계정 프로필로 소싱처 첫 화면을 앞에 둔다
        listed = self.tool('list_tabs')
        kakao_tab = _active_tab_id(listed)
        if not kakao_tab:
            return None
        src = default_sources().by_id(str(a.handoff.get('buy_source') or a.order.source or ''))
        host = (src.login_host if src else '') or ''
        # 이미 열린 소싱처 탭(주문서 등)이 있으면 그것을 앞에 둔다 — 결제 도구 허용 목록에 new_tab 이 없다
        other = _other_tab_on_host(listed, host, kakao_tab) if host else None
        if other:
            self.tool('switch_tab', id=other)
            return kakao_tab, None
        profile = str(a.handoff.get('account') or a.order.account or '')
        if src is None or not src.home:
            return kakao_tab, None
        opened = self.tool(
            'run_js',
            code=(
                f'const t = await tabs.open({json.dumps({"url": src.home, **({"profile": profile} if profile else {})})}); '
                'return (t && t.id) || ""'
            ),
        )
        self.tool('wait', ms=KAKAO_TAB_WAIT_MS)
        m = re.search(r'[0-9a-fA-F-]{8,}', opened)
        return kakao_tab, (m.group(0) if m else None)

    def _provider_from_payment_popup(self) -> str | None:
        """지금 열린 결제창(팝업)의 호스트로 결제 앱을 고른다. 결제창이 없거나 아는 결제
        앱의 호스트가 아니면 None — 그때는 phone_approve_payment 를 부르지 않고 웹 결제
        경로로 간다.

        결제창이 하나도 없으면(팝업 0개) 사이트가 아직 못 띄웠을 수 있으니 wait 로 한 번만
        기다렸다 다시 본다(리뷰 지적 — Minor 4). 그래도 없으면 웹 결제 경로다.

        결제 호스트에 매칭되는 팝업이 여럿이면 그 팝업을 연 탭(openerId)이 지금 활성 탭인
        것을 우선 쓴다 — 지금 사람이 보고 있는 흐름에서 뜬 결제창이라는 뜻이라 다른 팝업과
        provider 가 갈려도 그것을 쓴다. 활성 탭이 연 팝업이 하나도 없으면, 모두 같은 결제
        앱이면 목록의 마지막(가장 최근에 뜬 것)을 쓰지만 서로 다른 결제 앱을 가리키면 어느
        쪽인지 코드가 짐작하지 않고 사람에게 넘긴다(근거에 호스트를 남긴다, 리뷰 지적 — Important 2)."""
        popups, active_tab_ids = self._list_tabs_popups()
        if not popups:
            self.tool('wait', ms=PAY_POPUP_WAIT_MS)
            popups, active_tab_ids = self._list_tabs_popups()
        if not popups:
            return None

        matches = [
            (str(p['url']), _pay_provider_from_host(str(p['url'])), p.get('openerId'))
            for p in popups
        ]
        matches = [
            (url, provider, opener) for url, provider, opener in matches if provider is not None
        ]
        if not matches:
            return None

        for url, provider, opener in matches:
            if opener is not None and str(opener) in active_tab_ids:
                return provider

        providers = {provider for _, provider, _ in matches}
        if len(providers) > 1:
            hosts = ', '.join(url for url, _, _ in matches)
            raise AgentFailure(
                'needs_human',
                f'결제창이 여럿이고 서로 다른 결제 앱을 가리킨다 — 사람이 확인한다: {hosts}',
                FailReason.UNKNOWN,
            )
        return matches[-1][1]

    def _check_order_form(self, a: Assignment) -> None:
        """지금 화면(주문서)에 이 주문의 옵션과 상품명 고유 단어가 있는지 본다. 없으면 결제하지 않고 멈춘다."""
        # sku 는 삼바웨이브 상품명(+[옵션])이다(queue/orders._normalize). 교차 구매면 산 사이트의 상품명
        name, option, selected = expect_name(a), a.order.option, str(a.handoff.get('selected') or '')
        self._arrival_memo: str | None = None
        if not order_form_keys(name, option, selected):
            return  # 대조할 단어·사이즈가 없다(시험 표본 등)
        # 구매가 만든 주문서 탭을 먼저 앞으로 — 활성 탭이 다른 페이지면 엉뚱한 화면을 대조한다
        # (결제 진입 스크립트도 같은 tab 을 받아 그 탭에서 따로 대조한다)
        order_tab = a.handoff.get('order_tab')
        if order_tab:
            self.tool('switch_tab', id=str(order_tab))
        page = self.tool('get_page')
        # 도착예정일이 3일을 넘으면 기록 단계가 삼바웨이브 메모·샵마인 추가메모에 남긴다(사용자 2026-09-30)
        self._arrival_memo = arrival_memo(page, datetime.now(_KST).date())
        if self._arrival_memo:
            self.note('도착예정', self._arrival_memo)
        # 사이트 상품명(구매 스냅샷이 상품 페이지에서 읽은 이름)·상품번호로도 본다 — 주문서가 영문명만 보이고
        # 모델코드를 안 보이는 사이트에서 같은 상품을 막던 오탐(실기 2026-09-26 ABC job 198·204)
        site_name = str(a.handoff.get('product_name') or '')
        product_no = str(a.handoff.get('product_no') or '') or product_no_of(a.order.product_url)
        problem = order_form_mismatch(
            page,
            name,
            option,
            selected,
            site_name=site_name if site_name != name else '',
            product_no=product_no,
            # 구매가 상품번호로 확인한 상품 페이지에서 연 주문서 탭이면 사이트 상품명으로 대조해도 된다
            trust_site=bool(order_tab and site_name),
        )
        if problem:
            raise AgentFailure(
                'needs_human', f'주문서가 이 주문과 다르다 — 결제하지 않음: {mask_text(problem)}', FailReason.VERIFY_MISMATCH
            )
        self.note('주문서 대조', '상품·옵션 일치 확인')

    def _web_pay(self, a: Assignment) -> None:
        """사이트 결제창(팝업)의 '결제하기' → 웹 키패드에 fill_secret(password) — 플레이북 §7 무신사머니 흐름.

        결제창이 뜨면 그 창으로 옮겨 '결제하기'를 한 번 누른다(무신사머니 금액 확인창). 이어 뜨는 비밀번호
        키패드는 앱이 배치를 읽어 누른다(fill_secret, provider 는 앱이 결제창으로 고른다). 결제창이 없으면
        지금 화면의 키패드를 바로 찾는다. 비밀번호 값은 어디서도 다루지 않는다.
        """
        # 결제창 로그인 시도는 주문(작업)마다 한 번 — 에이전트 객체는 작업을 넘어 재사용되므로 여기서 초기화한다
        self._popup_login_tried = False
        # 결제창은 중간 창(money.musinsapayments.com/bridge)이 닫히고 /payment 창이 새로 뜬다 — 그 사이엔
        # '결제하기'가 없고, 처음 본 창은 사라진다. 매번 결제창 목록을 다시 읽어 가장 최근 창에서 버튼을 찾는다
        # (실기 2026-09-25: 첫 창만 보다 버튼을 못 눌러 결제 미완료 3건)
        pay_btn = None
        seen_popup = False
        for _ in range(PAY_BUTTON_POLL_TRIES):
            popups, _active = self._list_tabs_popups()
            self._stop_if_login_popup(popups, a)
            # 웹 결제창 — 사이트 결제창과 PC 에서 끝내는 간편결제 창(네이버페이·페이코)의 '결제하기'를 누른다
            web = [
                p
                for p in popups
                if p.get('id')
                and _host_of(str(p.get('url') or ''))
                and _pay_host_provider(str(p.get('url') or '')) in (None, *PC_PAY_PROVIDERS)
            ]
            if web:
                seen_popup = True
                self.tool('switch_tab', id=str(web[-1]['id']))
                pay_btn = _element_id(self.tool('find_elements', query='결제하기'))
                if pay_btn is not None:
                    break
            self.tool('wait', ms=PAY_BUTTON_POLL_WAIT_MS)
        if pay_btn is None and self._payco_agree_and_pay(
            str(a.handoff.get('card') or a.options.get('card') or '')
        ):
            seen_popup = True
            pay_btn = -1  # 페이코 창의 '결제'는 위에서 눌렀다
        if seen_popup and pay_btn is None:
            self.note('결제창', '결제하기 버튼이 뜨지 않음 — 키패드를 바로 찾는다')
        if pay_btn is not None and pay_btn >= 0:
            self.step('payer: 결제창 결제하기')
            self.tool('click', id=pay_btn, label='결제하기')
            self.tool('wait', ms=PAY_POPUP_WAIT_MS)
        # 결제 비밀번호 종류 — 무신사페이는 무신사머니와 비밀번호가 따로다(musinsapay), 사이트 머니는 'site'.
        # 계정에 비밀번호가 여럿이면 없을 때 모호하다(실기)
        card = str(a.handoff.get('card') or a.options.get('card') or '')
        provider = web_pay_provider(card)
        account = str(a.handoff.get('account') or a.order.account or '')
        self.step('payer: 결제 비밀번호(앱 입력)')
        out = self._press_keypad(a, provider, account)
        self.note('키패드 입력', mask_text(out[:200]))
        low = out.lower()
        if low.startswith('refused') or 'not found' in low or 'ambiguous' in low:
            raise AgentFailure(
                'needs_human',
                f'결제 비밀번호를 앱이 넣지 못했다 — 사람이 직접 누른다: {mask_text(out[:100])}',
                FailReason.PERMISSION_DENIED,
            )
        self.tool('wait', ms=PAY_RESULT_WAIT_MS)

    # 결제창 로그인 화면에서 앱 login 을 시도했는가 — 작업당 한 번만(반복하면 계정 잠김·캡차)
    _popup_login_tried: bool = False

    def _stop_if_login_popup(self, popups: list[dict[str, object]], a: Assignment) -> None:
        """결제창이 로그인 화면이면 멈춘다 — 결제 비밀번호를 로그인 칸에 넣거나 헛되이 반복하지 않는다.

        실기 2026-09-27 ABC 214·218: 프로필의 네이버 로그인이 풀려 네이버페이 창이 nid.naver.com 로그인으로 갔고,
        payer 는 '결제하기'·키패드를 못 찾은 채 fill_secret 을 10회씩 부른 뒤 '결제 확인 안 됨'으로 멈췄다.

        롯데온처럼 결제창이 팝업이 아니라 같은 탭에서 넘어가는 경우(keypad_in_tab)도 활성 탭이 로그인 화면이면 같게 본다
        (실기 2026-09-30: 같은 탭 nid.naver.com 로그인의 '비밀번호' 글자를 키패드로 착각해 fill_secret 거절 10회)."""
        same_tab: list[dict[str, object]] = []
        try:
            listed = json.loads(str(getattr(self, '_last_listed', '') or '[]'))
            if isinstance(listed, list):
                same_tab = [
                    t for t in listed
                    if isinstance(t, dict) and t.get('active') and _is_login_url(str(t.get('url') or ''))
                ]
        except ValueError:
            same_tab = []
        for p in [*popups, *[t for t in same_tab if t not in popups]]:
            url = str(p.get('url') or '')
            if _is_login_url(url):
                profile = str(a.handoff.get('account') or a.order.account or '')
                self.note('결제창', mask_text(f'로그인 화면: {_host_of(url)}'))
                # 앱의 login 은 결제창을 연 쇼핑몰 계정에 연결된 앱 계정(네이버 등)으로 로그인한다 — 한 번만 시도하고
                # (2단계 인증·캡차면 그대로 사람 확인), 로그인 화면이 사라졌으면 결제를 이어 간다(실기 2026-09-28
                # ABC 5계정 비교: buyer02·buyer04 프로필의 네이버 세션이 풀려 있었다)
                if p.get('id') and not self._popup_login_tried:
                    self._popup_login_tried = True
                    try:
                        self.tool('switch_tab', id=str(p['id']))
                        out = self.tool('login').strip()
                    except AgentFailure as e:
                        out = f'error: {e.reason}'
                    self.note('결제창 로그인', mask_text(out[:80]))
                    if out.lower().startswith(('submitted', 'ok', 'filled')):
                        self.tool('wait', ms=POPUP_LOGIN_SETTLE_MS)
                        popups_now, _active = self._list_tabs_popups()
                        try:
                            now = json.loads(str(getattr(self, '_last_listed', '') or '[]'))
                        except ValueError:
                            now = []
                        tab_login = any(
                            isinstance(t, dict) and t.get('active') and _is_login_url(str(t.get('url') or ''))
                            for t in (now if isinstance(now, list) else [])
                        )
                        if not tab_login and not any(_is_login_url(str(q.get('url') or '')) for q in popups_now):
                            return
                raise AgentFailure(
                    'needs_human',
                    f'결제창이 로그인 화면이다({_host_of(url)}) — 프로필 {profile or "-"} 에서 결제 앱(네이버 등)에 '
                    '먼저 로그인해야 한다. 결제 비밀번호는 넣지 않았다(결제 안 됨)',
                    FailReason.PERMISSION_DENIED,
                )

    def _press_keypad(
        self, a: Assignment, provider: str | None, account: str, dry_run_digits: int | None = None
    ) -> str:
        """웹 결제 키패드에 앱이 결제 비밀번호를 넣게 한다(fill_secret). 앱 응답 문구를 돌려준다.

        키패드는 결제하기 뒤 늦게, 다른 팝업에 뜰 수 있다 — 최근 팝업부터 돌며 뜰 때까지 기다렸다 다시 부른다.
        다시 부르는 것은 앱이 '아직 키패드 아님'(아무것도 누르지 않음)으로 답한 때뿐이다. 그 밖의 응답이 한 번이라도
        오면 결과가 무엇이든 다시 부르지 않는다(이중결제·결제 수단 잠금 방지). 부르는 총 횟수는
        KEYPAD_FILL_MAX_CALLS 를 넘지 않고, 끝까지 키패드가 없으면 결제 확인으로 가지 않고 바로 멈춘다."""
        out = ''
        calls = 0
        entered = False  # 앱이 '아직 아님'이 아닌 답을 한 번이라도 했다 — 이후 절대 다시 부르지 않는다
        for attempt in range(KEYPAD_POLL_TRIES):
            popups, _active = self._list_tabs_popups()
            self._stop_if_login_popup(popups, a)
            targets = [str(p['id']) for p in reversed(popups) if p.get('id')] or ['']
            for tab_id in targets:
                if calls >= KEYPAD_FILL_MAX_CALLS:
                    break
                if tab_id:
                    self.tool('switch_tab', id=tab_id)
                found = self.tool('find_elements', query=KEYPAD_QUERY)
                calls += 1
                try:
                    out = self.tool(
                        'fill_secret',
                        elementId=_element_id(found) or 0,
                        itemType='password',
                        **({'dryRunDigits': dry_run_digits} if dry_run_digits else {}),
                        **({'provider': provider} if provider else {}),
                        **({'accountLabel': account} if account else {}),
                    )
                except AgentFailure as e:
                    # 앱 거절은 예외로 온다 — 문구로 바꿔 '아직 키패드 아님'이면 다시 본다
                    out = e.reason
                if not _keypad_not_ready(out):
                    entered = True
                    if out.lstrip().startswith('handoff'):
                        # 앱이 사람에게 넘겼다 — 왜 못 눌렀는지(배치 인식·금고 잠김)는 단계 기록에만 있다
                        failed = [label for label, ok in getattr(self, 'last_steps', ()) if not ok]
                        self.note('키패드 넘김 사유', mask_text(' / '.join(failed)[:300]) or '기록 없음')
                        try:
                            # 어떤 화면에서 넘겼는지(키패드가 아닌 안내·오류 화면일 수 있다) 앞부분만 남긴다
                            seen = self.tool('get_page')
                            text = seen[seen.find('PAGE TEXT') :] if 'PAGE TEXT' in seen else seen
                            self.note('키패드 넘김 화면', mask_text(seen[:120] + ' … ' + text[:400]))
                            # 요소 종류·이름 앞부분만(값은 없다) — 버튼을 왜 못 찾았는지 본다
                            kinds = [ln[:48] for ln in seen.splitlines() if ln.startswith('[')]
                            self.note('키패드 넘김 요소', f'{len(kinds)}개: ' + ' ; '.join(kinds[:40]))
                        except AgentFailure as e:
                            self.note('키패드 넘김 화면', mask_text(f'못 읽음: {e.reason}'[:160]))
                    break
            if entered or calls >= KEYPAD_FILL_MAX_CALLS:
                break
            if attempt + 1 < KEYPAD_POLL_TRIES:
                self.tool('wait', ms=KEYPAD_POLL_WAIT_MS)
        if not entered:
            # 키패드가 끝내 없었다 — 앱은 아무것도 누르지 않았다. 결제 확인으로 넘기면 '결제 여부 불명'으로 오판한다
            self.note('키패드 입력', mask_text(f'키패드 없음({calls}회 확인): {out[:160]}'))
            # 그때 화면(주소·제목·앞 글자)을 남긴다 — 로그인 창·확인 버튼 창 등 원인을 바로 알 수 있게(실기 2026-09-30)
            try:
                listed = json.loads(str(self.tool('list_tabs')))
                seen = [
                    f"{t.get('kind')}{'*' if t.get('active') else ''}:{str(t.get('url') or '').split('//')[-1][:50]}"
                    f"|{str(t.get('title') or '')[:14]}"
                    for t in (listed if isinstance(listed, list) else [])
                    if isinstance(t, dict) and (t.get('kind') == 'popup' or t.get('active'))
                ]
                self.note('키패드 없음 화면', mask_text(' , '.join(seen))[:280])
            except (AgentFailure, ValueError):
                pass
            raise AgentFailure(
                'needs_human',
                f'결제 비밀번호 키패드가 뜨지 않았다({calls}회 확인) — 비밀번호를 넣지 않았다(결제 안 됨): '
                f'{mask_text(out[:100])}',
                FailReason.UNKNOWN,
            )
        return out

    def _confirm_paid(self, a: Assignment, card: str, paid_by: str = 'agent') -> AgentResult:
        """결제 뒤 성공 확인 — 완료 화면 문구, 없으면(ABC·그랜드스테이지) 주문내역의 방금 생긴 주문으로."""
        self.step('payer: 성공 확인')
        page = self._success_page(a)
        # 탭 안 키패드(네이버페이 → 롯데온) 는 승인 뒤 주문 완료로 돌아오는 데 4초보다 오래 걸린다
        # (실기 2026-09-28 컬럼비아: 결제됐는데 '확인되지 않는다') — 완료 문구가 뜰 때까지 몇 번 더 본다
        for _ in range(PAY_RESULT_POLL_TRIES):
            if any(m in page for m in PAY_SUCCESS_MARKERS):
                break
            self.tool('wait', ms=PAY_RESULT_POLL_WAIT_MS)
            page = self._success_page(a)
        recent_no = None
        if not any(m in page for m in PAY_SUCCESS_MARKERS):
            # ABC마트·그랜드스테이지는 네이버페이 뒤 완료 화면을 못 잡는 일이 있다 — 주문내역에서 방금(10분 안) 생긴
            # 결제완료 주문을 찾아 확인한다(실기 2026-09-25 반스: 결제됐는데 '확인되지 않는다'로 멈춤)
            # 29CM 도 페이코 뒤 완료 화면을 못 잡는 일이 있다(실기 2026-09-27 job 244: 결제됐는데 멈춤)
            recent_no = self._recent_art_order(a) or self._recent_cm29_order(a)
            if recent_no:
                page = f'결제완료 주문번호 {recent_no}'
        if not any(m in page for m in PAY_SUCCESS_MARKERS):
            raise AgentFailure(
                'needs_human',
                '결제됐는지 화면에서 확인되지 않는다 — 사람이 봐야 한다(재결제 금지)',
                FailReason.VERIFY_MISMATCH,
            )
        self.note('결제 성공', mask_text(page[:200]))
        # 누가 결제했는지(플레이북 §5-4) — 이 경로는 에이전트가 결제를 끝낸 것이다
        payload: dict[str, object] = {
            'dry_run': False,
            'paid': True,
            'paid_by': paid_by,
            'card': card,
        }
        if getattr(self, '_arrival_memo', None):
            payload['arrival_memo'] = self._arrival_memo
        try:
            tabs_now = self.tool('list_tabs')
        except AgentFailure:
            tabs_now = ''
        source_order_no = recent_no or _source_order_no(page, tabs_now)
        if source_order_no is None:
            # 완료 문구는 봤는데 화면에서 번호를 못 뽑았다 — 주문내역 폴백으로 채운다
            # (실기 2026-09-27 job 262 ABC 네이버페이: 결제됐는데 recorder 가 '기입할 소싱주문번호가 없다'로 멈춤)
            source_order_no = self._recent_art_order(a) or self._recent_cm29_order(a)
        if source_order_no is not None:
            payload['source_order_no'] = source_order_no
            self.note('소싱 주문번호', source_order_no)
        return AgentResult(
            status='ok',
            reason=f'{card} 로 결제 완료를 화면에서 확인했다',
            payload=payload,
            evidence=tuple(self.evidence),
        )

    def _wait_direct_card(
        self, a: Assignment, card: str, issuer: str, entered: dict[str, object]
    ) -> AgentResult:
        """카드 직접 결제(H몰 롯데카드) — 결제창이 뜬 뒤 사람이 카드사 앱으로 승인할 때까지 주문 완료를 기다린다.

        에이전트는 결제창(KSNET 안심클릭 → 롯데카드 앱카드·간편결제·일반결제)에서 아무것도 누르지 않는다 — 결제창 종류와
        비밀번호 키패드 제공자를 모른다(키마스터 H몰 'other' 항목은 이름이 '기타'뿐이라 무엇인지 확정 못 함). 주문 완료가
        보이면 사람이 결제한 것으로 기록하고, 시간 안에 안 보이면 멈춘다(재결제 금지).
        """
        window = str(entered.get('popup_url') or '')
        self.note(
            '카드 직접 결제',
            mask_text(f'{issuer} 결제창({entered.get("pay_window") or "-"} {window[:80]}) — 사람이 폰으로 승인한다. 에이전트는 누르지 않는다'),
        )
        self.step(f'payer: {issuer} 결제창 — 사람 승인(폰) 대기')
        order_tab = str(a.handoff.get('order_tab') or '')
        for _ in range(DIRECT_CARD_WAIT_TRIES):
            self.tool('wait', ms=DIRECT_CARD_POLL_MS)
            try:
                if order_tab:
                    self.tool('switch_tab', id=order_tab)
                page = self.tool('get_page')
            except AgentFailure:
                continue
            if any(m in page for m in _DIRECT_CARD_DONE):
                self.note('카드 직접 결제', '주문 완료 화면 확인 — 사람이 승인했다')
                return self._confirm_paid(a, card, paid_by='human')
        raise AgentFailure(
            'needs_human',
            f'{issuer} 결제창 승인을 기다렸지만 주문 완료가 보이지 않는다 — 사람이 결제 여부를 확인한다(재결제 금지)',
            FailReason.PAY_INTERRUPTED,
        )

    def _payco_agree_and_pay(self, card: str = '') -> bool:
        """페이코 PC 결제창(bill.payco.com) — 버튼이 '결제하기'가 아니라 '결제' 링크이고 정보제공동의를 켜야 한다.

        동의를 켜고 '결제'를 누르면 페이코 결제 비밀번호 키패드가 뜬다(비밀번호 없이는 결제되지 않는다).
        실기 2026-09-25 르무통: '결제하기'만 찾다 못 찾아 키패드 없이 멈췄다. 페이코 창이 아니면 False.
        """
        popups, _active = self._list_tabs_popups()
        payco = [
            p
            for p in popups
            if p.get('id') and _host_of(str(p.get('url') or '')).endswith('bill.payco.com')
        ]
        if not payco:
            return False
        want = json.dumps(list(payco_card_names(card)), ensure_ascii=False)
        code = (
            f'await tabs.switch({json.dumps(str(payco[-1]["id"]))})\n'
            f'const WANT = {want}\n' + _PAYCO_AGREE_PAY_JS
        )
        try:
            out = self.tool('run_js', code=code)
        except AgentFailure as e:
            self.note('페이코 결제', mask_text(f'동의·결제 누르기 실패({e.reason[:80]})'))
            return False
        self.note('페이코 결제', mask_text(out[:160]))
        if 'card-not-found' in out:
            # 결제는 누르지 않았다 — 다른 카드로 내면 청구할인이 없어 견적과 원가가 달라진다
            raise AgentFailure(
                'needs_human',
                mask_text(f'페이코 결제창에서 견적 카드를 못 찾았다 — 결제하지 않았다: {out[:120]}'),
                FailReason.CARD_MISSING,
            )
        return '"clicked":true' in out.replace(' ', '')

    def _recent_art_order(self, a: Assignment) -> str | None:
        return recent_art_order(self, a)

    def _recent_cm29_order(self, a: Assignment) -> str | None:
        return recent_cm29_order(self, a)

    def _success_page(self, a: Assignment | None = None) -> str:
        """결제 뒤 화면 — 주문 완료 탭(…/order/result/…, 29CM …/order/confirmed/…)이 있으면 그 탭에서 읽는다.

        다른 레인(사람·다른 세션)이 연 탭은 보지 않는다 — 실기 2026-09-28: 검수용 레인의 무신사 주문 상세 탭을
        ABC 결제 성공 화면으로 읽어 엉뚱한 소싱주문번호(무신사)를 기입했다. 소싱처 상품 주소와 같은 도메인의
        탭만 후보로 본다.
        """
        try:
            listed = self.tool('list_tabs')
            try:
                tabs = json.loads(listed)
            except ValueError:
                tabs = []
            want = _host_of(str(a.order.product_url or '')) if a is not None else ''
            want_domain = '.'.join(want.split('.')[-2:]) if want else ''
            for t in tabs if isinstance(tabs, list) else []:
                if not isinstance(t, dict) or t.get('lane'):
                    continue
                url = str(t.get('url') or '')
                if not re.search(r'order/(?:result|confirmed)', url):
                    continue
                if want_domain and want_domain not in _host_of(url):
                    continue
                self.tool('switch_tab', id=str(t.get('id')))
                break
        except AgentFailure:
            pass
        return self.tool('get_page')

    def _dry_run_keypad(self, a: Assignment, card: str, digits: int) -> AgentResult:
        """결제창까지 간 뒤 결제 비밀번호를 `digits` 자리만 눌러 보고 취소한다.

        실기에서 키패드 자동 입력이 되는지만 보는 길이다 — 결제는 어느 경로에서도 끝나지
        않는다. 결제 앱이 정해지면 폰 승인 도구로, 아니면 웹 키패드(fill_secret)로 간다.
        비밀번호 값은 앱 안에만 있고 여기로는 자리수조차 오지 않는다(돌아오는 것은 문구뿐)."""
        self.step(f'payer: 시험 입력 — 결제 비밀번호 {digits}자리만 누르고 취소')
        provider = _pay_provider(card) or self._provider_from_payment_popup()
        if provider is not None:
            amount = _amount_krw(a.handoff.get('cost'))
            if amount is None:
                raise AgentFailure(
                    'needs_human',
                    '결제 금액을 모른다 — 시험 입력도 하지 않는다',
                    FailReason.UNKNOWN,
                )
            # 카드사(card_issuer)가 있으면 결제 앱 검색어로, 없고 카드 이름 자체가 결제 앱(예: 토스페이)이면 카드 아님
            card_hint = card_app_code(a.handoff.get('card_issuer')) or (
                None if _pay_provider(card) else card
            )
            out = self.tool(
                'phone_approve_payment',
                provider=provider,
                amountKrw=amount,
                merchant=a.order.source,
                methodLabel=card,
                dryRunDigits=digits,
                **({'card': card_hint} if card_hint else {}),
            )
        else:
            # 결제 앱이 없다 — 사이트 결제창의 웹 키패드다. 요소 번호는 스키마가 요구해서 찾는다
            # 키패드는 결제하기 뒤 늦게·다른 팝업에 뜬다 — 실결제 경로(_web_pay)처럼 최근 팝업부터 다시 본다
            # (실기: 29CM 무신사페이 시험 입력이 키패드 전에 눌려 'target is not a secret input')
            label = str(a.handoff.get('account') or a.order.account or '')
            out = self._press_keypad(a, web_pay_provider(card), label, dry_run_digits=digits)
        self.note('시험 입력', mask_text(out[:200]))
        if not any(m in out.lower() for m in DRY_RUN_MARKERS):
            # 시험 입력이라고 했는데 시험 입력 응답이 아니다 — 결제가 진행됐을 수 있다
            raise AgentFailure(
                'needs_human',
                f'시험 입력 응답이 아니다 — 사람이 결제 상태를 확인한다: {mask_text(out[:100])}',
                FailReason.PAY_INTERRUPTED,
            )
        return AgentResult(
            status='ok',
            reason=f'dry-run: 결제 비밀번호 {digits}자리만 눌러 보고 취소했다(결제 안 함)',
            payload={'dry_run': True, 'paid': False, 'keypad_tested': True, 'digits': digits},
            evidence=tuple(self.evidence),
        )

    def _pay(self, a: Assignment) -> AgentResult:
        self.evidence = []
        # 요청자가 지정한 카드가 먼저, 없으면 구매 에이전트가 고른 카드다(리뷰 지적 — C3)
        card = a.options.get('card') or a.handoff.get('card')
        card = str(card) if card else None
        if not card:
            # 감독자가 이미 검사하지만, 결제 직전에 한 번 더 막는다
            raise AgentFailure('fail', '결제할 카드가 없다', FailReason.CARD_MISSING)

        self._recheck_wave(a)

        if a.dry_run and card == POINTS_ONLY_METHOD:
            # 포인트 전액 결제는 결제하기 한 번에 주문이 끝난다 — 시험에서는 결제창 진입 스크립트도 부르지 않는다
            self.step('payer: dry-run — 포인트 전액 결제라 결제하기를 누르지 않고 끝낸다')
            return AgentResult(
                status='ok',
                reason='dry-run: 포인트 전액 결제 — 결제하기를 누르지 않았다(결제 안 함)',
                payload={'dry_run': True, 'paid': False, 'points_only': True},
                evidence=tuple(self.evidence),
            )

        # 결제 직전 — 지금 주문서가 이 주문의 상품·옵션인가. 다른 작업이 남긴 주문서를 결제하면 안 된다
        # (실기 2026-09-26: 197 이 앞 작업 196 의 아디다스 210 주문서를 결제했다)
        self._check_order_form(a)

        self.step('payer: 결제창 진입')
        # 실제로 산 사이트(교차 비교) 기준으로 결제창에 들어간다
        script = checkout_script_for(str(a.handoff.get('buy_source') or a.order.source))
        payload: dict[str, object] = {'card': card}
        # 현금영수증은 항상 지출증빙용(사용자 2026-09-29 롯데온) — 사업자등록번호는 이 PC 의 local-aliases.json 에만 둔다.
        # 주문서 칸이 비어 있을 때만 스크립트가 넣는다
        biz_no = local_aliases.apply(BIZ_NO_ALIAS).removeprefix('biz:')
        if biz_no.isdigit() and set(biz_no) != {'0'}:
            payload['biz_no'] = biz_no
        profile = a.handoff.get('account') or a.order.account
        if profile:
            payload['profile'] = profile  # 구매가 연 계정 프로필의 주문서에서 결제창을 연다
        # 결제 진입 스크립트가 스스로 막게 넘긴다(2026-09-26 재작성 계약):
        # - dryRun: 시험 실행이면 결제 버튼 직전에서 멈춘다(예전엔 dry-run 에서도 {card, profile} 만 넘겨 버튼이 눌렸다)
        # - expect: 이 주문의 상품명·옵션·상품번호 — 주문서가 다르면 결제하지 않는다
        # - amount: 주문서 총액(견적) — 결제창 금액이 이보다 크면 멈춘다
        # - tab: 구매가 만든 주문서 탭 id(있으면 '가장 최근 탭' 대신 이것)
        if a.dry_run:
            payload['dryRun'] = True
        payload['expect'] = {
            # 결제 진입 스크립트는 사이트 주문서 글자만 본다 — 삼바 상품명(모델코드·한글명)이 아니라 구매 스냅샷이
            # 이 사이트에서 읽은 상품명으로 대조하게 한다(실기 2026-09-27: ABC 주문서엔 영문명만 있어 198 이 막힘).
            # 삼바 상품명과의 연결은 바로 위 _check_order_form 이 따로 본다
            'name': str(a.handoff.get('product_name') or '') or expect_name(a),
            'option': a.order.option or '',
            'selected': str(a.handoff.get('selected') or ''),
            # 구매가 스냅샷에서 읽은 번호 우선 — 교차 비교로 다른 사이트에서 사면 주문 URL 번호는 다른 사이트 것이다
            'product_no': str(a.handoff.get('product_no') or '') or product_no_of(a.order.product_url),
            # 구매 스냅샷이 도착한 상품 주소(SSG 처럼 지정 몰 상품으로 바꿔 사는 소싱처만 준다)
            **({'product_url': str(a.handoff.get('product_url'))} if a.handoff.get('product_url') else {}),
        }
        # 결제수단 견적이 고른 카드사(SSGPAY 안의 '현대카드' 등) — 결제 진입 스크립트가 등록 카드를 고른다.
        # 카드사를 모르면 스크립트가 추측하지 않고 멈춘다(checkout_enter_ssg)
        if a.handoff.get('card_issuer'):
            payload['issuer'] = str(a.handoff.get('card_issuer'))
        bought = default_sources().by_id(str(a.handoff.get('buy_source') or a.order.source or ''))
        if bought is not None and bought.allow_department:
            payload['allow_department'] = True  # SSG: 신세계백화점(6009) 상품도 결제한다(사용자 2026-09-27)
        amount = a.handoff.get('paid')
        if isinstance(amount, int | float) and not isinstance(amount, bool) and amount > 0:
            payload['amount'] = amount
        if a.handoff.get('order_tab'):
            payload['tab'] = str(a.handoff.get('order_tab'))
        # 결제창 진입은 AI 수리 대상이 아니다 — 비밀번호 없는 간편결제(무신사페이 카드 등)는 '결제하기' 한 번에
        # 결제가 끝난다(실기 2026-09-24: 수리 시험 중 결제하기 클릭으로 실결제 발생). 실패하면 사람에게 넘긴다
        raw_enter = self.tool(
            'run_script', name=script, args=json.dumps(payload, ensure_ascii=False)
        )
        body_enter, enter_dialogs = split_page_dialogs(raw_enter)
        if enter_dialogs:
            # 결제하기 뒤 뜬 경고창 — 결제창이 안 뜬 이유인 경우가 많다(예전엔 버려서 원인을 몰랐다)
            self.note('결제창 경고', mask_text(' | '.join(enter_dialogs)[:300]))
        try:
            parsed_enter = json.loads(body_enter)
        except ValueError:
            parsed_enter = None
        entered: dict[str, object] = (
            parsed_enter
            if isinstance(parsed_enter, dict)
            else {'ok': False, 'note': raw_enter[:120]}
        )
        self.note('결제창', mask_text(json.dumps(entered, ensure_ascii=False)[:400]))
        if not entered.get('ok'):
            # 결제하기를 못 눌렀다 — 비밀번호 단계로 가지 않는다(실기: 수단을 못 찾고도 키패드를 찾다 거절)
            raise AgentFailure(
                'needs_human',
                f'결제창을 열지 못했다: {mask_text(str(entered.get("error") or entered.get("note"))[:80])}'
                + (f' — {mask_text(str(entered.get("why"))[:160])}' if entered.get('why') else '')
                + (f' — 경고창: {mask_text(" | ".join(enter_dialogs)[:120])}' if enter_dialogs else '')
                + (f' — 화면: {mask_text(str(entered.get("note"))[:160])}' if entered.get('error') and entered.get('note') else ''),
                FailReason.UNKNOWN,
            )

        if entered.get('points_only') and not a.dry_run:
            # 포인트로 전액 결제 — 결제하기 한 번에 주문이 끝나 결제창·비밀번호가 없다(ABC 포인트 최대 사용, 사용자 2026-09-25).
            # 이미 결제된 화면 검사를 거치면 방금 끝난 주문을 재진입으로 오판하므로 바로 성공 확인으로 간다
            self.step('payer: 포인트 전액 결제 — 결제창 없음')
            return self._confirm_paid(a, card)

        issuer = direct_card_of(a)
        if a.dry_run and a.dry_run_digits > 0 and issuer:
            # 카드 직접 결제는 에이전트가 넣을 비밀번호 키패드가 없다(카드사 결제창은 사람이 승인) — 시험 입력도 없다
            self.step('payer: dry-run — 카드 직접 결제라 키패드 시험 없음')
            return AgentResult(
                status='ok',
                reason=f'dry-run: {issuer} 직접 결제 — 결제창 직전까지만 확인했다(키패드 시험 없음, 결제 안 함)',
                payload={'dry_run': True, 'paid': False, 'direct_card': issuer},
                evidence=tuple(self.evidence),
            )

        if a.dry_run and a.dry_run_digits > 0:
            # 키패드 시험 입력: 결제 비밀번호를 절반만 누르고 취소한다(결제는 하지 않는다)
            return self._dry_run_keypad(a, card, a.dry_run_digits)

        if a.dry_run:
            # 사용자 검토 전에는 여기까지만 한다(스펙 §10-1) — 부수효과 도구는 부르지 않는다
            self.step('payer: dry-run — 결제하지 않고 끝낸다')
            return AgentResult(
                status='ok',
                reason=f'dry-run: {card} 로 결제창까지만 확인했다',
                payload={'dry_run': True, 'paid': False},
                evidence=tuple(self.evidence),
            )

        # 폰 승인 전에 주문 상세를 딱 한 번 읽어 이미 결제됐는지 본다 — 재시작·재진입으로
        # 여기까지 다시 왔을 때 결제를 두 번 하지 않는다(리뷰 지적 — Critical 2 ③)
        self.step('payer: 이미 결제됐는지 확인')
        before = self.tool('get_page')
        try:
            listed = self.tool('list_tabs')
        except AgentFailure:
            listed = ''
        buy_src = default_sources().by_id(str(a.handoff.get('buy_source') or a.order.source))
        if looks_already_paid(listed, before, buy_src.login_host if buy_src else None):
            self.note('결제 전 확인', mask_text(before[:200]))
            raise AgentFailure(
                'needs_human',
                '이미 결제된 화면이다 — 사람이 확인한다(재결제 금지)',
                FailReason.PAY_INTERRUPTED,
            )

        # 결제 금액이 없으면 무엇을 결제하는지도 모르는 것이다 — 시작 자체를 하지 않는다.
        # 앱 스키마(tools-phone.ts)가 양의 정수 amountKrw 를 요구한다(I7)
        amount = _amount_krw(a.handoff.get('cost'))
        if amount is None:
            raise AgentFailure(
                'needs_human',
                '결제 금액을 모른다 — 확인 전에는 결제하지 않는다',
                FailReason.UNKNOWN,
            )

        if issuer:
            # 카드 직접 결제 — 카드사 결제창에서는 아무것도 누르지 않고 사람 승인(폰)을 기다린다
            return self._wait_direct_card(a, card, issuer, entered)

        # 신원정보 칸(주문자 연락처 등)은 사이트에 따라 있을 때만 채운다 — 무신사머니 결제창에는 없다(플레이북 §7)
        # 값은 앱이 직접 채운다 — 여기서는 어떤 비밀값도 보내거나 받지 않는다.
        found = self.tool('find_elements', query=IDENTITY_QUERY)
        element_id = _element_id(found)
        if element_id is not None:
            self.step('payer: 신원정보 입력')
            try:
                self.tool('fill_secret', elementId=element_id, itemType='identity')
            except AgentFailure as e:
                # 신원정보 칸이 아닌 요소가 잡힌 경우(실기: 무신사 주문서 "주문자" 글자) — 결제를 막지 않는다
                self.note('신원정보 입력', mask_text(f'건너뜀({e.reason[:80]})'))

        # 결제 앱은 사람이 지정하지 않는다 — 카드 이름 자체가 앱을 가리키면(예: 토스페이) 그것을,
        # 아니면 지금 뜬 결제창(팝업)의 호스트를 보고 정한다. phone_approve_payment 를 부르기
        # 직전에 판단해야 그사이 열린 결제창까지 본다
        self.step('payer: 결제 앱 확인')
        provider = _pay_provider(card)
        if provider is None:
            provider = self._provider_from_payment_popup()
        if provider in PC_PAY_PROVIDERS:
            # PC 결제창에서 비밀번호를 받는 결제(페이코) — 폰 승인이 아니라 웹 키패드 경로로 간다
            provider = None

        if provider == 'kakaopay' and _pay_provider(card) == 'kakaopay':
            # 카카오페이 PC 결제창은 QR/카톡결제 탭이다 — 카톡결제에 휴대폰·생년월일(키마스터 카카오페이 결제 항목)을 넣고
            # 결제요청을 눌러야 폰으로 결제 요청이 간다(사용자 2026-09-30 롯데온 카카오페이 머니)
            kakao_front = self._kakao_talk_request(a)
        else:
            kakao_front = None

        if provider is not None:
            self.step('payer: 폰 승인')
            # 카드사(card_issuer)가 있으면 결제 앱 검색어로, 없고 카드 이름 자체가 결제 앱(예: 토스페이)이면 카드 아님
            card_hint = card_app_code(a.handoff.get('card_issuer')) or (
                None if _pay_provider(card) else card
            )
            # payAccount 는 앱 스키마상 네이버페이 전용이다. 사용자 결정 — 결제 앱이 쇼핑몰
            # 계정에 연결된 네이버 계정으로 스스로 고르게 두고, 어떤 provider 에도 payAccount 를
            # 넘기지 않는다(리뷰 지적 — Critical 1)
            approved = self.tool(
                'phone_approve_payment',
                provider=provider,
                amountKrw=amount,
                merchant=a.order.source,
                methodLabel=card,
                **({'card': card_hint} if card_hint else {}),
            )
            self.note('폰 승인', mask_text(approved[:200]))
            if kakao_front:
                # 승인 동안 앞에 둔 소싱처 탭을 닫고, 카카오페이 결제창(승인 뒤 주문 완료로 넘어간다)으로 돌아간다
                self._restore_kakao_tab(*kakao_front)
            if any(m in approved for m in DECLINED_MARKERS):
                # 'refused:' 접두사 없는 과거 형식. 재시도 없음 — 그대로 사람에게 넘긴다(재결제 위험)
                raise AgentFailure(
                    'needs_human',
                    f'폰 승인 실패: {mask_text(approved[:100])}',
                    FailReason.UNKNOWN,
                )
        else:
            # 결제 앱이 없다 — 사이트 자체 결제창(무신사머니 등)의 웹 키패드 경로. 비밀번호는 앱(fill_secret)이 누른다
            self.step('payer: 결제 앱 없음 — 웹 결제창 경로')
            self._web_pay(a)

        return self._confirm_paid(a, card)
