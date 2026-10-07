# 외부 기입 실패 알림 — 실패한 요청을 주문 스레드에 한 번만 알린다
from pathlib import Path

import pytest

from samba_agent.export.failures import ExportFail
from samba_agent.export.notify import ExportNotifier
from samba_agent.export.store import ExportQueue


@pytest.fixture()
def queue(tmp_path: Path) -> ExportQueue:
    return ExportQueue(tmp_path / 'exports.sqlite')


def failed(queue, order_no: str, target: str = 'emp') -> int:
    req = queue.enqueue(order_no, target, 62470, 2300)
    queue.claim_next([target])
    queue.fail(req.id, ExportFail.VALUE_CONFLICT, '덮어쓰지 않았다 — 원가 50,000')
    return req.id


def test_실패한_요청을_주문_스레드에_알린다(queue):
    failed(queue, 'A1')
    sent: list[tuple[str | None, str]] = []

    def post(thread_ts, text):
        sent.append((thread_ts, text))
        return True

    n = ExportNotifier(queue, lambda no: f'ts-{no}', post).tick()
    assert n == 1
    assert sent[0][0] == 'ts-A1'
    text = sent[0][1]
    assert 'A1' in text
    assert 'emp' in text
    assert 'value_conflict' in text
    assert '50,000' in text
    assert '62,470' in text


def test_한_번_알린_실패는_다시_알리지_않는다(queue):
    failed(queue, 'A1')
    sent: list[str] = []
    notifier = ExportNotifier(queue, lambda _no: None, lambda _t, text: sent.append(text) or True)
    assert notifier.tick() == 1
    assert notifier.tick() == 0
    assert len(sent) == 1


def test_성공과_대기는_알리지_않는다(queue):
    done = queue.enqueue('A1', 'emp', 1000, 0)
    queue.claim_next(['emp'])
    queue.done(done.id, '기입 완료')
    queue.enqueue('A2', 'emp', 2000, 0)
    sent: list[str] = []
    n = ExportNotifier(queue, lambda _no: None, lambda _t, text: sent.append(text) or True).tick()
    assert n == 0
    assert sent == []


def test_슬랙이_없어도_알린_것으로_친다(queue):
    rid = failed(queue, 'A1')
    n = ExportNotifier(queue, lambda _no: None, lambda _t, _text: False).tick()
    assert n == 1
    assert queue.get(rid).notified is True


def test_전송이_예외를_던지면_다음에_다시_알린다(queue):
    rid = failed(queue, 'A1')

    def post(_t, _text):
        raise RuntimeError('네트워크')

    notifier = ExportNotifier(queue, lambda _no: None, post)
    assert notifier.tick() == 0
    assert queue.get(rid).notified is False


def test_한_건이_실패해도_나머지는_알린다(queue):
    failed(queue, 'A1')
    failed(queue, 'A2')
    sent: list[str] = []

    def post(_t, text):
        if 'A1' in text:
            raise RuntimeError('네트워크')
        sent.append(text)
        return True

    assert ExportNotifier(queue, lambda _no: None, post).tick() == 1
    assert len(sent) == 1
    assert 'A2' in sent[0]


def test_스레드가_없으면_post_new로_최상위_메시지를_올린다(queue):
    # 리뷰 지적 — I2: 스레드 없는 주문의 실패 알림이 post(None, ...) 로 조용히 사라졌다
    failed(queue, 'A1')
    posted: list[tuple[str | None, str]] = []
    posted_new: list[str] = []

    def post(thread_ts, text):
        posted.append((thread_ts, text))
        return True

    def post_new(text):
        posted_new.append(text)
        return 'ts-new-1'

    notifier = ExportNotifier(queue, lambda _no: None, post, post_new=post_new)
    n = notifier.tick()
    assert n == 1
    assert posted == []
    assert len(posted_new) == 1
    assert 'A1' in posted_new[0]


def test_스레드가_있으면_post_new는_안_쓴다(queue):
    failed(queue, 'A1')
    posted: list[tuple[str | None, str]] = []
    posted_new: list[str] = []

    notifier = ExportNotifier(
        queue,
        lambda no: f'ts-{no}',
        lambda ts, text: posted.append((ts, text)) or True,
        post_new=lambda text: posted_new.append(text) or 'ts-new',
    )
    n = notifier.tick()
    assert n == 1
    assert posted == [('ts-A1', posted[0][1])]
    assert posted_new == []


def test_post_new가_None을_돌려주면_경고_경로이되_알린_것으로_친다(queue):
    rid = failed(queue, 'A1')
    notifier = ExportNotifier(
        queue, lambda _no: None, lambda _t, _text: True, post_new=lambda _text: None
    )
    n = notifier.tick()
    assert n == 1
    assert queue.get(rid).notified is True


def test_run_forever_는_멈추라고_하면_멈춘다(queue):
    failed(queue, 'A1')
    sent: list[str] = []
    stops = iter([False, True])
    slept: list[float] = []
    ExportNotifier(queue, lambda _no: None, lambda _t, text: sent.append(text) or True).run_forever(
        lambda: next(stops), interval_s=15.0, sleep=slept.append
    )
    assert len(sent) == 1
    assert slept == [15.0]


def test_나중에_끝난_요청의_성공을_주문_스레드에_알린다(queue):
    req = queue.enqueue('E1', 'emp', 62470, 2300)
    claimed = queue.claim_next(['emp'])
    assert claimed is not None
    queue.done(req.id, '기입 확인')
    queue.enqueue('S1', 'shopmine', 1000, 0)
    shop = queue.claim_next(['shopmine'])
    assert shop is not None
    queue.done(shop.id, '처리 1건')
    posts: list[tuple[str | None, str]] = []

    def post(thread_ts, text):
        posts.append((thread_ts, text))
        return True

    notifier = ExportNotifier(queue, lambda _o: 't1', post, done_targets=('emp', 'emp_cancel'))
    assert notifier.tick() == 1
    assert posts == [('t1', 'E1 외부 기입 완료(emp) — 원가 62,470 · 배송비 2,300')]
    assert notifier.tick() == 0


def test_알림을_켜기_전에_들어온_성공은_알리지_않는다(queue):
    req = queue.enqueue('E1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.done(req.id, '기입 확인')
    notifier = ExportNotifier(
        queue, lambda _o: 't1', lambda _t, _x: True, done_targets=('emp',), since='9999-01-01'
    )
    assert notifier.tick() == 0
