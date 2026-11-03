"""Prevent claims racing with the short-lived maintenance holder."""
import json
import sqlite3
import time
from pathlib import Path

TRIGGER = 'card_rollout_claim_guard'


def install(db):
    db.execute('''CREATE TRIGGER card_rollout_claim_guard
        BEFORE UPDATE OF state ON jobs
        WHEN OLD.state='queued' AND NEW.state='running'
        BEGIN SELECT RAISE(ABORT, 'card maintenance: new claim paused'); END''')


def remove(db):
    db.execute('DROP TRIGGER IF EXISTS card_rollout_claim_guard')


def main():
    root = Path(__file__).resolve().parents[1]
    journal = root / 'logs/card-maintenance-journal.json'
    initial = json.loads(journal.read_text(encoding='utf-8'))
    if initial['state'] != 'holding':
        raise RuntimeError('No active maintenance holder')
    owner = initial['owner']
    db = sqlite3.connect(root / 'jobs.sqlite', timeout=3, isolation_level=None)
    install(db)
    print('New claims paused; current running job untouched', flush=True)
    try:
        until = time.monotonic() + 65 * 60
        while time.monotonic() < until:
            try:
                state = json.loads(journal.read_text(encoding='utf-8'))
            except json.JSONDecodeError:
                time.sleep(.25)
                continue
            if state['owner'] != owner or state['state'] != 'holding':
                break
            time.sleep(.25)
    finally:
        remove(db)
        db.close()
        print('New claims resumed', flush=True)


if __name__ == '__main__':
    main()
