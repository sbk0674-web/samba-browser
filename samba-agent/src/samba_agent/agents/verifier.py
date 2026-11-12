"""검증 에이전트 — 소싱처 주문 상세 · SAMBA 행 · 감독자 기대값 셋을 대조한다."""

import json
import re

from samba_agent.agents.base import AgentBase, AgentFailure, Decision, run_agent
from samba_agent.agents.buyer import _norm_address
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.agents.order_identity import paid_option_matches
from samba_agent.agents.source_detail import (
    actual_cost,
    detail_args,
    detail_check,
    detail_goal,
    detail_script,
    site_of,
    with_pay_card,
)
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_value
from samba_agent.wave.client import WaveClient, WaveError, wave_fields

SAMBA_READ_SCRIPT = 'samba_read_order'

_PROVINCE_SHORT_NAMES = {
    '경기도': '경기', '강원도': '강원',
    '경상북도': '경북', '경상남도': '경남',
    '충청북도': '충북', '충청남도': '충남',
    '전라북도': '전북', '전라남도': '전남',
}
_PROVINCE_WORD = re.compile(
    r'(?<![가-힣A-Za-z])(' + '|'.join(_PROVINCE_SHORT_NAMES) + r')(?=\s+[가-힣])'
)


def _identity_address_key(value: object) -> str:
    # Preserve separate numeric components when a site gives one combined address.
    # Removing all spaces turns "47 401동" into "47401동" and breaks digit boundaries.
    raw = re.sub(r'\([^)]*\)', ' ', str(value or ''))
    # A province's full name and abbreviation describe the same visible address.
    # Match complete province words; room, road and city checks remain unchanged.
    raw = _PROVINCE_WORD.sub(lambda m: _PROVINCE_SHORT_NAMES[m[1]], raw)
    return _norm_address(re.sub(r'(?<=\d)[,\s]+(?=\d)', '|', raw))


OFFICE_ROOMS = ('101호', '102호')


def _address_contains(actual: str, value: str) -> bool:
    # Digit boundaries protect 703 from matching 1703; a complete word ending in
    # 호/층 may legitimately be followed by another visible numeric field.
    left = r'(?<!\d)' if value[:1].isdigit() else ''
    right = r'(?!\d)' if value[-1:].isdigit() else ''
    return bool(re.search(left + re.escape(value) + right, actual))


def _detail_found(actual: str, value: str, kind: str) -> bool:
    """상세주소가 보이는가. 사무실은 101호·102호가 같은 곳이다(사용자 2026-11-03) — 까대기 배송만 서로 인정한다."""
    if _address_contains(actual, value):
        return True
    if kind != 'kkadaegi' or not value.endswith(OFFICE_ROOMS):
        return False
    return any(_address_contains(actual, room) for room in OFFICE_ROOMS)


def _same(field: str, got: object, want: object) -> bool:
    """대조용 비교. 주문번호는 표기만 다른 것(SSG 주문 상세의 '20260929-CA60D3' ↔ '20260929CA60D3')을 같게 본다."""
    if field == 'source_order_no' and got is not None and want is not None:
        plain = lambda x: str(x).replace('-', '').replace(' ', '').upper()
        return plain(got) == plain(want)
    return got == want


_SIZEISH = re.compile(r'^(?:\d{2,3}|\d?x{0,3}[sml]|[sml]d|lg|sm|md|xl|\dxl|free|f)$')


def _single_color_buy(wanted: object, actual: object, choice: object) -> bool:
    """색 고르는 단계가 없던 상품(색 하나뿐)이면 사이즈만 맞으면 같다.

    구매가 고른 줄에 사이즈·가격·재고 말고 아무 글자도 없으면 색 선택지가 없었던 것이다(실기 2026-11-12 롯데온
    21315224977733299 언더아머: 주문 '실버 MD' · 고른 줄 'MD(95) 23,400 7개 남음' · 상세 '그레이(011) / MD(95)' —
    상품 색은 그레이(011) 하나뿐인데 검사 불일치로 멈췄다).
    """
    pick = re.sub(r'[\d,]+\s*(?:원|개\s*남음)?|남음|품절임박|\(|\)|[·/]', ' ', str(choice or '').casefold())
    pick_words = [w for w in pick.split() if not _SIZEISH.fullmatch(w)]
    if not str(choice or '').strip() or pick_words:
        return False
    got = set()
    for t in re.split(r'[\s/·]+', str(actual or '').casefold()):
        got |= {t.split('(')[0], t.split('(', 1)[-1].rstrip(')')}
    sizes = [t for t in re.split(r'[\s/·]+', str(wanted or '').casefold()) if _SIZEISH.fullmatch(t)]
    return bool(sizes) and all(t in got for t in sizes)


class VerifierAgent(AgentBase):
    """대조만 한다. 주문·배송지는 바꾸지 않는다 — 쓰기 도구는 소싱처 상세 스크립트 AI 수리용 save_script 뿐이다."""

    # 삼바웨이브 내부 API 클라이언트. factory 가 꽂는다(없으면 앱 저장 스크립트로 읽는다)
    _wave: 'WaveClient | None' = None

    def _identity_check(self, a: Assignment, source: dict[str, object]) -> tuple[list[str], list[str]]:
        """Read actual option and shipping independently; never emit personal values."""
        mismatch, missing = [], []
        actual = source.get('selected') or source.get('option')
        if not a.order.option or not actual:
            missing.append('option')
        elif not paid_option_matches(a.order.option, actual) and not _single_color_buy(
            a.order.option, actual, a.handoff.get('option')
        ):
            mismatch.append('option')
        qty = source.get('qty')
        if qty is None:
            missing.append('qty')
        elif str(qty) != str(a.order.qty):
            mismatch.append('qty')
        kind = str(a.handoff.get('order_type') or a.order.order_type)
        if self._wave is None or kind not in ('direct', 'kkadaegi', 'gift'):
            missing.append('shipping')
            return mismatch, missing
        if a.handoff.get('ship_mismatch'):
            # 결제 단계가 주문완료 화면에서 사무실 주소를 봤다 — 오배송(사용자 2026-11-12)
            mismatch.append('shipping_complete')
            return mismatch, missing
        applied_ship = source.get('shipping')
        if kind == 'gift' and isinstance(applied_ship, dict) and str(applied_ship.get('address') or '').strip():
            # 선물 주문인데 소싱처 주문 상세에 배송 주소가 박혀 있다 = 선물이 아니라 일반 배송으로 결제됐다
            # (실기 2026-11-10 752400788766783: 고객 이름으로 사무실 배송 — 예전엔 '대조 불가'로 통과시켰다)
            mismatch.append('gift_shipping')
            return mismatch, missing
        order = self._wave.get_order(a.order.wave_key, order_type=kind)
        expected = order.shipping.to_script_args()
        if order.order_type != kind or not all(expected.get(k) for k in ('name', 'address')):
            missing.append('shipping')
            return mismatch, missing
        applied = source.get('shipping')
        if isinstance(applied, dict) and all(applied.get(k) for k in ('name', 'address')):
            actual_full = '|'.join(_identity_address_key(applied.get(k)) for k in ('address', 'address_detail'))
            if str(expected['name']).replace(' ', '') != str(applied['name']).replace(' ', ''):
                if '*' in str(applied['name']):
                    missing.append('recipient')
                else:
                    mismatch.append('recipient')
            for key in ('address', 'address_detail'):
                value = _identity_address_key(expected.get(key))
                if value and not _detail_found(actual_full, value, kind):
                    mismatch.append(key)
        else:
            # Some sites mask recipient names. Address text alone cannot prove the recipient.
            raw = str(source.get('shipping_text') or '')
            # 롯데온 선물 상세는 'To. 이름' 만 보이고 주소가 없다(실기 2026-11-03 4101) — 읽은 받는 분 이름도 대조 글자에 넣는다
            gift_name_only = isinstance(applied, dict) and applied.get('name') and not applied.get('address')
            if kind == 'gift' and gift_name_only:
                raw = f'{raw} {applied.get("name")}'
            flat = _identity_address_key(raw)
            # SSG 선물주문 상세는 받는 분 이름만 보이고 주소는 없다(고객이 카톡으로 입력, 실기 2026-11-03 4085) — 이름만 대조
            name_only = kind == 'gift' and (source.get('gift_order') is True or bool(gift_name_only))
            keys = ('name',) if name_only else ('name', 'address', 'address_detail')
            for key in keys:
                value = str(expected.get(key) or '')
                if not value:
                    continue
                if key == 'name' and kind == 'gift':
                    # 선물 받는 분 이름은 SSG 가 잘라 저장한다(긴 영문 이름 — 실기 2026-11-03 4076) — 주소록 대조와 같이
                    # 공백 빼고 앞 8자·대소문자 무시로 본다
                    head = value.replace(' ', '').lower()[:8]
                    if head not in raw.replace(' ', '').lower():
                        missing.append('recipient')
                elif key == 'name':
                    if not re.search(r'(?<![가-힣A-Za-z])' + re.escape(value) + r'(?![가-힣A-Za-z])', raw):
                        missing.append('recipient')
                elif not _detail_found(flat, _identity_address_key(value), kind):
                    missing.append(key)
        return mismatch, missing

    def set_wave(self, wave: 'WaveClient | None') -> None:
        """삼바웨이브 클라이언트를 꽂는다. 배선은 factory 가 한다."""
        self._wave = wave

    def _detail_validator(self, a: Assignment, want_no: object):
        """Missing identity must invoke repair; real mismatches remain evidence, not repair targets."""
        financial = detail_check(want_no)

        def check(source: dict[str, object]) -> str | None:
            problem = financial(source)
            if problem:
                return problem
            mismatch, missing = self._identity_check(a, source)
            if mismatch:
                return None  # Preserve the actual mismatch for the verifier's hard stop.
            if missing:
                return ('실제 소싱 주문 상세에서 읽지 못한 항목: ' + ', '.join(missing)
                        + ' — 화면에서 읽어라. 주문 원본 값을 결과에 복사하거나 주문을 변경하지 마라.')
            return None

        return check

    def _read_samba(self, a: Assignment) -> tuple[dict[str, object], tuple[str, ...]]:
        """SAMBA 쪽 값과 '대조할 수 없는 기대값 키'. API 가 있으면 API, 없으면 앱 스크립트.

        내부 API 응답에는 아직 없는 필드(소싱주문번호·매입금액)가 있다 — 없는 값을 '같다' 로
        치지 않고 확인 불가로 따로 모아 결과에 남긴다.
        """
        if self._wave is None:
            self.step('verifier: SAMBA 행 읽기')
            return (
                self.json_tool(
                    'run_script',
                    name=SAMBA_READ_SCRIPT,
                    args=json.dumps({'orderNo': a.order.order_no}, ensure_ascii=False),
                ),
                (),
            )
        self.step('verifier: 삼바웨이브 주문 읽기')
        try:
            order = self._wave.get_order(a.order.wave_key)
        except WaveError as e:
            raise AgentFailure('fail', f'삼바웨이브 조회 실패: {e}', e.reason) from e
        # 배송지(개인정보)는 쳐다보지 않는다 — 대조 대상 필드만 꺼내 쓴다
        samba = wave_fields(order)
        unverified = tuple(f for f in a.expected if f not in samba)
        return samba, unverified

    def __call__(self, assignment: Assignment) -> AgentResult:
        self.reset_repairs()
        return run_agent(
            lambda: self._verify(assignment), lambda: self.evidence, self.failure_shot(assignment)
        )

    def _verify(self, a: Assignment) -> AgentResult:
        self.evidence = []
        if a.dry_run:
            # 결제 없는 시험 실행 — 산 주문이 없어 대조할 소싱처 상세가 없다(읽으려 하면 다른 주문을 읽는다)
            return AgentResult(
                status='ok',
                reason='dry-run: 산 주문이 없어 대조하지 않는다',
                payload={'dry_run': True, 'mismatches': []},
                evidence=tuple(self.evidence),
            )
        if not a.expected:
            # 대조할 값이 하나도 없으면 '다 맞았다' 가 아니라 '확인하지 못했다' 다(리뷰 지적 — Minor)
            return AgentResult(
                status='needs_ai',
                reason='대조할 기대값이 없다 — 앞 단계가 값을 넘기지 못했다',
                fail_reason=FailReason.VERIFY_MISMATCH,
                evidence=tuple(self.evidence),
            )
        self.step('verifier: 소싱처 주문 상세 읽기')
        want_no = a.expected.get('source_order_no')
        # 스크립트가 없거나 실패하면 AI 가 고쳐 이어 간다(실기: source_order_detail 없음으로 검증만 실패)
        try:
            source = self.script_json(
                detail_script(site_of(a)),
                detail_args(a, want_no),
                goal=detail_goal(str(a.handoff.get('buy_source') or a.order.source)),
                check=self._detail_validator(a, want_no),
            )
        except AgentFailure as e:
            if 'no saved script' not in e.reason:
                raise
            # 상세 스크립트가 아직 없는 소싱처(롯데온) — 결제·기입은 끝났다. 소싱처 쪽 대조만 건너뛰고 삼바웨이브
            # 기입값은 그대로 대조한다(실기 2026-09-29: 결제·기록된 롯데온 주문이 매번 needs_ai 으로 남았다)
            self.note('소싱처 대조 불가', f'주문 상세 스크립트 없음({detail_script(site_of(a))}) — 삼바웨이브 기입만 대조')
            source = {k: v for k, v in a.expected.items() if k in ('source_order_no', 'real_price')}
        # 원가는 결제 뒤 실제 상세로 다시 계산해 기록한다(기록 에이전트) — 견적 원가 대신 그 값으로 대조한다
        expected = dict(a.expected)
        # 원가의 사용 적립금은 보유 적립금만(선할인 제외) — 기록 단계와 같은 규칙. 상세를 펼쳐 읽은 보유분이 없으면
        # 결제 전 주문서에서 읽은 값을 쓴다(실기 2026-09-25: 합계 12,370 을 넣어 111,320 으로 잘못 대조)
        box = source.get('points_box')
        handoff_box = a.handoff.get('points_used')
        if isinstance(box, int | float) and not isinstance(box, bool):
            source = {**source, 'points_used': float(box)}
        elif isinstance(handoff_box, int | float) and not isinstance(handoff_box, bool):
            source = {**source, 'points_used': float(handoff_box)}
        # 주문 상세에 적립이 안 나오는 사이트(ABC·그랜드스테이지)는 결제 전 견적의 적립으로 — 기록 단계와 같은 규칙
        # (실기 2026-09-26: 적립 없이 재계산해 결제액 39,900 과 기록 원가 38,701 이 어긋난다고 오탐)
        quoted_reward = a.handoff.get('reward')
        if (
            not source.get('reward')
            # 네이버페이는 영수증 적립만 쓴다 — 기록 단계와 같은 규칙(실기 2026-11-03 4090: 견적 적립 184 를 빼 36,866 으로 오탐)
            and '네이버' not in f'{source.get("card") or ""} {a.handoff.get("card") or ""}'
            and isinstance(quoted_reward, int | float)
            and not isinstance(quoted_reward, bool)
            and quoted_reward > 0
        ):
            source = {**source, 'reward': float(quoted_reward)}
        recomputed = actual_cost(with_pay_card(source, a.handoff))
        if recomputed is not None and 'real_price' in expected:
            expected['real_price'] = recomputed
            source = {**source, 'real_price': recomputed}
        samba, unverified = self._read_samba(a)
        if unverified:
            self.note('대조 불가', f'삼바웨이브에 없는 필드: {", ".join(unverified)}')
        # 소싱처 화면에 원래 없는 값(원가·배송 종류·플래그)은 소싱처 쪽 대조에서 빼고 남긴다 — 주문번호는 꼭 맞아야 한다
        source_missing = [f for f in expected if f not in source and f != 'source_order_no']
        if source_missing:
            self.note('소싱처 대조 불가', ', '.join(source_missing))
        # 대조 자체는 날것 값으로 한다 — 마스킹은 밖으로 내보낼 때만 씌운다.
        # 확인할 수 없는 필드는 '같다' 가 아니라 대조에서 빼고 따로 남긴다
        mismatches = [
            {'field': f, 'expected': v, 'source': source.get(f), 'samba': samba.get(f)}
            for f, v in expected.items()
            if (f not in source_missing and not _same(f, source.get(f), v))
            or (f not in unverified and not _same(f, samba.get(f), v))
        ]
        # 여기서부터는 마스킹한 사본만 쓴다 — payload·reason·LLM 프롬프트 어디에도
        # 브릿지의 날것 값(고객 개인정보일 수 있다)이 그대로 나가지 않게 한다
        masked_mismatches = mask_value(mismatches)
        self.note('대조 결과', json.dumps(masked_mismatches, ensure_ascii=False) or '없음')
        if mismatches:
            try:
                explain = self.decide_once(
                    f'{a.rules}\n\n다음 불일치를 한 문장으로 설명하라: {masked_mismatches}', Decision
                )
            except AgentFailure:
                # AI 설명이 안 돼도(접근 막힘 등) 불일치 사실은 그대로 올린다(실기 2026-09-30)
                explain = Decision(
                    choice=json.dumps(masked_mismatches, ensure_ascii=False)[:200], reason='AI 설명 불가'
                )
            return AgentResult(
                status='fail',
                reason=f'불일치 {len(mismatches)}건: {explain.choice}',
                fail_reason=FailReason.VERIFY_MISMATCH,
                payload={'mismatches': masked_mismatches},
                evidence=tuple(self.evidence),
            )
        if len(unverified) == len(a.expected):
            # 소싱처 쪽만 맞고 SAMBA 쪽은 하나도 못 봤다 — '다 맞았다' 가 아니다
            return AgentResult(
                status='needs_ai',
                reason='삼바웨이브에서 대조할 수 있는 값이 없다 — 사람이 확인해야 한다',
                fail_reason=FailReason.VERIFY_MISMATCH,
                payload={'mismatches': [], 'unverified': list(unverified)},
                evidence=tuple(self.evidence),
            )
        try:
            identity_mismatch, identity_missing = self._identity_check(a, source)
        except WaveError:
            identity_mismatch, identity_missing = [], ['shipping']
        if identity_mismatch or identity_missing:
            self.note('주문 후 필수 대조', f'불일치 필드: {identity_mismatch}; 미확인 필드: {identity_missing}')
            return AgentResult(
                status='fail' if identity_mismatch else 'needs_ai',
                reason=f'주문 후 주소·옵션·수량 검증 미통과: 불일치 {identity_mismatch}, 미확인 {identity_missing}'
                # 옵션은 개인정보가 아니다 — 무엇과 무엇이 달랐는지 남겨 비교 규칙을 고칠 수 있게 한다
                + (
                    f" (주문 {a.order.option!r} · 상세 {source.get('selected') or source.get('option')!r})"
                    if 'option' in identity_mismatch
                    else ''
                ),
                fail_reason=FailReason.VERIFY_MISMATCH,
                payload={'mismatches': [{'field': f} for f in identity_mismatch],
                         'unverified': list(unverified), 'identity_unverified': identity_missing},
                evidence=tuple(self.evidence),
            )
        return AgentResult(
            status='ok',
            reason=(
                f'{len(a.expected) - len(unverified)}개 값이 소싱처·SAMBA·기대값에서 모두 같다'
                + (f'(대조 불가 {len(unverified)}개)' if unverified else '')
            ),
            payload={'mismatches': [], 'unverified': list(unverified)},
            evidence=tuple(self.evidence),
        )
