"""하네스 읽기 API — 앱의 자동화 페이지(플랜 3/3)가 5초마다 읽는다(스펙 §4.4b).

127.0.0.1 에만 뜬다. 브릿지와 반대 방향(앱 → 하네스)이라 토큰은 쓰지 않는다.
쓰기는 규칙 파일 수정 하나뿐이고, 고치면 새 harness_version 이 된다.
"""

import json
import os
import tempfile
import urllib.parse
from collections.abc import Callable
from pathlib import Path

from werkzeug.wrappers import Request, Response

from samba_agent.agents.registry import Registry
from samba_agent.ops.releases import ReleaseStore
from samba_agent.queue.db import JobQueue
from samba_agent.supervisor.policy import STAGES

DEFAULT_PORT = 47812
MAX_RULES_BODY = 256 * 1024  # 256KB — 규칙 파일 PUT 본문 상한(리뷰 지적 — Important 2)


def build_app(
    *,
    reg: Registry,
    queue: JobQueue,
    releases: ReleaseStore,
    root: Path,
    version: Callable[[], str],
    report_dir: Path | None = None,
    approve: Callable[[str, bool, str, str | None], object] | None = None,
) -> Callable:
    """WSGI 앱. 라우팅이 몇 개뿐이라 프레임워크를 들이지 않는다.

    approve 는 승인 대기 중인 주문을 깨우는 콜러블(worker.resume) — 슬랙이 없을 때 사람이 승인/거절을
    넣는 유일한 경로다(POST /approve). 127.0.0.1 에서만 받는다.
    """
    # 판정 산출물 위치는 gate·eval 과 같은 설정 하나로 정해진다(리뷰 지적 — I4)
    reports = report_dir if report_dir is not None else root / 'ops' / 'reports'

    def app(environ, start_response):  # type: ignore[no-untyped-def]
        req = Request(environ)
        path = req.path
        if req.method == 'GET' and path == '/graph':
            resp = _get_graph(reg, version)
        elif req.method == 'GET' and path == '/jobs':
            resp = _get_jobs(queue)
        elif req.method == 'GET' and path == '/releases':
            resp = _get_releases(releases, version, reports)
        elif req.method == 'GET' and path.startswith('/graph/rules/'):
            resp = _get_rules(reg, root, version, path[len('/graph/rules/') :])
        elif req.method == 'PUT' and path.startswith('/graph/rules/'):
            resp = _put_rules(reg, root, version, path[len('/graph/rules/') :], req)
        elif req.method == 'POST' and path == '/approve':
            resp = _post_approve(approve, req)
        else:
            resp = _json({'error': 'not found'}, 404)
        return resp(environ, start_response)

    return app


def _get_graph(reg: Registry, version: Callable[[], str]) -> Response:
    return _json(
        {
            'version': version(),
            'stages': list(STAGES),
            'agents': [
                {
                    'name': s.name,
                    'kind': s.kind,
                    'match': s.match,
                    'tools': list(s.tools),
                    'rules': s.rules,
                    'retry': s.retry,
                }
                for s in [reg[n] for n in reg.names()]
            ],
        }
    )


def _get_jobs(queue: JobQueue) -> Response:
    return _json(
        {
            'jobs': [
                {
                    'order_no': j.order_no,
                    'wave_id': j.wave_id,
                    'state': j.state,
                    'assignee_agent': j.assignee_agent,
                    'step': j.step,
                    'requester': j.requester,
                    'harness_version': j.harness_version,
                    'attempts': j.attempts,
                    'updated_at': j.updated_at,
                }
                for j in queue.live()
            ]
        }
    )


def _get_releases(releases: ReleaseStore, version: Callable[[], str], reports: Path) -> Response:
    current = releases.current_prod()
    return _json(
        {
            'current': current.__dict__ if current else None,
            'history': [r.__dict__ for r in releases.history()],
            'candidate': _candidate(reports, version()),
        }
    )


def _resolve_rules_path(
    reg: Registry, root: Path, name: str
) -> tuple[Path, str, None] | tuple[None, None, Response]:
    """이름 → 규칙 파일 경로. PUT/GET 이 같은 검사를 쓴다(경로 이탈·미등록 에이전트).

    이름은 URL 경로 조각이라 퍼센트 인코딩된 채로 올 수 있다(리뷰 지적 — Important 3).
    디코딩 전 원문에서 먼저 걸러내고, 디코딩한 뒤 한 번 더 같은 검사를 한다 —
    이중 인코딩(``%252f`` 등)으로 첫 검사를 피해 가는 경우를 잡기 위해서다.
    """
    if '/' in name or '..' in name or '%2f' in name.lower():
        return None, None, _json({'error': 'bad name'}, 400)
    name = urllib.parse.unquote(name)
    if '/' in name or '..' in name:
        return None, None, _json({'error': 'bad name'}, 400)
    try:
        spec = reg[name]
    except KeyError:
        return None, None, _json({'error': f'unknown agent: {name}'}, 404)
    rules_path = (root / spec.rules).resolve()
    # 등록부 경로 자체가 탈출하지 않는 한 여기까지 오지만, 한 번 더 root 밖으로
    # 안 나가는지 확인한다(스펙 §10-3 — 실패 케이스는 항상 한 번 더 검사한다)
    if root.resolve() not in rules_path.parents and rules_path != root.resolve():
        return None, None, _json({'error': 'bad path'}, 400)
    return rules_path, name, None


def _get_rules(reg: Registry, root: Path, version: Callable[[], str], name: str) -> Response:
    """규칙 파일 원문. 앱의 편집 모달이 고치기 전에 현재 내용을 받는다(플랜 3/3)."""
    rules_path, name, err = _resolve_rules_path(reg, root, name)
    if err is not None:
        return err
    assert rules_path is not None
    try:
        text = rules_path.read_text(encoding='utf-8')
    except OSError:
        # 등록부에는 있지만 파일이 없거나(지워짐) 읽을 수 없다 — 500 대신 404 로
        # 돌려줘야 화면이 "저장하지 못했다"가 아니라 "불러오지 못했다"로 구분한다
        return _json({'error': f'rules file not found: {name}'}, 404)
    except UnicodeDecodeError:
        return _json({'error': 'rules file is not utf-8'}, 400)
    return _json({'agent': name, 'text': text, 'version': version()})


def _put_rules(
    reg: Registry, root: Path, version: Callable[[], str], name: str, req: Request
) -> Response:
    """규칙 파일 수정. 고치면 새 버전이 되어 판정 시스템을 다시 통과해야 한다."""
    rules_path, name, err = _resolve_rules_path(reg, root, name)
    if err is not None:
        return err
    assert rules_path is not None
    # content-length 로 먼저 거른다(스트림 다 읽기 전에 413 — 리뷰 지적 — Important 2).
    # 헤더가 없거나 거짓이어도 아래에서 실제 바이트 길이로 다시 확인한다.
    if (req.content_length or 0) > MAX_RULES_BODY:
        return _json({'error': 'payload too large'}, 413)
    raw = req.get_data(as_text=False)
    if len(raw) > MAX_RULES_BODY:
        return _json({'error': 'payload too large'}, 413)
    try:
        body = json.loads(raw.decode('utf-8') or '{}')
    except ValueError:
        return _json({'error': 'bad json'}, 400)
    if not isinstance(body, dict):
        return _json({'error': 'bad json'}, 400)
    text = str(body.get('text', ''))
    if not text.strip():
        return _json({'error': 'empty rules'}, 400)
    try:
        _atomic_write(rules_path, text)
    except OSError as e:
        return _json({'error': f'could not write rules file: {e}'}, 500)
    return _json({'ok': True, 'version': version()})


def _atomic_write(path: Path, text: str) -> None:
    """임시 파일에 쓰고 ``os.replace`` 로 갈아치운다(리뷰 지적 — Important 3).

    중간에 죽어도 원본 규칙 파일이 반쯤 쓰인 채로 남지 않는다. 디스크가 꽉 찼거나
    권한이 없어 ``OSError`` 가 나면 호출부가 500 JSON 으로 돌려준다(HTML 스택트레이스 대신).
    """
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def _candidate(reports: Path, version: str) -> dict[str, object] | None:
    """후보 버전의 판정 요약. 아직 판정 파일이 없으면 None.

    경로는 호출부가 설정(SAMBA_REPORT_DIR, 기본 root/ops/reports)에서 받아 넘긴다 —
    gate·eval 과 같은 폴더여야 판정 파일을 찾는다(리뷰 지적 — I4·Minor 5).
    """
    path = reports / f'{version}.md'
    if not path.exists():
        return None
    return {'version': version, 'report': path.read_text(encoding='utf-8')}


def _post_approve(
    approve: Callable[[str, bool, str, str | None], object] | None, req: Request
) -> Response:
    """승인/거절 — 본문 {"order_no", "approved": true|false, "by", "stage"(선택)}.

    슬랙 승인 버튼과 같은 일을 한다(worker.resume). 대기 중이 아니거나 이미 다른 단계면 409.
    """
    if approve is None:
        return _json({'error': 'approval channel not wired'}, 503)
    try:
        body = json.loads(req.get_data(as_text=True) or '{}')
    except ValueError:
        return _json({'error': 'invalid json'}, 400)
    if not isinstance(body, dict):
        return _json({'error': 'invalid body'}, 400)
    order_no = str(body.get('order_no') or '').strip()
    by = str(body.get('by') or '').strip()
    approved = body.get('approved')
    stage = body.get('stage')
    if not order_no or not by or not isinstance(approved, bool):
        return _json({'error': 'order_no, approved(bool), by are required'}, 400)
    job = approve(order_no, approved, by, str(stage) if stage else None)
    if job is None:
        return _json({'error': 'not waiting for approval', 'order_no': order_no}, 409)
    state = getattr(job, 'state', None)
    return _json({'ok': True, 'order_no': order_no, 'approved': approved, 'state': state})


def _json(body: object, status: int = 200) -> Response:
    return Response(
        json.dumps(body, ensure_ascii=False, default=str),
        status=status,
        content_type='application/json; charset=utf-8',
    )


def serve(app: Callable, host: str = '127.0.0.1', port: int = DEFAULT_PORT) -> None:
    """WSGI 서버를 띄운다. 127.0.0.1 만 바인딩한다(스펙 §4.4b — 외부 인터페이스 금지)."""
    from werkzeug.serving import make_server

    make_server(host, port, app).serve_forever()
