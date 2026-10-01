"""중국 크림 得物 송장 수집 — 상세 화면 글자에서 택배사·운송장을 읽는다."""

from samba_agent.ops.dewu_tracking import collect_dewu_tracking, tracking_of
from samba_agent.ops.ssg_gift_accept import Node


def n(text: str, y: int = 100) -> Node:
    return Node(text=text, desc='', rid='', x=360, y=y)


def test_택배사와_운송장을_읽는다():
    assert tracking_of([n('平台发货'), n('顺丰速运 SF1869232756807')]) == ('顺丰速运', 'SF1869232756807')
    assert tracking_of([n('顺丰'), n('运单号：SF1234567890123')]) == ('顺丰速运', 'SF1234567890123')
    assert tracking_of([n('中通快递'), n('78912345678901')]) == ('中通快递', '78912345678901')
    assert tracking_of([n('提前入仓鉴别通过 预计今日21:00前发货')]) is None


def test_읽은_송장만_삼바에_넣는다(monkeypatch):
    written: list[tuple] = []

    class Wave:
        def dewu_tracking_targets(self):
            return [
                {'order_number': 'A-1', 'sourcing_order_number': '110213474374883854'},
                {'order_number': 'A-2', 'sourcing_order_number': '110000000000000002'},
            ]

        def write_overseas_tracking(self, no, company, number):
            written.append((no, company, number))
            return True

    got = {'110213474374883854': ('顺丰速运', 'SF1869232756807')}
    monkeypatch.setattr('samba_agent.ops.dewu_tracking.read_dewu_tracking', lambda phone, son, sleep: got.get(son))

    class Phone:
        def key(self, code):
            pass

    res = collect_dewu_tracking(Wave(), Phone(), sleep=lambda s: None)  # type: ignore[arg-type]
    assert res == {'checked': 2, 'updated': 1}
    assert written == [('A-1', '顺丰速运', 'SF1869232756807')]
