"""슬랙 봇(Socket Mode) — 지시 받기 · 진행 보고 · 승인 버튼(스펙 §4.1).

바깥 세계와 닿는 유일한 창구다. 등록되지 않은 사용자와 다른 채널은 조용히 무시한다
(답장조차 하지 않는다 — 스펙 §4.1).
"""

import logging
import re
from typing import TYPE_CHECKING

from samba_agent.gateway.commands import Command, parse_command
from samba_agent.ops.gate import record_approval
from samba_agent.ops.masking import mask_text
from samba_agent.queue.db import JobQueue
from samba_agent.queue.worker import Worker
from samba_agent.settings import Settings

if TYPE_CHECKING:
    from collections.abc import Callable

    from slack_bolt import App

    from samba_agent.queue.intake import Intake

log = logging.getLogger(__name__)

APPROVE_ACTION_ID = 'samba_approve'
REJECT_ACTION_ID = 'samba_reject'
# 슬랙 채널 id 모양(공개 C.../비공개 G...) — 이 모양이면 이름 풀이를 건너뛴다
_CHANNEL_ID_RE = re.compile(r'^[CG][A-Z0-9]{8,}$')


def approval_blocks(order_no: str, stage: str, summary: str) -> list[dict[str, object]]:
    """승인 요청 메시지. 버튼 값에 주문번호를 실어 누가 눌러도 어느 건인지 안다."""
    return [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': summary}},
        {
            'type': 'actions',
            'elements': [
                {
                    'type': 'button',
                    'action_id': APPROVE_ACTION_ID,
                    'style': 'primary',
                    'text': {'type': 'plain_text', 'text': '승인'},
                    'value': f'{order_no}|{stage}',
                },
                {
                    'type': 'button',
                    'action_id': REJECT_ACTION_ID,
                    'style': 'danger',
                    'text': {'type': 'plain_text', 'text': '거부'},
                    'value': f'{order_no}|{stage}',
                },
            ],
        },
    ]


class SambaBot:
    """명령 처리 알맹이. 슬랙 App 은 얇게 감싸기만 한다."""

    def __init__(
        self,
        app: 'App | None',
        worker: Worker,
        queue: JobQueue,
        settings: Settings,
        diagnose: 'Callable[[str | None], str]',
        *,
        channel_id: str | None = None,
        intake: 'Intake | None' = None,
    ) -> None:
        self.app = app
        self.worker = worker
        self.queue = queue
        self.settings = settings
        self.diagnose = diagnose
        # settings.slack_channel(id 또는 이름)을 채널 id 로 풀어둔 값. app 이 없는 테스트는
        # 여기로 직접 주입한다 — start() 는 이게 비어 있을 때만 conversations.list 로 풀어본다.
        self._channel_id = channel_id
        # 자동 수집 고리. 배선되지 않았으면(삼바웨이브 설정 없음) 수집 명령은 안내만 한다
        self.intake = intake

    def post(
        self, thread_ts: str | None, text: str, blocks: list[dict[str, object]] | None = None
    ) -> bool:
        """스레드에 한 줄 남긴다. 보냈으면 True, 슬랙이 없거나 채널을 못 풀었으면 False.

        채널은 설정의 이름이 아니라 시작 시 풀어둔 채널 id 로 보낸다(리뷰 지적 — Minor).
        개인정보는 슬랙에 닿기 전에 여기서 마지막으로 한 번 더 가린다.
        """
        if self.app is None or self._channel_id is None or thread_ts is None:
            return False
        kwargs: dict[str, object] = {
            'channel': self._channel_id,
            'thread_ts': thread_ts,
            'text': mask_text(text),
        }
        if blocks is not None:
            kwargs['blocks'] = blocks
        self.app.client.chat_postMessage(**kwargs)
        return True

    def post_new(self, text: str) -> str | None:
        """스레드가 아닌 최상위 메시지를 올리고 그 ts 를 준다. 자동 수집이 주문 스레드를 여는 통로다.

        슬랙이 없거나 채널을 못 풀었으면 None — 부르는 쪽은 스레드 없이 큐에만 넣는다.
        슬랙 오류로 수집 고리가 죽으면 안 되므로 여기서 삼킨다(개인정보는 마스킹을 한 번 더 거친다).
        """
        if self.app is None or self._channel_id is None:
            return None
        try:
            resp = self.app.client.chat_postMessage(channel=self._channel_id, text=mask_text(text))
        except Exception:  # 슬랙 장애가 수집을 멈추게 하지 않는다
            log.exception('최상위 메시지 게시 실패')
            return None
        ts = resp.get('ts') if hasattr(resp, 'get') else None
        return str(ts) if ts else None

    def post_approval(self, thread_ts: str | None, order_no: str, stage: str, summary: str) -> bool:
        """승인 요청을 버튼과 함께 보낸다(리뷰 지적 — Critical 1).

        버튼이 없으면 사람이 승인할 방법이 없어 결제·기록 단계가 영구 정지한다.
        """
        safe = mask_text(summary)
        return self.post(thread_ts, f'승인 요청\n{safe}', approval_blocks(order_no, stage, safe))

    def _allowed(self, user: str) -> bool:
        """등록부가 비어 있으면 아무도 못 시킨다 — 실수로 열려 있는 걸 막는다."""
        return user in self.settings.slack_allowed_users

    def is_target_channel(self, channel_id: str) -> bool:
        """이 채널이 봇이 응답할 채널인가 — 순수 메서드라 슬랙 없이 테스트한다.

        채널을 아직 못 풀었으면(운영에서 conversations.list 가 실패한 경우 등) 안전하게
        모든 채널을 거부한다 — "다른 채널은 무시" 가 전역 제약이라, 모르면 응답하지 않는 쪽이 맞다.
        """
        if self._channel_id is None:
            return False
        return channel_id == self._channel_id

    def resolve_channel(self) -> None:
        """`settings.slack_channel`(id 또는 이름) → 채널 id. 시작 시 한 번만 부른다.

        이미 id 모양이면 그대로 쓰고, 이름이면 conversations.list 로 찾는다.
        `app` 이 없으면(테스트) 아무것도 하지 않는다 — 그런 자리는 생성자의 channel_id 로 주입한다.
        """
        name = self.settings.slack_channel.lstrip('#')
        if _CHANNEL_ID_RE.match(name):
            self._channel_id = name
            return
        if self.app is None:
            return
        cursor: str | None = None
        while True:
            resp = self.app.client.conversations_list(
                types='public_channel,private_channel', cursor=cursor, limit=200
            )
            for ch in resp.get('channels', []):
                if ch.get('name') == name:
                    self._channel_id = ch['id']
                    return
            cursor = (resp.get('response_metadata') or {}).get('next_cursor')
            if not cursor:
                break
        log.warning('대상 채널을 찾지 못했다: %s', name)

    def handle_mention(self, text: str, user: str, thread_ts: str | None) -> str | None:
        """멘션 1건. 답할 말이 없으면 None(봇이 조용히 넘어간다)."""
        if not self._allowed(user):
            log.info('미등록 사용자 명령 무시: %s', user)
            return None
        cmd = parse_command(text)
        answer = self._dispatch(cmd, user, thread_ts)
        # 진행 보고·진단 문구에는 고객 개인정보가 섞일 수 있어 슬랙에 나가기 전에 마지막으로 한 번 더 가린다
        return mask_text(answer) if answer is not None else None

    def _dispatch(self, cmd: Command, user: str, thread_ts: str | None) -> str | None:
        if cmd.kind == 'process' and cmd.order_no:
            job, created = self.queue.enqueue(cmd.order_no, user, dict(cmd.options), thread_ts)
            if not created:
                where = f'{job.assignee_agent or "대기"} · {job.step or job.state}'
                return f'이미 <@{job.requester}>님이 처리 중입니다({where})'
            return f'접수했습니다: {cmd.order_no}' + (
                f' (카드 {cmd.options["card"]})' if cmd.options.get('card') else ''
            )
        if cmd.kind == 'status':
            live = self.queue.live()
            if not live:
                return '지금 도는 주문이 없습니다'
            # 같은 상품주문번호의 행이 여럿일 수 있어 행 id(ord_…)도 보인다 — `취소 ord_…` 처럼 그 행만 가리킨다
            return '\n'.join(
                f'{j.order_no}{f" ({j.wave_id})" if j.wave_id else ""} · {j.state} · '
                f'{j.assignee_agent or "-"} · {j.step or "-"}'
                for j in live
            )
        if cmd.kind == 'cancel' and cmd.order_no:
            job = self.queue.cancel(cmd.order_no)
            return (
                f'{cmd.order_no} 취소했습니다' if job else f'{cmd.order_no} 는 취소할 게 없습니다'
            )
        if cmd.kind == 'resume' and cmd.order_no:
            job = self.queue.get(cmd.order_no)
            if job is None:
                return f'{cmd.order_no} 는 없는 주문입니다'
            try:
                self.queue.retry(job.id)
            except ValueError as e:
                return str(e)
            return f'{cmd.order_no} 를 다시 큐에 넣었습니다'
        if cmd.kind in ('intake_now', 'intake_pause', 'intake_resume'):
            return self._dispatch_intake(cmd.kind)
        if cmd.kind == 'diagnose':
            return self.diagnose(cmd.order_no)
        if cmd.kind == 'version':
            # WorkerDeps.version 이 콜러블로 바뀌었다(Task 16 리뷰 지적) — 매번 불러 최신 버전을 보여준다
            return f'하네스 버전 {self.worker.d.version()} · 환경 {self.settings.harness_env}'
        if cmd.kind == 'approve' and cmd.version:
            # 버전 승격 승인은 ops.gate 가 읽는 승인 파일로 남긴다(리뷰 지적 — I8)
            try:
                path = record_approval(self.settings.report_dir, cmd.version, user)
            except (ValueError, OSError) as e:
                log.warning('승인 기록 실패: %s', e)
                return f'버전 {cmd.version} 승인을 기록하지 못했습니다'
            return f'버전 {cmd.version} 승인을 기록했습니다({path.name})'
        return None

    def _dispatch_intake(self, kind: str) -> str:
        """자동 수집 명령 셋 — 지금 수집 · 중지 · 재개."""
        if self.intake is None:
            return '자동 수집이 꺼져 있습니다(삼바웨이브 설정 없음)'
        if kind == 'intake_pause':
            self.intake.pause()
            return '자동 수집을 중지했습니다'
        if kind == 'intake_resume':
            self.intake.resume()
            return '자동 수집을 재개했습니다'
        return self.intake.run_once().as_line()

    def handle_approval(
        self, order_no: str, approved: bool, user: str, stage: str | None = None
    ) -> str:
        """승인·거부 버튼. 누른 사람도 등록돼 있어야 하고, 같은 버튼 두 번은 한 번만 먹는다.

        ``order_no`` 는 버튼 value 의 작업 키 — 자동 수집 작업은 삼바웨이브 행 id(ord_…), 수동 접수는 주문번호.

        ``stage`` 는 버튼 value 에 실어온 단계(pay/record) — 지금 큐가 그 단계의 승인 대기가
        아니면(이미 처리됐거나 다음 단계로 넘어갔으면) 그래프를 다시 부르지 않고 안내만 한다
        (스펙 리뷰 지적 — Critical 2).
        """
        if not self._allowed(user):
            log.info('미등록 사용자 승인 무시: %s', user)
            return '권한이 없습니다'
        pending = self.queue.get(order_no)
        if pending is None or pending.state != 'needs_human':
            return f'{order_no} 는 승인 대기 상태가 아닙니다'
        if stage is not None and pending.step != f'승인 대기: {stage}':
            return '이미 처리된 승인입니다'
        job = self.worker.resume(order_no, approved=approved, by=user, stage=stage)
        if job is None:
            return '이미 처리된 승인입니다'
        order_no = job.order_no  # 답은 사람이 아는 상품주문번호로
        answer = (
            f'<@{user}>님이 {order_no} 를 승인했습니다 → {job.state}'
            if approved
            else f'<@{user}>님이 {order_no} 를 거부했습니다 → {job.state}'
        )
        return mask_text(answer)

    @staticmethod
    def _split_value(value: str) -> tuple[str, str | None]:
        """승인 버튼 value(`order_no|stage`) → (order_no, stage)."""
        order_no, _, stage = value.partition('|')
        return order_no, (stage or None)

    def start(self) -> None:
        """Socket Mode 로 슬랙에 붙는다. 검토 전에는 테스트 채널만 쓴다(스펙 §7 ④)."""
        from slack_bolt.adapter.socket_mode import SocketModeHandler

        self.resolve_channel()

        @self.app.event('app_mention')
        def _on_mention(event, say):  # type: ignore[no-untyped-def]
            if not self.is_target_channel(event.get('channel', '')):
                log.info('다른 채널의 멘션 무시: %s', event.get('channel'))
                return
            answer = self.handle_mention(
                event.get('text', ''),
                event.get('user', ''),
                event.get('thread_ts') or event.get('ts'),
            )
            if answer:
                say(text=answer, thread_ts=event.get('thread_ts') or event.get('ts'))

        @self.app.action(APPROVE_ACTION_ID)
        def _on_approve(ack, body, say):  # type: ignore[no-untyped-def]
            # ack() 는 3초 안에 슬랙에 응답만 보낸다 — 뒤이은 처리는 동기라, 워커가 하나뿐이라
            # 이미 다른 건을 돌리고 있으면 이 승인의 실제 반영(say)이 그만큼 늦어질 수 있다.
            ack()
            order_no, stage = self._split_value(str(body['actions'][0]['value']))
            say(
                text=self.handle_approval(order_no, True, body['user']['id'], stage=stage),
                thread_ts=body['message'].get('thread_ts') or body['message']['ts'],
            )

        @self.app.action(REJECT_ACTION_ID)
        def _on_reject(ack, body, say):  # type: ignore[no-untyped-def]
            # 위 승인과 같은 이유로 ack() 뒤 동기 처리가 단일 워커 지연에 걸릴 수 있다.
            ack()
            order_no, stage = self._split_value(str(body['actions'][0]['value']))
            say(
                text=self.handle_approval(order_no, False, body['user']['id'], stage=stage),
                thread_ts=body['message'].get('thread_ts') or body['message']['ts'],
            )

        # 토큰은 여기서 값으로 한 번만 풀리고 로그로 나가지 않는다(비밀은 SecretStr 로만 들고 다닌다)
        token = self.settings.slack_app_token
        SocketModeHandler(self.app, token.get_secret_value() if token else '').start()
