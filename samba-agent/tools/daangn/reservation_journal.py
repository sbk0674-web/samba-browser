"""수거 완료 응답이 모호할 때 같은 방에 예약을 재전송하지 않기 위한 잠금."""

import hashlib
import sqlite3


class ReservationJournal:
    def __init__(self, path: str):
        self.path = path
        with sqlite3.connect(path, timeout=10) as db:
            db.execute('CREATE TABLE IF NOT EXISTS attempted (event_key TEXT PRIMARY KEY, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')

    @staticmethod
    def key(account: str, room_id: str) -> str:
        return hashlib.sha256((account + '\0' + room_id).encode('utf8')).hexdigest()

    def begin(self, account: str, room_id: str) -> bool:
        """처음 시도만 True. 이 기록에는 계정명·대화상대·주소를 저장하지 않는다."""
        with sqlite3.connect(self.path, timeout=10) as db:
            cur = db.execute('INSERT OR IGNORE INTO attempted(event_key) VALUES (?)', (self.key(account, room_id),))
            return cur.rowcount == 1
