"""사무실 확인 대기 중에는 명시한 새 선물 주문만 처리한다."""

import json
import sqlite3
from pathlib import Path


def load_office_scope(db_path: Path, scope_path: Path) -> frozenset[int] | None:
    with sqlite3.connect(db_path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        guarded = bool(db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN "
            "('office_conflict_claim_guard','office_conflict_payment_guard') LIMIT 1"
        ).fetchone())
    if not scope_path.exists():
        return frozenset() if guarded else None
    data = json.loads(scope_path.read_text(encoding='utf-8-sig'))
    ids = data.get('allowed_job_ids')
    if (data.get('owner') != 'office-conflict-20261103'
            or data.get('allowed_order_type') != 'gift'
            or not isinstance(ids, list) or not 1 <= len(ids) <= 20
            or any(type(i) is not int or i <= 0 for i in ids)):
        raise ValueError('사무실 안전 처리 범위가 올바르지 않다 — 신규 주문 시작 중지')
    return frozenset(ids)
