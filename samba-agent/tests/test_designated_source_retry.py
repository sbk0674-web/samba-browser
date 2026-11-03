import pytest

from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.failures import FailReason
from samba_agent.queue.db import JobQueue
from samba_agent.queue.worker import Worker, WorkerDeps


@pytest.mark.parametrize('block', ['', 'paid', 'interrupted', 'other_source', 'already_recovered'])
def test_designated_source_retry_is_only_for_unpaid_cross_checkout_failure(tmp_path, block):
    queue = JobQueue(tmp_path / 'jobs.sqlite')
    options = {'_order_received_at': '2026-10-11T15:00:00+00:00'}
    if block == 'already_recovered':
        options['no_cross'] = True
    queue.enqueue('order-a', 'test', options, None)
    job = queue.claim()
    queue.finish(job.id, 'needs_ai', error='unknown')
    worker = Worker(WorkerDeps(
        queue=queue, graph=object(), version='test', report=lambda *_: None,
        parse_order=lambda _: None, dry_run=False,
    ))
    worker._pay_started.add(job.id)
    out = {
        'order': OrderRef(order_no='order-a', source='MUSINSA', seller='test', sku='sku', qty=1),
        'outcome': 'needs_ai', 'fail_reason': FailReason.UNKNOWN,
        'results': {
            'buyer.musinsa': AgentResult(status='ok', reason='quote', payload={
                'buy_source': '29CM' if block != 'other_source' else 'MUSINSA', 'cost': 100,
            }),
            'payer': AgentResult(status='needs_ai', fail_reason=FailReason.UNKNOWN,
                reason='결제창을 열지 못했다: 수단 라디오 대응 실패',
                payload={'paid': block == 'paid'}),
        },
    }
    if block == 'interrupted':
        out['fail_reason'] = FailReason.PAY_INTERRUPTED
    recovered = worker._retry_designated_source(job, out)
    if block:
        assert recovered is None
        assert queue.get('order-a').state == 'needs_ai'
    else:
        assert recovered.state == 'queued'
        assert recovered.options['no_cross'] is True
        assert recovered.options['_order_received_at'] == options['_order_received_at']
        assert job.id not in worker._pay_started
