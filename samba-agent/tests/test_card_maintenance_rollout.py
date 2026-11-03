import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('card_rollout', Path(__file__).parents[1] / 'tools/maintenance_card_rollout.py')
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)


def database():
    db = sqlite3.connect(':memory:', isolation_level=None)
    db.execute('CREATE TABLE jobs(id INTEGER PRIMARY KEY,state TEXT,options TEXT,error TEXT,updated_at TEXT,attempts INTEGER)')
    for jid, state in [(1, 'queued'), (2, 'running'), (3, 'needs_ai')]:
        db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?)', (jid, state, '{"keep":42}', 'old' if jid == 3 else None, 'unchanged', 1))
    return db


def test_only_unclaimed_work_is_held_and_restored_without_replay():
    db = database()
    before = db.execute('SELECT * FROM jobs WHERE id IN (2,3)').fetchall()
    assert rollout.hold_queued(db, 'owner') == [1]
    assert db.execute('SELECT * FROM jobs WHERE id IN (2,3)').fetchall() == before
    assert db.execute('SELECT updated_at,attempts FROM jobs WHERE id=1').fetchone() == ('unchanged', 1)
    assert rollout.restore_queued(db, 'owner', [1]) == [1]
    assert db.execute('SELECT state,options,error FROM jobs WHERE id=1').fetchone() == ('queued', '{"keep": 42}', None)


def test_restore_preserves_other_session_changes():
    db = database()
    rollout.hold_queued(db, 'owner')
    data = json.loads(db.execute('SELECT options FROM jobs WHERE id=1').fetchone()[0])
    data['other_session'] = True
    db.execute('UPDATE jobs SET options=? WHERE id=1', (json.dumps(data),))
    rollout.restore_queued(db, 'owner', [1])
    assert json.loads(db.execute('SELECT options FROM jobs WHERE id=1').fetchone()[0])['other_session'] is True
    rollout.hold_queued(db, 'next')
    db.execute("UPDATE jobs SET state='cancelled' WHERE id=1")
    assert rollout.restore_queued(db, 'next', [1]) == []
    assert db.execute('SELECT state FROM jobs WHERE id=1').fetchone()[0] == 'cancelled'


def test_maintenance_claim_guard_blocks_new_claims_only():
    module_spec = importlib.util.spec_from_file_location('claim_guard', Path(__file__).parents[1] / 'tools/maintenance_claim_guard.py')
    guard = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(guard)
    db = database()
    guard.install(db)
    with pytest.raises(sqlite3.IntegrityError, match='new claim paused'):
        db.execute("UPDATE jobs SET state='running' WHERE id=1")
    assert db.execute('SELECT state FROM jobs WHERE id=1').fetchone()[0] == 'queued'
    db.execute("UPDATE jobs SET state='done' WHERE id=2")
    assert db.execute('SELECT state FROM jobs WHERE id=2').fetchone()[0] == 'done'
    guard.remove(db)
    db.execute("UPDATE jobs SET state='running' WHERE id=1")
    assert db.execute('SELECT state FROM jobs WHERE id=1').fetchone()[0] == 'running'
