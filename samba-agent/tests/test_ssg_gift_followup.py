from types import SimpleNamespace

import pytest

from samba_agent.ops.ssg_gift_followup import GiftFollowup
from samba_agent.queue.db import GIFT_FOLLOWUP_KEY, JobQueue
from samba_agent.queue.worker import Worker, WorkerDeps

NO = '2026103039AE04'


def outcome():
    return {
        'outcome': 'done',
        'results': {
            'buyer.ssg': {'payload': {'order_type': 'gift', 'account': 'edelvise06'}},
            'payer': {'payload': {'source_order_no': NO}},
        },
    }


def harness(tmp_path, *, accepted=False, accept_line='SSG 선물 수락 실패 — 폰 사용 중'):
    q = JobQueue(tmp_path / 'jobs.sqlite')
    job, _ = q.enqueue('748322423603237', 'test', {}, None, wave_id='ord_test')
    clock, calls = [1000.0], []
    source = {
        'source_order_no': NO,
        'paid': 10000,
        'status': '상품준비중',
        'gift_accepted': accepted,
    }

    def read(task):
        calls.append(('read', task['source_order_no'], task['profile']))
        return dict(source)

    def accept(job, out):
        calls.append(('accept', job.order_no))
        return accept_line

    after = GiftFollowup(
        q,
        accept=accept,
        source_of_job=lambda job: ('SSG', 'A515131017'),
        read_detail=read,
        now=lambda: clock[0],
    )
    worker = Worker(
        WorkerDeps(
            q,
            object(),
            'test',
            lambda *args: None,
            lambda job: SimpleNamespace(),
            dry_run=False,
            after_done=after,
        )
    )
    return q, job, worker, after, clock, calls, source


def test_failure_stays_done_and_has_durable_pending(tmp_path):
    q, job, worker, after, _clock, _calls, _source = harness(tmp_path)
    worker._apply(job, outcome())
    saved = q.get_by_id(job.id)
    assert saved.state == 'done'
    assert saved.options[GIFT_FOLLOWUP_KEY]['state'] == 'pending'
    assert q.claim() is None
    assert after.drain() is False  # backoff


def test_restart_resumes_followup_without_graph_or_repurchase(tmp_path):
    _q, job, worker, after, clock, calls, source = harness(tmp_path)
    worker._apply(job, outcome())
    restarted = JobQueue(tmp_path / 'jobs.sqlite')
    clock[0] += 3600
    source['gift_accepted'] = True
    after.queue = restarted
    assert after.drain() is True
    assert restarted.get_by_id(job.id).state == 'done'
    assert restarted.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['state'] == 'verified'
    assert len([c for c in calls if c[0] == 'accept']) == 1
    assert restarted.claim() is None


def test_phone_success_and_product_preparing_are_not_independent_acceptance(tmp_path):
    q, job, worker, after, clock, calls, _source = harness(
        tmp_path, accept_line='SSG 선물 받기 완료'
    )
    worker._apply(job, outcome())
    task = q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]
    assert task['state'] == 'pending'
    assert task['phase'] == 'verify'
    clock[0] += 3600
    after.drain()
    assert len([c for c in calls if c[0] == 'accept']) == 1


def test_source_already_accepted_skips_phone(tmp_path):
    q, job, worker, _after, _clock, calls, _source = harness(tmp_path, accepted=True)
    worker._apply(job, outcome())
    assert q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['state'] == 'verified'
    assert not any(c[0] == 'accept' for c in calls)


@pytest.mark.parametrize(
    'change', [{'source_order_no': 'OTHER'}, {'paid': 0}, {'profile': 'other'}]
)
def test_wrong_or_unreadable_source_holds_without_phone(tmp_path, change):
    q, job, worker, _after, _clock, calls, source = harness(tmp_path)
    source.update(change)
    worker._apply(job, outcome())
    assert q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['state'] == 'pending'
    assert not any(c[0] == 'accept' for c in calls)


def test_exception_leaves_pending_and_purchase_done(tmp_path):
    q, job, worker, after, _clock, _calls, _source = harness(tmp_path)
    after.read_detail = lambda task: (_ for _ in ()).throw(RuntimeError('offline'))
    worker._apply(job, outcome())
    assert q.get_by_id(job.id).state == 'done'
    assert q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['state'] == 'pending'


def test_pending_is_present_before_callback_and_retries_on_idle_tick(tmp_path):
    q, job, worker, after, clock, _calls, source = harness(tmp_path)

    def check(task):
        assert q.get_by_id(job.id).state == 'done'
        assert GIFT_FOLLOWUP_KEY in q.get_by_id(job.id).options
        return dict(source)

    after.read_detail = check
    worker._apply(job, outcome())
    clock[0] += 3600
    source['gift_accepted'] = True
    assert worker.tick() is None  # object graph cannot be invoked
    assert q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['state'] == 'verified'


def test_non_gift_does_not_register_followup(tmp_path):
    q, job, worker, _after, _clock, calls, _source = harness(tmp_path)
    out = outcome()
    out['results']['buyer.ssg']['payload']['order_type'] = 'direct'
    worker._apply(job, out)
    assert GIFT_FOLLOWUP_KEY not in q.get_by_id(job.id).options
    assert calls == []


def test_source_lookup_failure_still_registers_pending(tmp_path):
    q, job, worker, after, _clock, calls, _source = harness(tmp_path)
    after.source_of_job = lambda job: (_ for _ in ()).throw(RuntimeError('offline'))
    worker._apply(job, outcome())
    assert q.get_by_id(job.id).state == 'done'
    assert GIFT_FOLLOWUP_KEY in q.get_by_id(job.id).options
    assert not any(c[0] == 'accept' for c in calls)


def test_cross_source_uses_actual_ssg_buyer_and_saved_product(tmp_path):
    from samba_agent.ops.ssg_gift_followup import source_of_followup

    q, job, worker, after, _clock, _calls, _source = harness(tmp_path)
    after.source_of_job = lambda job: ('HMALL', 'A515131017')
    worker._apply(job, outcome())
    assert source_of_followup(q.get_by_id(job.id)) == ('SSG', 'A515131017')


def test_cross_source_does_not_take_another_buyers_account(tmp_path):
    q, job, worker, _after, _clock, calls, _source = harness(tmp_path)
    out = outcome()
    out['results'] = {
        'buyer.hmall': {'payload': {'account': 'other', 'order_type': 'gift'}},
        **out['results'],
    }
    worker._apply(job, out)
    assert q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['profile'] == 'edelvise06'
    assert calls[0] == ('read', NO, 'edelvise06')


def test_atomic_done_and_pending_rollback_together(tmp_path):
    import sqlite3

    q, job, _worker, _after, _clock, _calls, _source = harness(tmp_path)
    q._db.execute(
        "CREATE TRIGGER stop_update BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT, 'fail'); END"
    )
    with pytest.raises(sqlite3.IntegrityError):
        q.finish(job.id, 'done', gift_followup={'state': 'pending'})
    assert q.get_by_id(job.id).state == 'queued'
    assert GIFT_FOLLOWUP_KEY not in q.get_by_id(job.id).options


def test_dry_run_never_registers_or_accepts(tmp_path):
    q, job, worker, _after, _clock, calls, _source = harness(tmp_path)
    worker.d.dry_run = True
    worker._apply(job, outcome())
    assert GIFT_FOLLOWUP_KEY not in q.get_by_id(job.id).options
    assert not calls


def test_unknown_acceptance_remains_durable_for_human_after_limit(tmp_path):
    q, job, worker, after, clock, _calls, _source = harness(tmp_path)
    worker._apply(job, outcome())
    for _ in range(7):
        clock[0] += 3600
        after.drain()
    assert q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['state'] == 'needs_ai'
    assert q.get_by_id(job.id).state == 'done'
    assert q.claim() is None


def test_readonly_detail_adapter_reuses_existing_script(tmp_path):
    from samba_agent.ops.ssg_gift_followup import detail_reader

    calls = []

    class Bridge:
        def with_lane(self, lane):
            assert lane == 'ssg-gift-followup'
            return self

        def scoped(self, tools):
            # 상세 읽기와 키마스터 재로그인만 — 구매·결제·수리 도구는 노출하지 않는다
            assert tools in (['run_script'], ['new_tab', 'login', 'wait', 'close_tab'])
            return self

        def call(self, tool, **args):
            calls.append((tool, args))
            return SimpleNamespace(result='{"source_order_no":"2026103039AE04","paid":10000}')

    result = detail_reader(Bridge())({'source_order_no': NO, 'profile': 'edelvise06'})
    assert result['source_order_no'] == NO
    assert calls[0][1]['name'] == 'ssg_order_detail'
    assert 'edelvise06' in calls[0][1]['args']


def test_detail_reader_relogs_in_once_when_session_expired():
    from samba_agent.ops.ssg_gift_followup import detail_reader

    calls = []
    details = iter([
        '{"source_order_no":"2026103039AE04","paid":0,"note":"login required"}',
        '{"source_order_no":"2026103039AE04","paid":10000}',
    ])

    class Bridge:
        def with_lane(self, lane):
            return self

        def scoped(self, tools):
            return self

        def call(self, tool, **args):
            calls.append(tool)
            if tool == 'run_script':
                return SimpleNamespace(result=next(details))
            if tool == 'new_tab':
                return SimpleNamespace(result='opened tab 0123abcd-0000-0000-0000-000000000000')
            if tool == 'login':
                return SimpleNamespace(result='already signed in')
            return SimpleNamespace(result='ok')

    result = detail_reader(Bridge())({'source_order_no': NO, 'profile': 'edelvise06'})
    assert result['paid'] == 10000
    assert calls == ['run_script', 'new_tab', 'wait', 'login', 'close_tab', 'run_script']


@pytest.mark.parametrize(
    'status', ['취소완료', '반품완료', '선물 기간 만료', '선물 거절', 'cancelled', 'expired']
)
def test_closed_order_never_uses_phone_or_accepts(tmp_path, status):
    q, job, worker, after, _clock, calls, source = harness(tmp_path)
    source['status'] = status
    after.verify_only = lambda task: pytest.fail('종료 주문 폰 접근 금지')
    worker._apply(job, outcome())
    assert not any(c[0] == 'accept' for c in calls)
    assert q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['state'] == 'needs_ai'


def test_one_phone_session_covers_verify_accept_and_fresh_recheck(tmp_path):
    from contextlib import contextmanager

    q, job, worker, after, _clock, _calls, _source = harness(tmp_path)
    events = []
    checks = iter([False, True])

    @contextmanager
    def session():
        events.append('lock')
        try:
            yield
        finally:
            events.append('unlock')

    after.phone_session = session
    after.verify_only = lambda task: (events.append('verify'), next(checks))[1]
    after.accept = lambda *args: (events.append('accept'), 'SSG 선물 받기 완료')[1]
    worker._apply(job, outcome())
    assert events == ['lock', 'verify', 'accept', 'verify', 'unlock']
    assert q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['state'] == 'verified'


@pytest.mark.parametrize(
    'status,number', [('cancel_requested', NO), ('returning', NO), ('wait_ship', 'OTHER')]
)
def test_current_market_order_is_rechecked_before_source_or_phone(tmp_path, status, number):
    q, job, worker, after, _clock, calls, _source = harness(tmp_path)
    after.read_order = lambda key: SimpleNamespace(status=status, sourcing_order_number=number)
    worker._apply(job, outcome())
    assert calls == []
    assert q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['state'] == 'needs_ai'
    assert q.get_by_id(job.id).state == 'done'


def test_old_pending_is_not_silently_hidden_and_never_accepts(tmp_path):
    q, job, worker, after, clock, calls, _source = harness(tmp_path)
    worker._apply(job, outcome())
    count = len(calls)
    clock[0] += 8 * 86400
    assert after.drain() is True
    assert len(calls) == count
    assert q.get_by_id(job.id).options[GIFT_FOLLOWUP_KEY]['state'] == 'needs_ai'
    assert q.get_by_id(job.id).state == 'done'
