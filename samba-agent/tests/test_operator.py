# AI 대행 — 판단은 AI, 실행·안전 점검은 코드
import dataclasses

import pytest

from samba_agent.operator.agent import MIN_EVIDENCE_CHARS, OperatorAgent, Verdict, normalize
from samba_agent.operator.service import OPERATOR_KEY, OperatorService, eligible
from samba_agent.queue.db import JobQueue


def test_근거_없는_cancel_은_사람_확인으로_바뀐다():
    v = normalize(Verdict('cancel', '품절 같다', '품절'))
    assert v.action == 'human'
    ok = normalize(
        Verdict('cancel', '품절', '주문 옵션 240 (품절) 표시 — 상품 화면 선택지에서 읽음')
    )
    assert ok.action == 'cancel' and len(ok.evidence) >= MIN_EVIDENCE_CHARS
    assert normalize(Verdict('retry', '탭이 닫힘')).action == 'retry'


def test_도구가_판단을_못_남기면_human(monkeypatch):
    agent = OperatorAgent(timeout_s=5)

    async def nothing(self, prompt, call, state):
        return None

    monkeypatch.setattr(OperatorAgent, '_loop', nothing)
    assert agent.judge(call=lambda t, a: '', ctx={'reason': 'x'}).action == 'human'


class _Q:
    def __init__(self, tmp_path):
        self.q = JobQueue(tmp_path / 'jobs.sqlite')
        self.job, _ = self.q.enqueue('T1', 'u', {}, None, wave_id='ord_T1')
        self.q.finish(self.job.id, 'needs_human', error='unknown')

    def job_now(self):
        return self.q.get_by_id(self.job.id)


def test_맡길_수_있는_멈춤은_결제_전_알_수_없는_사유뿐(tmp_path):
    h = _Q(tmp_path)
    job = h.job_now()
    assert eligible(job, 'unknown', '주문서 탭을 못 찾았다')
    assert not eligible(job, 'pay_interrupted', '결제 중 끊김')
    assert not eligible(job, 'unknown', '알리페이 결제 승인 실패: verify-failed')
    assert not eligible(job, 'margin', '마진 미달')
    done_once = dataclasses.replace(job, options={OPERATOR_KEY: 1})
    assert not eligible(done_once, 'unknown', '주문서 탭을 못 찾았다')


def test_retry_판단은_작업을_처음부터_다시_넣고_cancel_은_표시를_붙인다(tmp_path):
    h = _Q(tmp_path)
    flagged: list[tuple] = []
    reports: list[str] = []
    svc = OperatorService(
        OperatorAgent(),
        call=lambda t, a: '',
        queue=h.q,
        flag_order=lambda key, err, ev: flagged.append((key, err, ev)) or '재고X 표시함',
        report=lambda job, line: reports.append(line),
        run_async=False,
    )
    svc.apply(h.job_now(), Verdict('retry', '탭이 닫혀 있었다'))
    again = h.job_now()
    assert again.state == 'queued' and again.options.get(OPERATOR_KEY) == 1
    # 취소는 근거를 메모로 남긴다
    h.q.finish(again.id, 'needs_human', error='unknown')
    svc.apply(h.job_now(), Verdict('cancel', '품절', '주문 옵션 240 (품절) — 상품 화면 선택지'))
    assert flagged and flagged[0][0] == 'ord_T1' and flagged[0][1] == 'out_of_stock'
    assert '[AI 대행 확인]' in flagged[0][2]
    # human 은 아무것도 바꾸지 않는다
    before = h.job_now().state
    svc.apply(h.job_now(), Verdict('human', '판단 불가'))
    assert h.job_now().state == before and any('사람 확인' in r for r in reports)


@pytest.mark.parametrize('blocked', ['결제하기 버튼 클릭', 'password 입력', '주문취소 클릭'])
def test_결제_비밀번호_취소_글자는_대행_코드에서_막힌다(blocked):
    from samba_agent.repair.agent import blocked_reason

    assert blocked_reason(blocked) is not None
