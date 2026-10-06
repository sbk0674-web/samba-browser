# 외부 기입 배선 — 설정 기본값 · 하네스 연결 · CLI
from pathlib import Path

import pytest

from samba_agent.__main__ import make_export
from samba_agent.agents.contracts import AgentResult, OrderRef
from samba_agent.export.__main__ import main as export_main
from samba_agent.export.desktop import build_adapters
from samba_agent.export.failures import ExportFail
from samba_agent.export.store import ExportQueue
from samba_agent.settings import DEFAULT_ROOT, Settings


def settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **env: str) -> Settings:
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'test-token')
    monkeypatch.setenv('SAMBA_EXPORT_DB_PATH', str(tmp_path / 'exports.sqlite'))
    monkeypatch.delenv('SAMBA_EXPORT_TARGETS', raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return Settings()  # type: ignore[call-arg]


def test_기본은_꺼져_있다(monkeypatch, tmp_path):
    s = settings(monkeypatch, tmp_path)
    assert s.export_enabled is False
    assert s.export_wait_s == 60.0
    assert s.export_routing_file == DEFAULT_ROOT / 'export.yaml'
    assert make_export(s) is None


def test_큐_파일_기본_위치는_하네스_폴더다(monkeypatch):
    monkeypatch.setenv('SAMBA_BRIDGE_TOKEN', 'test-token')
    monkeypatch.delenv('SAMBA_EXPORT_DB_PATH', raising=False)
    assert Settings().export_db_path == DEFAULT_ROOT / 'exports.sqlite'  # type: ignore[call-arg]


def test_켜면_큐와_export_함수를_만든다(monkeypatch, tmp_path):
    s = settings(monkeypatch, tmp_path, SAMBA_EXPORT_ENABLED='true', SAMBA_EXPORT_WAIT_S='0')
    made = make_export(s)
    assert made is not None
    queue, exporter = made
    out = exporter(
        {
            'order': OrderRef(
                order_no='A1', source='무신사', seller='GS이숍(캐논)', sku='S1', qty=1
            ),
            'dry_run': False,
            'results': {
                'recorder': AgentResult(
                    status='ok',
                    reason='기록',
                    payload={'values': {'real_price': 62470, 'shipping_fee': 2300}},
                )
            },
        }
    )
    assert out.payload['export'] == 'pending'
    assert out.payload['target'] == 'emp'
    assert queue.find('A1', 'emp') is not None


def test_대상을_주지_않으면_어댑터가_없다():
    assert build_adapters(()) == {}


def test_shopmine_대상은_샵마인_어댑터를_만든다(monkeypatch):
    from samba_agent.export import desktop
    from samba_agent.export.adapters import BatchAdapter

    monkeypatch.setattr(desktop, '_shopmine_ui', lambda: object())
    made = build_adapters(('shopmine',))
    assert set(made) == {'shopmine', 'shopmine_cancel', 'shopmine_lookup'}
    assert isinstance(made['shopmine'], BatchAdapter)


def test_emp_대상은_EMP_어댑터를_만든다(monkeypatch):
    from samba_agent.export import desktop
    from samba_agent.export.adapters import BatchAdapter
    from samba_agent.export.desktop.emp import EmpAdapter

    monkeypatch.setattr(desktop, '_emp_ui', lambda: object())
    made = build_adapters(('emp',))
    assert isinstance(made['emp'], EmpAdapter)
    assert not isinstance(made['emp'], BatchAdapter)  # 셀형 — 주문별 읽기·쓰기


def test_모르는_대상은_거부한다():
    with pytest.raises(ValueError):
        build_adapters(('coupang',))


def test_export_targets_설정은_쉼표_목록이다(monkeypatch, tmp_path):
    s = settings(monkeypatch, tmp_path, SAMBA_EXPORT_TARGETS='shopmine, emp')
    assert s.export_target_list == ('shopmine', 'emp')
    assert settings(monkeypatch, tmp_path).export_target_list == ()


def test_list_는_최근_요청을_보여_준다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    queue = ExportQueue(tmp_path / 'exports.sqlite')
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')
    assert export_main(['list']) == 0
    out = capsys.readouterr().out
    assert 'A1' in out
    assert 'emp' in out
    assert 'failed' in out
    assert 'not_found' in out


def test_list_는_비어_있으면_그렇게_말한다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    assert export_main(['list']) == 0
    assert '없다' in capsys.readouterr().out


def test_requeue_는_실패한_요청을_되살린다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    queue = ExportQueue(tmp_path / 'exports.sqlite')
    req = queue.enqueue('A1', 'emp', 62470, 2300)
    queue.claim_next(['emp'])
    queue.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')
    assert export_main(['requeue', 'A1', 'emp']) == 0
    assert queue.get(req.id).status == 'pending'
    assert 'A1' in capsys.readouterr().out


def test_requeue_할_실패_요청이_없으면_1(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    assert export_main(['requeue', 'A9', 'emp']) == 1
    assert '없다' in capsys.readouterr().out


def test_db_옵션이_설정값을_덮어쓴다(monkeypatch, tmp_path, capsys):
    # 리뷰 지적 — I3: 예약 작업은 cwd 의 .env 를 못 찾는다 — --db 로 직접 지정할 수 있어야 한다
    settings(monkeypatch, tmp_path)  # SAMBA_EXPORT_DB_PATH 를 가리키는 기본 큐
    other_path = tmp_path / 'other.sqlite'
    other = ExportQueue(other_path)
    req = other.enqueue('B1', 'emp', 1000, 0)
    other.claim_next(['emp'])
    other.fail(req.id, ExportFail.NOT_FOUND, '주문 없음')

    assert export_main(['--db', str(other_path), 'list']) == 0
    out = capsys.readouterr().out
    assert 'B1' in out


def test_shopmine_명령은_드라이버를_만들어_한_번_돌린다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    import samba_agent.export.__main__ as cli

    made: dict[str, object] = {}

    class FakeAdapter:
        def __init__(self, ui, *, dry_run=False, **_kw):
            made['dry_run'] = dry_run

        def complete_pending(self, order_nos):
            made['order_nos'] = list(order_nos)
            return {'A1', 'A2'}

    monkeypatch.setattr(cli, 'PywinautoShopMineUi', lambda: object())
    monkeypatch.setattr(cli, 'ShopMineAdapter', FakeAdapter)
    assert export_main(['shopmine', '--dry', 'A1', 'A2', 'A3']) == 0
    assert made['dry_run'] is True
    assert made['order_nos'] == ['A1', 'A2', 'A3']
    assert '2건 / 요청 3건' in capsys.readouterr().out


def test_shopmine_명령은_주문번호가_없으면_큐의_대기_요청을_쓴다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    import samba_agent.export.__main__ as cli

    queue = ExportQueue(tmp_path / 'exports.sqlite')
    queue.enqueue('S1', 'shopmine', 1000, 0)
    got: dict[str, object] = {}

    class FakeAdapter:
        def __init__(self, ui, **_kw):
            pass

        def complete_pending(self, order_nos):
            got['order_nos'] = list(order_nos)
            return set()

    monkeypatch.setattr(cli, 'PywinautoShopMineUi', lambda: object())
    monkeypatch.setattr(cli, 'ShopMineAdapter', FakeAdapter)
    assert export_main(['shopmine']) == 0
    assert got['order_nos'] == ['S1']
    assert queue.find('S1', 'shopmine').status == 'pending'  # 큐는 건드리지 않는다


def test_shopmine_명령은_넘길_주문번호가_없으면_1(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    assert export_main(['shopmine', '--dry']) == 1
    assert '주문번호가 없다' in capsys.readouterr().out


def test_shopmine_명령은_재시도_사유를_출력하고_2를_돌려준다(monkeypatch, tmp_path, capsys):
    settings(monkeypatch, tmp_path)
    import samba_agent.export.__main__ as cli
    from samba_agent.export.adapters import AdapterRetry

    class Failing:
        def __init__(self, ui, **_kw):
            pass

        def complete_pending(self, order_nos):
            raise AdapterRetry(ExportFail.WINDOW_MISSING, '샵마인 창 없음')

    monkeypatch.setattr(cli, 'PywinautoShopMineUi', lambda: object())
    monkeypatch.setattr(cli, 'ShopMineAdapter', Failing)
    assert export_main(['shopmine', 'A1']) == 2
    assert 'window_missing' in capsys.readouterr().out


def test_no_를_붙인_대상은_만들지_않는다(monkeypatch):
    from samba_agent.export import desktop

    monkeypatch.setattr(desktop, '_shopmine_ui', lambda: object())
    made = build_adapters(('shopmine', 'no_shopmine_cancel'))
    assert set(made) == {'shopmine', 'shopmine_lookup'}
