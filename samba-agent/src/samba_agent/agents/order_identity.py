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


_KO_COLOR = {
    '블랙': 'black', '검정': 'black', '화이트': 'white', '흰색': 'white', '그레이': 'grey', '회색': 'grey',
    '베이지': 'beige', '네이비': 'navy', '아이보리': 'ivory', '샌드': 'sand', '크림': 'cream', '코코아': 'cocoa',
    '초코': 'choco', '체스트넛': 'chestnut', '브라운': 'brown', '카키': 'khaki', '블루': 'blue', '그린': 'green',
    '핑크': 'pink', '레드': 'red', '차콜': 'charcoal', '퍼플': 'purple', '옐로우': 'yellow', '오렌지': 'orange',
    '민트': 'mint', '실버': 'silver', '골드': 'gold', 'gray': 'grey',
}


def _tokens(value: object) -> list[str]:
    """옵션 글자를 낱말로 — 주문 옵션에만 붙는 수량('1개')은 뺀다."""
    text = re.sub(r'(?<!\S)\d+\s*개(?!\S)', ' ', str(value or '').casefold())
    # 신발 사이즈 '250MM' 은 '250' 과 같다(실기 2026-11-04 롯데온 4127 'BLK(BLACK) 250 NS87R61A' ↔ '250MM')
    text = re.sub(r'(?<=\d)\s*mm\b', '', text)
    # 옵션 이름표 '[SIZE]S'·'[COLOR]블랙' 의 이름표는 값이 아니다(실기 2026-11-04 29CM 4131 '그레이 S' ↔ '[SIZE]S')
    text = re.sub(r'\[(?:size|color|colour|사이즈|색상|컬러|옵션)\]', ' ', text)
    # '옵션:선택안함' 의 '옵션:' 도 이름표다(실기 2026-11-10 20261109C14534)
    text = re.sub(r'(?<!\S)옵션\s*[:：]', ' ', text)
    # 원사이즈 표기 ONE·OS·F·프리는 FREE 와 같다(실기 2026-11-04 롯데온 4133 'WHS(WHITE SAND) FREE' ↔ 'ONE')
    # 무신사 모자의 OSFM(One Size Fits Most)도 원사이즈다(실기 2026-11-07 뉴에라 '블랙 프리 사이즈' ↔ 'OSFM')
    one = {'one', 'onesize', 'os', 'osfm', 'f', '프리', 'fr'}
    # 한글 색은 영문 선택지와 같은 색이다(실기 2026-11-09 무신사 4730 '코코아 230' ↔ 'COCOA · 230', '블랙' ↔ 'BLACK')
    return [
        'free' if t in one else _KO_COLOR.get(t, t) for t in re.split(r'[\s/:,·]+', text) if t
    ]


# 글자 사이즈 → 한국 숫자 사이즈(여성은 한 칸 아래, 남성은 한 칸 위라 두 값을 다 허용한다)
_LETTER_KR_SIZES: dict[str, set[int]] = {
    'XXS': {75, 80},
    '2XS': {75, 80},
    'XS': {80, 85},
    'S': {85, 90},
    'M': {90, 95},
    'L': {95, 100},
    'XL': {100, 105},
    'XXL': {105, 110},
    '2XL': {105, 110},
    '3XL': {110, 115},
}


def paid_option_matches(wanted: object, actual: object) -> bool:
    # 상세의 낱말이 모두 주문 옵션에 있고 그중 사이즈가 있으면 같다 — 주문에만 붙은 수량·품번은 무시한다
    # (실기 2026-11-03 4073 'LYONS BLUE 1개 100' ↔ 'LYONS BLUE · 100', 4039 '… 095(L) NJ3NR86A')
    # 판매 옵션의 '상세 이미지 참조'·'상세페이지 참고' 는 색상 자리를 비운 안내 글자다 — 값이 아니다
    # (실기 2026-11-05 4298 '상세 이미지 참조 L' ↔ 'BLACK · L', 11-04 4153·4162·4202·4261 같은 꼴)
    wanted = re.sub(r'상세\s*(?:이미지|페이지)?\s*(?:참조|참고)', ' ', str(wanted or '')).strip()
    got, want = _tokens(actual), _tokens(wanted)
    # 낱말이 똑같으면 같은 옵션이다 — 'ONE'(원사이즈)처럼 사이즈 꼴이 아닌 값도(실기 2026-11-03 4111 'LIGHT BEIGE ONE 1개' ↔ 'LIGHT BEIGE · ONE')
    if got and sorted(got) == sorted(want):
        return True
    # 상세가 한국 숫자 사이즈 하나('085')뿐이고 주문은 글자 사이즈('다크그레이 S') — 글자↔숫자 표에 맞으면 같다(색은 지정 상품이 정한다)
    # (실기 2026-11-14 롯데온 나이키 21315225647113299 'S' ↔ '085' 를 맞게 샀는데 불일치로 멈춤)
    if len(got) == 1 and re.fullmatch(r'\d{2,3}', got[0]):
        letters = [t.upper() for t in want if t.upper() in _LETTER_KR_SIZES]
        if len(letters) == 1 and int(got[0]) in _LETTER_KR_SIZES[letters[0]] and not any(re.search(r'\d', t) for t in want):
            return True
    # 색 이름 띄어쓰기만 다른 경우('다크그레이 L' ↔ '플랫 다크 그레이 / … [SIZE]L') — 사이즈 낱말은 똑같이 있고
    # 주문의 나머지 낱말이 띄어쓰기를 뺀 상세 글자 안에 그대로 있으면 같다(실기 2026-11-14 29CM 21315225880503299)
    raw_want = [t for t in re.split(r'\s+', wanted.casefold()) if t]
    size_want = [t for t in raw_want if _SIZE_ONLY.fullmatch(t)]
    rest_want = [t for t in raw_want if not _SIZE_ONLY.fullmatch(t)]
    compact = re.sub(r'\s+', '', str(actual or '').casefold())
    if size_want and rest_want and all(t in got for t in size_want) and all(len(t) >= 2 and t in compact for t in rest_want):
        return True
    # 원사이즈(FREE) 상품은 상세에 색상만 나온다 — 주문에만 있는 낱말이 FREE 뿐이면 같다(실기 2026-11-03 4121 '화이트 FREE' ↔ '화이트')
    if got and set(got) <= set(want) and set(want) - set(got) <= {'free', 'f', 'one', 'onesize', '프리', 'fr'}:
        return True
    # 주문엔 색만 있고('그레이') 상세엔 원사이즈(FREE)만 보이는 단일 옵션 상품 — 색은 상품 자체가 정한다(지정 상품 주소에서 산 것)
    # (실기 2026-11-13 무신사 21315225464193299 '그레이' ↔ 'FREE')
    if got and set(got) <= {'free', 'f', 'one', 'onesize', '프리', 'fr'} and want and not any(
        re.search(r'\d', t) or _SIZE_ONLY.fullmatch(t) for t in want
    ):
        return True
    # 상세가 '블랙(001) / 3XL' 처럼 색 뒤에 색번호를 붙이면 괄호 앞만 본다(실기 2026-11-10 21315224120343299)
    base = [_KO_COLOR.get(t.split('(')[0], t.split('(')[0]) if '(' in t else t for t in got]
    if base != got and base and sorted(base) == sorted(want):
        return True
    # 주문이 'EU 화이트 EU 43 · KR 275' 처럼 나라별 사이즈를 같이 적으면 색 + KR 사이즈만 본다 — 상세는 '화이트(104) / 275'
    # (실기 2026-11-13 롯데온 21315225236663299 맞게 샀는데 검사 불일치로 멈춤)
    if 'kr' in want and want.index('kr') + 1 < len(want):
        kr_size = want[want.index('kr') + 1]
        keep = [t for t in want if t not in ('eu', 'kr', 'us', 'uk') and not re.fullmatch(r'\d+(?:\.\d+)?', t)] + [kr_size]
        if base and sorted(base) == sorted(keep):
            return True
        # 한국 치수가 같고(앞 0 무시 — '95' ↔ '095') 상세의 색 이름이 주문과 다른 '아는 색'이 아니면 같은 옵션이다.
        # 소싱처 고유 색 이름('PINE')은 글자로 못 맞춘다 — 구매 단계가 그 상품의 선택지에서 고른 것이다
        # (실기 2026-11-13 29CM 21315225592033299 '그린 M · KR 95' ↔ 'PINE [사이즈]095')
        nums = [t for t in got if re.fullmatch(r'\d{2,3}', t)]
        if len(nums) == 1 and nums[0].lstrip('0') == kr_size.lstrip('0'):
            known = set(_KO_COLOR.values())
            want_colors = {t for t in want if t in known}
            got_colors = {t for t in got if t in known}
            if not (want_colors and got_colors and not (want_colors & got_colors)):
                return True
    # 상세가 'BLK0_BLACK:100' 처럼 색코드_색이름이면 밑줄 뒤 색이름만 본다(실기 2026-11-10 21315224160433299
    # '블랙 100' ↔ 'BLK0_BLACK:100'). 앞쪽이 숫자 섞인 코드일 때만 — 'CHALK_BLACK' 같은 색 이름은 그대로 둔다
    coded = [re.sub(r'^[a-z]{2,4}\d{1,2}_(?=[a-z])', '', t) for t in got]
    if coded != got and sorted(coded) == sorted(want):
        return True
    # 주문 옵션에만 붙은 품번('NE3BR61')은 값이 아니다 — 빼고 다시 본다(실기 2026-11-10 752308665073673
    # '다크네이비 FREE NE3BR61' ↔ '다크네이비')
    codes = {t for t in want if re.fullmatch(r'(?=.*\d)(?=.*[a-z])[a-z0-9]{6,}', t)}
    if codes and got and set(got) <= set(want) - codes and (set(want) - codes) - set(got) <= {'free', 'f', 'one', 'onesize', '프리', 'fr'}:
        return True
    # 반대로 주문엔 색만 있고 상세엔 원사이즈(FREE)가 붙은 경우도 같다(실기 2026-11-10 3482044576 '블루' ↔ '블루 · FREE')
    if want and set(want) <= set(got) and set(got) - set(want) <= {'free', 'f', 'one', 'onesize', '프리', 'fr'}:
        return True
    # 주문 옵션이 숫자 섞인 사이즈 코드 하나('J1'·'C12')뿐이면 상세에 색과 함께 그 코드가 있으면 같다
    # (실기 2026-11-07 무신사 키즈 'J1' ↔ 'CHALK_BLACK(Z0WX) · J1', 'C12' ↔ 'MULTI(Z90H) · C12')
    if len(want) == 1 and re.search(r'\d', want[0]) and re.fullmatch(r'[a-z]{0,2}\d{1,3}', want[0]) and want[0] in got:
        return True
    # 주문 옵션이 숫자 사이즈(+FREE)뿐이면 색상 정보가 없다 — 상세에 그 숫자 사이즈가 있으면 같다
    # (실기 2026-11-05 무신사 4295 '260MM FREE' ↔ 'BLACK · 260MM', 롯데온 4250 '260MM FREE' ↔ '260MM(L)')
    nums = lambda s: set(re.findall(r'(?<!\d)(\d{2,3})(?=\s*(?:mm)?(?:\(|\b|$))', str(s or '').casefold()))
    loose = {'free', 'f', 'one', 'onesize', '프리', 'fr'}
    if nums(wanted) and all(re.fullmatch(r'\d{2,3}(?:mm)?', t) or t in loose for t in want) and nums(wanted) <= nums(actual):
        return True
    # 'BLK(BLACK)'·'095(L)' 처럼 괄호 앞뒤 둘 다 같은 값이다 — 상세가 'BLACK · 095' 로 괄호 안쪽만 보여도 같다
    # (실기 2026-11-09 무신사 4696 'BLK(BLACK) 095(L) NJ3NR86A' ↔ 'BLACK · 095' 를 다르다고 막았다)
    want_set = set(want) | {t.split('(')[0] for t in want if '(' in t}
    want_set |= {t.split('(', 1)[1].rstrip(')') for t in want if '(' in t}
    if got and all(t in want_set for t in got) and any(_SIZE_ONLY.fullmatch(t) for t in got):
        return True
    # 상세가 '95(M)'·'105(XL)' 처럼 숫자 사이즈 괄호 안에 글자 사이즈를 쓰면 둘 다 같은 값이다 — 펼쳐서 본다
    # (실기 2026-11-12 롯데온 21315225093923299 '화이트 M' ↔ '화이트 / 95(M)', 21315225097553299 '블랙 XL · KR 105' ↔ '105(XL)')
    wide: list[str] = []
    for t in got:
        m = re.fullmatch(r'(\d{2,3})\(([a-z0-9]+)\)', t)
        # 숫자 쪽은 주문에 없어도 된다 — 괄호 안 글자 사이즈가 주문 사이즈와 같으면 같은 칸이다
        wide += ([m.group(1)] if m and m.group(1) in want else []) + [m.group(2)] if m else [_KO_COLOR.get(t, t)]
    if wide != got and all(t in want_set or t in want for t in wide) and any(_SIZE_ONLY.fullmatch(t) for t in wide):
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


# 색 이름·색코드 → 한 가지 영어 색(교차 비교 색 대조용)
_EN_COLORS = (
    'black', 'white', 'blue', 'navy', 'grey', 'beige', 'ivory', 'red', 'green', 'pink', 'brown',
    'khaki', 'cream', 'charcoal', 'purple', 'yellow', 'orange', 'mint', 'silver', 'gold', 'sand',
)
_COLOR_CODES = {
    'blk': 'black', 'wht': 'white', 'blu': 'blue', 'nvy': 'navy', 'gry': 'grey', 'gra': 'grey',
    'beg': 'beige', 'bge': 'beige', 'red': 'red', 'grn': 'green', 'pnk': 'pink', 'brn': 'brown',
    'khk': 'khaki', 'crm': 'cream', 'cre': 'cream', 'ivr': 'ivory', 'ivo': 'ivory', 'pur': 'purple',
    'ylw': 'yellow', 'org': 'orange', 'slv': 'silver',
}


def colors_in(text: object) -> set[str]:
    """글 속 색(한글 색 이름·영어 색·'BLU0'·'WHT0_WHITE' 같은 색코드)을 영어 색 집합으로."""
    # '화이트라벨'(노스페이스 라인 이름)은 색이 아니다
    t = re.sub(r'화이트\s*라벨|white\s*label', ' ', str(text or '').casefold()).replace('gray', 'grey')
    out = {c for ko, c in _KO_COLOR.items() if ko in t and c in _EN_COLORS}
    out |= {c for c in _EN_COLORS if re.search(r'(?<![a-z])' + c + r'(?![a-z])', t)}
    out |= {_COLOR_CODES[m] for m in re.findall(r'(?<![a-z])([a-z]{3})\d(?![a-z0-9])', t) if m in _COLOR_CODES}
    return out


def cross_color_conflict(order_text: object, other_text: object) -> tuple[set[str], set[str]] | None:
    """주문 상품의 색과 다른 사이트에서 찾은 상품의 색이 둘 다 있고 하나도 안 겹치면 (주문 색, 찾은 색). 아니면 None.

    실기 2026-11-10 3482152956: 무신사 블루(UR221CRS63 BLU0) 품절 → 29CM 에서 같은 품번 화이트 상품을 샀다.
    주문 옵션이 사이즈 '100' 뿐이라 색을 아무도 대조하지 않았다.
    """
    want, got = colors_in(order_text), colors_in(other_text)
    if want and got and not (want & got):
        return want, got
    return None
