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


def paid_option_matches(wanted: object, actual: object) -> bool:
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
