"""Independent paid-order identity checks; never trust the buyer's selected value."""

import re


def option_key(value: object) -> str:
    return re.sub(r'[\s\-_/·,:()\[\]]+', '', str(value or '')).casefold()


def color_code_conflict(wanted: object, actual: object) -> bool:
    """Explicit parenthesized color codes must not change (M04 versus H24)."""
    codes = lambda s: set(re.findall(r'\(([A-Za-z]{1,4}\d{2,4})\)', str(s or '').upper()))
    w, a = codes(wanted), codes(actual)
    return bool(w and a and w != a)


_SIZE_ONLY = re.compile(r'^(?:\d{2,3}(?:\([a-z0-9]+\))?|\d?x{0,3}[sml]|free|f)$', re.IGNORECASE)


def _tokens(value: object) -> list[str]:
    """옵션 글자를 낱말로 — 주문 옵션에만 붙는 수량('1개')은 뺀다."""
    text = re.sub(r'(?<!\S)\d+\s*개(?!\S)', ' ', str(value or '').casefold())
    # 신발 사이즈 '250MM' 은 '250' 과 같다(실기 2026-11-04 롯데온 4127 'BLK(BLACK) 250 NS87R61A' ↔ '250MM')
    text = re.sub(r'(?<=\d)\s*mm\b', '', text)
    # 옵션 이름표 '[SIZE]S'·'[COLOR]블랙' 의 이름표는 값이 아니다(실기 2026-11-04 29CM 4131 '그레이 S' ↔ '[SIZE]S')
    text = re.sub(r'\[(?:size|color|colour|사이즈|색상|컬러|옵션)\]', ' ', text)
    return [t for t in re.split(r'[\s/:,·]+', text) if t]


def paid_option_matches(wanted: object, actual: object) -> bool:
    # 상세의 낱말이 모두 주문 옵션에 있고 그중 사이즈가 있으면 같다 — 주문에만 붙은 수량·품번은 무시한다
    # (실기 2026-11-03 4073 'LYONS BLUE 1개 100' ↔ 'LYONS BLUE · 100', 4039 '… 095(L) NJ3NR86A')
    got, want = _tokens(actual), _tokens(wanted)
    # 낱말이 똑같으면 같은 옵션이다 — 'ONE'(원사이즈)처럼 사이즈 꼴이 아닌 값도(실기 2026-11-03 4111 'LIGHT BEIGE ONE 1개' ↔ 'LIGHT BEIGE · ONE')
    if got and sorted(got) == sorted(want):
        return True
    # 원사이즈(FREE) 상품은 상세에 색상만 나온다 — 주문에만 있는 낱말이 FREE 뿐이면 같다(실기 2026-11-03 4121 '화이트 FREE' ↔ '화이트')
    if got and set(got) <= set(want) and set(want) - set(got) <= {'free', 'f', 'one', 'onesize', '프리', 'fr'}:
        return True
    want_set = set(want) | {t.split('(')[0] for t in want if '(' in t}
    if got and all(t in want_set for t in got) and any(_SIZE_ONLY.fullmatch(t) for t in got):
        return True
    # 색상이 상품에 묶인 사이트는 주문 상세에 사이즈만 보인다 — 사이즈뿐인 값은 주문 옵션 안에 그 사이즈가 있으면 같다.
    # 색상이 적혀 있는 값은 그대로 전체가 같아야 한다.
    if option_key(wanted) and option_key(wanted) == option_key(actual):
        return True
    # 반대로 주문 옵션이 사이즈뿐이면('L') 상세의 '01블랙+워시드브라운 · L' 안에 그 사이즈가 있으면 같다(실기 2026-11-03 무신사 4063)
    size, other = str(actual or '').strip(), wanted
    if not _SIZE_ONLY.fullmatch(size):
        size, other = str(wanted or '').strip(), actual
        if not _SIZE_ONLY.fullmatch(size):
            return False
    size = size.casefold()
    # '090(M)' 처럼 숫자 사이즈에 괄호 표기가 붙은 주문 옵션도 같은 사이즈다(실기 2026-11-03 무신사 4061)
    return any(
        tok == size or tok.startswith(size + '(')
        for tok in re.split(r'[\s/:,·]+', str(other or '').casefold())
    )
