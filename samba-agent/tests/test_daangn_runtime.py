import sqlite3
from pathlib import Path

from tools.daangn.collector import Candidate
from tools.daangn import runtime


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
