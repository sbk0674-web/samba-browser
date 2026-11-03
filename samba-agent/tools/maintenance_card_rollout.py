"""Hold only unclaimed work while the existing idle-only harness rollout runs."""
import json
import os
import sqlite3
import subprocess
import time
from datetime import datetime
from pathlib import Path

KEY = '_card_rollout_hold'


def hold_queued(db, owner):
    held = []
    db.execute('BEGIN IMMEDIATE')
    try:
        for jid, options, error in db.execute(
            "SELECT id, options, error FROM jobs WHERE state='queued' LIMIT 100"
        ).fetchall():
            data = json.loads(options)
            if KEY in data:
                raise RuntimeError('Existing maintenance owner; refusing to overwrite')
            data[KEY] = {'owner': owner, 'error': error}
            db.execute(
                "UPDATE jobs SET state='needs_ai', error=?, options=? WHERE id=? AND state='queued'",
                ('maintenance:' + owner, json.dumps(data, ensure_ascii=False), jid),
            )
            held.append(jid)
        db.commit()
    except BaseException:
        db.rollback()
        raise
    return held


def restore_queued(db, owner, ids):
    restored = []
    db.execute('BEGIN IMMEDIATE')
    try:
        for jid in ids:
            row = db.execute('SELECT state, error, options FROM jobs WHERE id=?', (jid,)).fetchone()
            if row is None:
                continue
            state, error, options = row
            data = json.loads(options)
            marker = data.get(KEY, {})
            if state != 'needs_ai' or error != 'maintenance:' + owner or marker.get('owner') != owner:
                continue  # A different session changed this job; preserve its decision.
            data.pop(KEY)
            db.execute(
                "UPDATE jobs SET state='queued', error=?, options=? WHERE id=?",
                (marker.get('error'), json.dumps(data, ensure_ascii=False), jid),
            )
            restored.append(jid)
        db.commit()
    except BaseException:
        db.rollback()
        raise
    return restored


def main():
    import argparse
    import msvcrt
    parser = argparse.ArgumentParser()
    parser.add_argument('--shell', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    lock = open(root / 'logs/card-maintenance.lock', 'a+b')
    lock.seek(0)
    lock.write(b'1')
    lock.flush()
    lock.seek(0)
    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    owner = 'naver-card-' + datetime.now().strftime('%Y%m%d-%H%M%S')
    journal = root / 'logs/card-maintenance-journal.json'
    db = sqlite3.connect(root / 'jobs.sqlite', timeout=3, isolation_level=None)
    held = set()
    child = None
    try:
        held.update(hold_queued(db, owner))
        journal.write_text(json.dumps({'owner': owner, 'ids': sorted(held), 'state': 'holding'}), encoding='utf-8')
        print('Held unclaimed jobs:', len(held), flush=True)
        with open(root / 'logs/card-maintenance-apply.log', 'wb') as out, open(root / 'logs/card-maintenance-apply.err.log', 'wb') as err:
            child = subprocess.Popen(
                [args.shell, '-NoProfile', '-NonInteractive', '-File', str(root / 'restart-harness-safe.ps1'), '-MaxWaitMinutes', '60'],
                cwd=root, stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            while child.poll() is None:
                added = hold_queued(db, owner)
                if added:
                    held.update(added)
                    journal.write_text(json.dumps({'owner': owner, 'ids': sorted(held), 'state': 'holding'}), encoding='utf-8')
                    print('Held unclaimed jobs:', len(held), flush=True)
                time.sleep(1)
        print('Idle-only rollout exit:', child.returncode, flush=True)
    finally:
        # No paid/previously failed job was selected, and attempts/checkpoints are untouched.
        restored = restore_queued(db, owner, sorted(held))
        journal.write_text(json.dumps({'owner': owner, 'ids': sorted(held), 'restored': restored, 'state': 'restored'}), encoding='utf-8')
        print('Restored original queued jobs:', len(restored), flush=True)
        db.close()
        lock.close()


if __name__ == '__main__':
    main()
