import sqlite3
import pytest
from unittest.mock import Mock
from pathlib import Path

from tools.daangn.collector import Candidate
from tools.daangn import runtime


def test_fast_schedule_only_reopens_urgent_after_cooldown_and_new_event_immediately():
    from dataclasses import replace
    urgent = Candidate('a', 'room', 'item', last_at=1, preview_signal='pickup_request')
    normal = Candidate('a', 'normal', 'item', last_at=1)
    schedule = runtime.CandidateSchedule()
    assert schedule.select([urgent, normal], 100) == [urgent, normal]
    schedule.inspected(urgent, 100)
    schedule.inspected(normal, 100)
    assert schedule.select([urgent, normal], 102) == []
    assert schedule.select([urgent, normal], 115) == [urgent]
    new = replace(urgent, last_at=2)
    assert schedule.select([new, normal], 116) == [new]


def test_fast_collector_waits_two_seconds_without_opening_site(monkeypatch):
    stop = Mock()
    stop.is_set.side_effect = [False, True]
    run = Mock(return_value=[])
    monkeypatch.setattr(runtime, 'run_round', run)
    runtime.run_forever(Mock(), Mock(), stop)
    stop.wait.assert_called_once_with(2)


def test_fast_collector_backs_off_when_bridge_fails(monkeypatch):
    stop = Mock()
    stop.is_set.side_effect = [False, True]
    monkeypatch.setattr(runtime, 'run_round', Mock(side_effect=RuntimeError('private')))
    runtime.run_forever(Mock(), Mock(), stop)
    stop.wait.assert_called_once_with(30)


def test_saved_pickup_wakes_order_intake(monkeypatch):
    stop = Mock()
    stop.is_set.side_effect = [False, True]
    run = Mock(return_value=[{'status': 'saved'}])
    monkeypatch.setattr(runtime, 'run_round', run)
    wake = Mock()
    runtime.run_forever(Mock(), Mock(), stop, on_saved=wake)
    assert run.call_args.kwargs['on_saved'] is wake


def test_active_call_is_busy_even_without_recent_touch():
    phone = Mock()
    phone._run.return_value = b'mCallState=2\nmCallState=0'
    with pytest.raises(RuntimeError, match='통화'):
        runtime._phone_idle(phone)
    assert phone._run.call_count == 1


def test_idle_phone_requires_no_call_and_no_recent_touch():
    phone = Mock()
    phone._run.side_effect = [b'mCallState=0', b'lastUserActivityTime=123 (45000 ms ago)']
    runtime._phone_idle(phone)


def test_account_uses_current_clone_not_older_phone(tmp_path, monkeypatch):
    app = tmp_path / 'SAMBA Browser'
    app.mkdir()
    with sqlite3.connect(app / 'data.db') as db:
        db.execute('CREATE TABLE daangn_accounts (label TEXT, display_name TEXT, state TEXT)')
        db.execute('CREATE TABLE phones (label TEXT, serial TEXT)')
        db.execute('INSERT INTO daangn_accounts VALUES (?, ?, ?)', ('임귀태', '우리', 'logged_in'))
        db.executemany('INSERT INTO phones VALUES (?, ?)', [('임귀태', 'RF9X4021NHD'), ('임귀태', 'R5CT33ZR53H')])
    monkeypatch.setenv('APPDATA', str(tmp_path))
    assert runtime._phone_identity('임귀태') == ('R5CT33ZR53H', '우리')


def test_receipt_and_state_contain_no_peer_or_product(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime, 'RECEIPTS', tmp_path)
    state = runtime.CollectionState(str(tmp_path / 'state.sqlite'))
    candidate = Candidate('서병기', 'room1', '신발', peer_name='구매자', last_at=123)
    assert not state.done(candidate)
    state.mark(candidate, {'pickup_number': '056', 'id': 'ord_1'})
    assert state.done(candidate)
    data = (tmp_path / '056.json').read_text(encoding='utf8')
    assert '구매자' not in data and '신발' not in data
    assert '056' in data and 'ord_1' in data
