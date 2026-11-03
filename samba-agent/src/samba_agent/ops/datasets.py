"""평가 데이터셋 — 에이전트별 입력 스냅샷 + 기대 출력(스펙 §4.5 2단계).

성공만 모으지 않는다. 품절·마진·카드 없음·캡차·중복·권한 부족·브릿지 끊김은
"기대 = 올바른 거절/넘김" 으로 들어간다.
"""

import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from langsmith.utils import LangSmithAuthError, LangSmithNotFoundError

log = logging.getLogger(__name__)

MIN_EXAMPLES = 10
REQUIRED_TAGS = ('success', 'failure')
SEED_DIR = 'datasets'

# 온라인 평가/검수 큐 연결 지점(스펙 §4.5 온라인 평가) — Step 7
ONLINE_EVALUATOR_NAME = 'samba.online.safety'
REVIEW_QUEUE_NAME = 'samba-review'


@dataclass(frozen=True)
class Example:
    """데이터셋 한 줄."""

    name: str
    inputs: dict[str, object]
    outputs: dict[str, object]
    tags: tuple[str, ...]


def load_seed(root: Path, name: str) -> list[Example]:
    """`datasets/<name>.jsonl` 을 읽는다."""
    path = root / SEED_DIR / f'{name}.jsonl'
    out: list[Example] = []
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        outputs = dict(row['outputs'])
        if outputs.get('status') == 'needs_human':
            outputs['status'] = 'needs_ai'
        out.append(
            Example(
                name=name,
                inputs=row['inputs'],
                outputs=outputs,
                tags=tuple(row.get('tags', ())),
            )
        )
    return out


def seed_counts(root: Path) -> dict[str, int]:
    """이름 → 건수. 완료 조건 검사에 쓴다."""
    d = root / SEED_DIR
    return {p.stem: len(load_seed(root, p.stem)) for p in sorted(d.glob('*.jsonl'))}


def push_to_langsmith(examples: Sequence[Example], *, client: object | None = None) -> int:
    """LangSmith 데이터셋에 올린다. 키가 없으면 0 건(경고만 하고 넘어간다).

    Task 12 의 데이터 항목 검토가 끝난 뒤에만 실제로 실행한다(스펙 §10-1).
    테스트는 항상 가짜 client 를 주입해서 돈다 — 실제 LangSmith 로는 아무것도 보내지 않는다.
    """
    if client is None:
        try:
            from langsmith import Client

            client = Client()
        except ImportError:
            log.warning('langsmith 패키지가 없다 — push_to_langsmith 는 0 건')
            return 0
        except LangSmithAuthError as e:
            log.warning('LangSmith 인증 실패 — push_to_langsmith 는 0 건: %s', e)
            return 0
    count = 0
    for name in sorted({e.name for e in examples}):
        rows = [e for e in examples if e.name == name]
        ds = (
            client.create_dataset(name)
            if not _has(client, name)
            else client.read_dataset(dataset_name=name)
        )
        client.create_examples(
            inputs=[r.inputs for r in rows],
            outputs=[r.outputs for r in rows],
            metadata=[{'tags': list(r.tags)} for r in rows],
            dataset_id=ds.id,
        )
        count += len(rows)
    return count


def _has(client: object, name: str) -> bool:
    """데이터셋이 이미 있는가. "없다" 는 신호(LangSmithNotFoundError, 가짜 client 는 ValueError)만
    False 로 본다. 그 외 예외(자격 오류·시그니처 불일치 등)는 "없다"로 조용히 넘기면 안 된다 —
    원인을 로그에 남기고 그대로 던진다.
    """
    try:
        client.read_dataset(dataset_name=name)  # type: ignore[attr-defined]
        return True
    except (LangSmithNotFoundError, ValueError):
        return False
    except LangSmithAuthError as e:
        log.warning('LangSmith 인증 실패 — 데이터셋 존재 확인 불가: %s', e)
        raise


def ensure_online_evaluator(*, client: object | None = None) -> int:
    """samba-prod trace 를 실행마다 자동 채점하고 실패는 검수 큐로 보낸다(스펙 §4.5 온라인 평가).

    LangSmith 의 Rules/Online evaluators 설정을 만든다. 이미 있으면 그대로 두고 0 을 돌려준다.
    LangSmith 키가 없으면(client 도 없으면) 아무것도 부르지 않고 0 을 돌려준다 — 이 함수는
    Task 16 에서 SambaBot 진입점이 실제로 부르기 전까지는 연결 지점(서명)만 제공한다.
    """
    if client is None:
        try:
            from langsmith import Client

            client = Client()
        except ImportError:
            log.warning('langsmith 패키지가 없다 — ensure_online_evaluator 는 0 건')
            return 0
        except LangSmithAuthError as e:
            log.warning('LangSmith 인증 실패 — ensure_online_evaluator 는 0 건: %s', e)
            return 0
    creator = getattr(client, 'ensure_online_evaluator', None)
    if creator is None:
        return 0
    try:
        already = bool(creator(name=ONLINE_EVALUATOR_NAME, review_queue=REVIEW_QUEUE_NAME))
    except LangSmithAuthError as e:
        log.warning('LangSmith 인증 실패 — ensure_online_evaluator 는 0 건: %s', e)
        return 0
    except Exception as e:
        log.warning('온라인 채점기 연결 중 예상 밖 오류: %s', e)
        raise
    return 0 if already else 1


def pull_reviewed_examples(*, client: object | None = None) -> list[Example]:
    """검수 큐에서 사람이 고친 답을 데이터셋 예시로 가져온다(예시 공급 (b)).

    키가 없으면 빈 목록을 돌려준다. 데이터 항목 검토(Task 12) 전에는 이 값을
    `push_to_langsmith` 로 올리지 않는다(스펙 §10-1).
    """
    if client is None:
        try:
            from langsmith import Client

            client = Client()
        except ImportError:
            log.warning('langsmith 패키지가 없다 — pull_reviewed_examples 는 빈 목록')
            return []
        except LangSmithAuthError as e:
            log.warning('LangSmith 인증 실패 — pull_reviewed_examples 는 빈 목록: %s', e)
            return []
    getter = getattr(client, 'list_reviewed_examples', None)
    if getter is None:
        return []
    try:
        rows = list(getter(queue_name=REVIEW_QUEUE_NAME))
    except LangSmithAuthError as e:
        log.warning('LangSmith 인증 실패 — pull_reviewed_examples 는 빈 목록: %s', e)
        return []
    except Exception as e:
        log.warning('검수 큐 조회 중 예상 밖 오류: %s', e)
        raise
    out: list[Example] = []
    for row in rows:
        out.append(
            Example(
                name=str(row.get('dataset', '')),
                inputs=dict(row.get('inputs', {})),
                outputs=dict(row.get('outputs', {})),
                tags=tuple(row.get('tags', ())) or ('reviewed',),
            )
        )
    return out
