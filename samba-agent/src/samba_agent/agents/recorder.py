"""기록 에이전트 — SAMBA-WAVE 행에 저장하고, 저장한 값을 다시 읽어 확인한다.

결제 뒤 기록이 실패해도 재결제는 절대 하지 않는다(스펙 §6). 여기서 실패하면
감독자가 needs_human 으로 넘기고 사람이 "결제됨, 기록만 남음" 을 처리한다.

재시도가 재저장(중복 행)으로 이어지지 않도록, 저장 전에 먼저 읽어 이미 저장된
주문인지 확인한다 — 있으면 저장을 건너뛰고 재확인만 한다.
"""

import json

from samba_agent.agents.base import AgentBase, AgentFailure, Decision, run_agent, split_page_dialogs
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.agents.payer import recent_art_order, recent_cm29_order
from samba_agent.agents.source_detail import (
    actual_cost,
    detail_args,
    detail_check,
    detail_goal,
    detail_script,
    site_of,
)
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text
from samba_agent.wave.client import WaveClient, WaveError, wave_fields

SAVE_SCRIPT = 'samba_save_order'
READ_SCRIPT = 'samba_read_order'
# 이행한 주문을 배송대기중으로 바꾸는 앱 저장 스크립트(재주문 방지)
STATUS_SCRIPT = 'samba_set_status'

# 이행 뒤 삼바웨이브 주문 행의 "업데이트"(소싱처 가격·재고 갱신 → 마켓 판매가 수정)를 누르는 앱 저장 스크립트
WAVE_UPDATE_SCRIPT = 'samba_update_order'

# 결제 전 견적 원가와 결제 뒤 실제 원가가 이만큼(원) 넘게 다르면 견적 오차로 올린다
ESTIMATE_GAP_WON = 500

# 되읽어 숫자로 비교할 필드 — 문자열 "89000" 과 숫자 89000 을 같은 값으로 본다
NUMERIC_FIELDS = ('real_price', 'shipping_fee')


def _source_site(source: str) -> str:
    """주문의 소싱처 표기('무신사'·'MUSINSA') → 삼바웨이브 source_site(sources.yaml id)."""
    from samba_agent.sources import default_sources

    src = default_sources().by_id(source)
    return src.id if src is not None else source


def _order_type_value(raw: object) -> str | None:
    """구매 에이전트가 판정한 배송 종류만 삼바웨이브에 보낸다(direct/kkadaegi/gift). 그 밖의 값·빈 값은 보내지 않는다."""
    value = str(raw or '').strip()
    return value if value in ('direct', 'kkadaegi', 'gift') else None


def _won(value: object) -> str:
    """금액 → '89,000원'. 모르면 '미확인'."""
    try:
        amount = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return '미확인'
    return f'{amount:,.0f}원' if amount > 0 else '미확인'


def wave_notes(a: Assignment, values: dict[str, object]) -> str:
    """삼바웨이브 간단메모 한 줄(플레이북 §6-3) — 계정·수단·실결제액·원가. 개인정보는 없다."""
    # 실제 주문 상세에서 읽은 값이 있으면 그것을 쓴다(결제 뒤 재계산)
    card = values.get('card') or a.handoff.get('card') or a.options.get('card') or '미확인'
    paid = values.get('paid') or a.handoff.get('paid')
    return (
        f'계정 {values.get("account") or "미확인"} · 수단 {card} · '
        f'실결제 {_won(paid)} · 원가 {_won(values.get("real_price"))}'
    )


def _arrival_memo(a: Assignment, values: dict[str, object]) -> str | None:
    """결제 단계가 읽은 도착예정 메모(3일 초과만). 외부 기입(샵마인 추가메모)도 values 에서 읽는다."""
    memo = str(a.handoff.get('arrival_memo') or '').strip()
    if not memo:
        return None
    values['arrival_memo'] = memo
    return memo


def _normalize(field: str, value: object) -> object:
    """되읽기 비교용 타입 정규화 — 숫자 필드는 숫자로, 문자열은 strip 해서 비교한다."""
    if value is None:
        return None
    if field in NUMERIC_FIELDS:
        try:
            return float(value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return value
    if isinstance(value, str):
        return value.strip()
    return value



class RecorderAgent(AgentBase):
    """SAMBA-WAVE 기록 담당. 내부 API 가 꽂혀 있으면 앱 화면 대신 그쪽에 기입한다."""

    # 저장하고 되읽어 확인할 필드
    RECORD_FIELDS = ('account', 'source_order_no', 'real_price', 'shipping_fee', 'memo', 'flags')

    # 결제 뒤 소싱처 주문 상세로 원가를 다시 계산할지(기본 켬)
    read_actual_cost: bool = True
    # 이행 뒤 삼바웨이브 주문상태를 배송대기중으로 바꿀지(기본 켬 — 재주문 방지)
    mark_status: bool = True
    # 삼바웨이브 내부 API 클라이언트. factory 가 꽂는다(없으면 앱 저장 스크립트 경로)
    _wave: 'WaveClient | None' = None

    def set_wave(self, wave: 'WaveClient | None') -> None:
        """삼바웨이브 클라이언트를 꽂는다. 배선은 factory 가 한다."""
        self._wave = wave

    def __call__(self, assignment: Assignment) -> AgentResult:
        self.reset_repairs()
        self._estimate_gap = None
        return run_agent(lambda: self._record(assignment), lambda: self.evidence)

    def _record(self, a: Assignment) -> AgentResult:
        self.evidence = []
        margin = a.handoff.get('margin_pct')
        if isinstance(margin, int | float) and not isinstance(margin, bool) and margin <= 0:
            # 결제는 이미 끝났다 — 마진 판단은 결제 전(감독자, 포이즌 −3% 이상)이 한다. 여기서 기록을 거르면
            # 산 주문이 주문접수로 남아 재주문된다(실기 2026-09-25: 포이즌 −0.7% 건을 기록하지 않았다). 근거만 남긴다
            self.note('마진', f'{margin}% — 결제된 주문이라 기록한다')
        self.step('recorder: 저장할 값 정리')
        try:
            memo_text = self.decide_once(
                f'{a.rules}\n\n주문 {a.order.order_no}({a.order.source})의 메모 한 문장을 쓰라.',
                Decision,
            ).choice
        except AgentFailure as e:
            # 메모 한 문장 때문에 결제된 주문의 기록이 멈추면 안 된다(실기 2026-09-30: AI 접근이 막혀 결제 2건이
            # 주문접수로 남았다 — 재주문 위험). AI 가 안 되면 정해진 문장으로 기록한다
            self.note('메모', mask_text(f'AI 메모 실패 — 기본 문장 사용({e.reason[:60]})'))
            memo_text = f'{a.order.source} 자동 이행'
        memo = Decision(choice=memo_text, reason='기록 메모')
        # account 는 내부 판매 계정 식별자다. 요청자가 지정했으면 그 값을, 아니면 구매
        # 에이전트가 고른 계정을 인계값에서 받는다 — 둘 다 없으면 빈 계정으로 저장된다
        # (리뷰 지적 — I1)
        values: dict[str, object] = {
            f: a.expected.get(f) for f in self.RECORD_FIELDS if f not in ('account', 'shipping_fee')
        }
        account = a.options.get('account') or a.handoff.get('account')
        if not account:
            raise AgentFailure('needs_human', '저장할 판매 계정이 없다', FailReason.UNKNOWN)
        values['account'] = account
        values['shipping_fee'] = a.expected.get('shipping_fee', 0)
        values['memo'] = memo.choice
        self.note('저장할 값', json.dumps(values, ensure_ascii=False))

        if a.dry_run:
            self.step('recorder: dry-run — 저장하지 않는다')
            return AgentResult(
                status='ok',
                reason=f'dry-run: 저장할 값만 준비했다({memo.reason})',
                payload={'dry_run': True, 'saved': False, 'planned': values},
                evidence=tuple(self.evidence),
            )

        if self._wave is not None:
            return self._record_via_wave(a, values, memo.reason)

        self.step('recorder: 기존 저장 확인')
        existing = self.json_tool(
            'run_script',
            name=READ_SCRIPT,
            args=json.dumps({'orderNo': a.order.order_no}, ensure_ascii=False),
        )
        already_saved = bool(existing)
        if already_saved:
            # 저장은 됐는데 되읽기만 어긋난 경우일 수 있다 — 다시 저장하지 않고 재확인만 한다
            self.step('recorder: 이미 저장됨 — 재저장 없이 재확인만')
            saved = existing
        else:
            self.step('recorder: 저장')
            self.tool(
                'run_script',
                name=SAVE_SCRIPT,
                args=json.dumps({'orderNo': a.order.order_no, **values}, ensure_ascii=False),
            )
            self.step('recorder: 저장 확인')
            saved = self.json_tool(
                'run_script',
                name=READ_SCRIPT,
                args=json.dumps({'orderNo': a.order.order_no}, ensure_ascii=False),
            )

        diffs = [
            f
            for f in self.RECORD_FIELDS
            if values.get(f) is not None
            and _normalize(f, saved.get(f)) != _normalize(f, values.get(f))
        ]
        if diffs:
            raise AgentFailure(
                'fail',
                f'저장 확인 실패(재결제 금지): {", ".join(diffs)}',
                FailReason.VERIFY_MISMATCH,
            )
        self.note('저장 확인', json.dumps(saved, ensure_ascii=False))
        reason = (
            f'이미 저장된 주문이라 재저장 없이 재확인만 했다({memo.reason})'
            if already_saved
            else f'{len(self.RECORD_FIELDS)}개 필드를 저장하고 되읽어 확인했다({memo.reason})'
        )
        return AgentResult(
            status='ok',
            reason=reason,
            payload={
                'dry_run': False,
                'saved': True,
                'values': values,
                'already_saved': already_saved,
            },
            evidence=tuple(self.evidence),
        )

    def _bought_account_id(self, a: Assignment) -> str | None:
        """구매 에이전트가 쓴 계정(handoff account)의 삼바웨이브 id. 주문 계정과 같거나 못 찾으면 주문 값."""
        bought = str(a.handoff.get('account') or '').strip() or (a.order.account or '').strip()
        # 주문 계정과 같아도 id 를 조회한다 — 주문에 미리 잡힌 계정은 아이디만 있고 id 가 비어 있어
        # 주문계정이 빈칸으로 남았다(실기 2026-09-27: ABC buyer01·무신사 buyer05 결제건)
        if bought and (bought != (a.order.account or '') or not a.order.account_id) and self._wave is not None:
            found = self._wave.sourcing_account_id(
                _source_site(str(a.handoff.get('buy_source') or a.order.source)), bought
            )
            if found:
                self.note('주문계정', f'실제 구매 계정 {bought} 로 기록')
                return found
            self.note(
                '주문계정', f'실제 구매 계정 {bought} 의 삼바 id 를 찾지 못해 주문 값으로 둔다'
            )
        return a.order.account_id or (str(a.handoff.get('sourcing_account_id') or '') or None)

    def _mark_waiting_ship(self, a: Assignment, sourcing_no: str) -> None:
        """이행한 주문의 삼바웨이브 상태를 '배송대기중'으로 바꾼다 — 주문접수로 남으면 다시 주문된다(사용자 지시).

        앱 저장 스크립트(`samba_set_status`)로 바꾸고 내부 API 로 되읽어 확인한다. 못 바꾸면 사람에게 넘긴다.
        """
        self.step('recorder: 주문상태 배송대기중')
        try:
            out = self.json_tool(
                'run_script',
                name=STATUS_SCRIPT,
                args=json.dumps(
                    {
                        'orderNo': a.order.order_no,
                        'sourcingNo': sourcing_no,
                        'status': '배송대기중',
                    },
                    ensure_ascii=False,
                ),
            )
        except AgentFailure as e:
            out = {'ok': False, 'note': e.reason[:80]}
        status = ''
        if self._wave is not None:
            try:
                status = str(
                    self._wave.get_order(
                        a.order.order_no, sourcing_order_number=sourcing_no
                    ).status
                    or ''
                )
            except WaveError:
                status = ''
        if status == 'wait_ship':
            self.note('주문상태', '배송대기중으로 변경 확인')
            return
        raise AgentFailure(
            'needs_human',
            mask_text(
                f'기록은 됐지만 주문상태를 배송대기중으로 못 바꿨다(재주문 위험) — {out.get("note") or status}'
            ),
            FailReason.UNKNOWN,
        )

    def _apply_actual_cost(
        self, a: Assignment, values: dict[str, object], sourcing_no: str
    ) -> None:
        """결제 뒤 소싱처 주문 상세에서 실제 결제액·적립금·적립·카드를 읽어 원가를 다시 잡는다.

        견적 원가는 적립금·적립이 빠질 수 있다(실기: 88,300 기록, 실제 95,520). 상세를 못 읽으면 견적 원가로 두고 남긴다.
        """
        self.step('recorder: 소싱처 주문 상세 읽기')
        try:
            detail = self.script_json(
                detail_script(site_of(a)),
                detail_args(a, sourcing_no),
                goal=detail_goal(str(a.handoff.get('buy_source') or a.order.source)),
                check=detail_check(sourcing_no),
            )
        except AgentFailure as e:
            self.note('실제 원가', mask_text(f'상세를 못 읽어 견적 원가로 기록({e.reason[:80]})'))
            return
        # 주문 상세의 '적립금 사용'은 보유 적립금 + 적립금 선할인 합계다. 선할인은 결제액을 이미 깎고 구매 적립도
        # 사라지므로 원가에 다시 더하지 않는다(사용자 2026-09-25) — 결제 직전 주문서에서 읽은 보유 적립금 사용액을 쓴다
        box = a.handoff.get('points_used')
        detail_box = detail.get('points_box')
        if isinstance(detail_box, int | float) and not isinstance(detail_box, bool):
            # 주문 상세를 펼쳐 읽은 보유 적립금 사용액이 있으면 그것을 쓰고, 결제 전 주문서 값과 대조한다
            detail = {**detail, 'points_used': float(detail_box)}
            if isinstance(box, int | float) and not isinstance(box, bool) and abs(float(box) - float(detail_box)) > 1:
                self.note(
                    '적립금 대조',
                    f'결제 전 주문서 보유 적립금 {float(box):,.0f}원 ≠ 주문 상세 {float(detail_box):,.0f}원 — 상세 값으로 기록',
                )
        elif isinstance(box, int | float) and not isinstance(box, bool) and box >= 0:
            detail = {**detail, 'points_used': min(float(box), float(detail.get('points_used') or 0) or float(box))}
        quoted_reward = a.handoff.get('reward')
        if (
            not detail.get('reward')
            and isinstance(quoted_reward, int | float)
            and not isinstance(quoted_reward, bool)
            and quoted_reward > 0
        ):
            # 주문 상세에 적립이 안 나온다(ABC·그랜드스테이지: 구매확정 뒤 지급) — 결제 전 견적의 적립으로 원가를 낸다
            # (실기 2026-09-25 HQ2414: 적립 1,640원이 빠져 원가 59,200 기록, 맞는 값 57,560)
            detail = {**detail, 'reward': float(quoted_reward)}
        # 애드픽·샵백 적립은 원가에 넣지 않는다(사용자 2026-09-27) — 주문 상세·견적의 사이트 적립만 쓴다
        cost = actual_cost(detail)
        if cost is None:
            self.note('실제 원가', '결제액을 못 읽어 견적 원가로 기록')
            return
        # 원가가 0 이하면 상세를 잘못 읽은 것이다 — 그 값으로 덮어쓰지 않는다(포인트 전액 결제는 결제 0 이어도 원가는 양수다)
        # (실기 2026-09-28 무신사 3474468594: 없는 주문번호의 상세를 읽어 결제 0 · 원가 -80원을 기입했다)
        if cost <= 0:
            self.note(
                '실제 원가',
                f'상세 값이 이상해 견적 원가로 기록(결제 {detail.get("paid")} · 원가 {cost:,.0f}원)',
            )
            return
        quoted = values.get('real_price')
        # 결제 뒤 검토: 결제 전 견적 원가와 실제 원가를 비교한다(견적 스크립트 오류를 결제 뒤에라도 잡는다 —
        # 실기 2026-09-25 노스페이스: 무신사머니 적립을 0으로 읽어 견적이 1만원 높았다, 로라로라: 선할인 중복)
        est = a.handoff.get('cost')
        if isinstance(est, int | float) and not isinstance(est, bool) and est > 0:
            gap = cost - float(est)
            if abs(gap) > ESTIMATE_GAP_WON:
                self._estimate_gap = gap
                self.note('⚠ 견적 오차', f'견적 {float(est):,.0f}원 · 실제 {cost:,.0f}원 · 차이 {gap:+,.0f}원 — 견적 스크립트 점검 필요')
        values['real_price'] = cost
        values['paid'] = detail.get('paid')
        values['card'] = detail.get('card')
        self.note(
            '실제 원가',
            f'결제 {detail.get("paid")} · 적립금 {detail.get("points_used") or 0} · 적립 {detail.get("reward") or 0}'
            f' · {detail.get("card") or ""} → 원가 {cost:,.0f}원(견적 {quoted})',
        )

    def _refresh_wave_listing(self, a: Assignment) -> None:
        """삼바웨이브 주문 행의 '업데이트'를 누르고 결과 문구만 근거에 남긴다. 실패해도 기록 결과는 바꾸지 않는다."""
        try:
            out = self.tool(
                'run_script',
                name=WAVE_UPDATE_SCRIPT,
                args=json.dumps({'orderNo': a.order.order_no}, ensure_ascii=False),
            )
        except AgentFailure as e:
            self.note('판매가 업데이트', mask_text(f'못 함({e.reason[:80]})'))
            return
        try:
            result = str(json.loads(split_page_dialogs(out)[0]).get('result') or '')
        except (ValueError, AttributeError):
            result = out.strip()
        self.note('판매가 업데이트', mask_text(result[:120]))

    def _record_via_wave(
        self, a: Assignment, values: dict[str, object], memo_reason: str
    ) -> AgentResult:
        """삼바웨이브 내부 API 로 기입하고 되읽어 확인한다.

        재결제는 절대 하지 않는다(스펙 §6) — 이미 다른 소싱주문번호가 박혀 있으면(409)
        덮어쓰지 않고 사람에게 넘긴다.
        """
        sourcing_no = str(values.get('source_order_no') or '').strip()
        if not sourcing_no:
            # 결제 단계가 번호를 못 넘겼다 — 사람에게 넘기기 전에 주문내역(ABC·그랜드스테이지·29CM)에서 한 번 더 찾는다
            # (실기 2026-09-27 job 262: ABC 결제 완료인데 번호 없이 멈춤)
            sourcing_no = (recent_art_order(self, a) or recent_cm29_order(self, a) or '').strip()
            if sourcing_no:
                values['source_order_no'] = sourcing_no
                self.note('소싱 주문번호(주문내역)', sourcing_no)
        if not sourcing_no:
            raise AgentFailure('needs_human', '기입할 소싱주문번호가 없다', FailReason.UNKNOWN)
        if self.read_actual_cost:
            self._apply_actual_cost(a, values, sourcing_no)
        self.step('recorder: 삼바웨이브 기입')
        try:
            self._wave.record_sourcing(  # type: ignore[union-attr]
                a.order.order_no,
                sourcing_order_number=sourcing_no,
                cost=float(values.get('real_price') or 0),
                shipping_fee=float(values.get('shipping_fee') or 0),
                # 주문계정은 실제로 산 계정이다 — 주문에 미리 잡힌 계정과 다를 수 있다(실기: buyer05 주문을
                # 플레이북대로 buyer01 으로 삼). 못 찾으면 주문이 들고 온 값
                sourcing_account_id=self._bought_account_id(a),
                # 간단메모는 정해진 한 줄(계정·수단·실결제·원가) — LLM 문장을 싣지 않는다.
                # 도착예정일이 3일을 넘으면 그 줄을 하나 더 붙인다(사용자 2026-09-30)
                notes=wave_notes(a, values) + (f'\n{memo}' if (memo := _arrival_memo(a, values)) else ''),
                order_type=_order_type_value(a.expected.get('order_type')),
                # 재구매(작업 옵션 rebuy_of) — 취소한 소싱주문번호를 새 번호로 덮어쓴다
                replace=bool(str(a.options.get('rebuy_of') or '').strip()),
            )
            self.step('recorder: 기입 확인')
            # 행이 여럿인 주문은 방금 적은 행을 되읽는다(삼바웨이브 기본은 아직 안 산 행)
            saved = self._wave.get_order(  # type: ignore[union-attr]
                a.order.order_no, sourcing_order_number=sourcing_no
            )
        except WaveError as e:
            status = 'needs_human' if e.reason is FailReason.DUPLICATE else 'fail'
            raise AgentFailure(status, f'삼바웨이브 기입 실패(재결제 금지): {e}', e.reason) from e

        # 응답이 돌려주는 필드만 대조한다 — 목록 모델에 없는 값(소싱주문번호 등)은 확인할 수 없다.
        # PUT 이 200 이면 저장은 된 것이고, 다른 번호가 있었다면 409 로 막혔다
        checked = wave_fields(saved)
        diffs = [
            f
            for f, v in checked.items()
            if values.get(f) is not None and _normalize(f, v) != _normalize(f, values.get(f))
        ]
        if diffs:
            raise AgentFailure(
                'fail',
                f'기입 확인 실패(재결제 금지): {", ".join(diffs)}',
                FailReason.VERIFY_MISMATCH,
            )
        self.note(
            '기입 확인',
            json.dumps(checked, ensure_ascii=False)
            if checked
            else '삼바웨이브 응답에 대조할 필드가 없다 — 기입 자체는 200 으로 확인',
        )
        if self.mark_status:
            self._mark_waiting_ship(a, sourcing_no)
            # 이행이 끝난 뒤 판매가를 갱신한다(사용자 2026-09-25: 주문 이행 후 업데이트)
            self._refresh_wave_listing(a)
        gap = getattr(self, '_estimate_gap', None)
        if gap is not None:
            # 기록·배송대기중은 끝났다 — 견적이 틀렸다는 사실만 사람에게 올린다(재결제·취소는 사람이 정한다)
            return AgentResult(
                status='needs_human',
                reason=f'⚠ 견적 오차 {gap:+,.0f}원 — 기록·배송대기중은 완료(소싱주문번호 {sourcing_no})',
                fail_reason=FailReason.VERIFY_MISMATCH,
                payload={'dry_run': False, 'saved': True, 'values': values, 'via': 'wave', 'estimate_gap': gap},
                evidence=tuple(self.evidence),
            )
        return AgentResult(
            status='ok',
            reason=f'삼바웨이브에 소싱주문번호 {sourcing_no} 를 기입하고 되읽어 확인했다({memo_reason})',
            payload={'dry_run': False, 'saved': True, 'values': values, 'via': 'wave'},
            evidence=tuple(self.evidence),
        )
