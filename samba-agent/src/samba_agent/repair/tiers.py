"""Claude API -> Codex SDK -> durable handoff to the chat monitor."""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from samba_agent.llm.auth import env_value
from samba_agent.repair.agent import RepairOutcome, ScriptRepairer
from samba_agent.repair.api import ACCOUNT, credentials


class TieredRepairer:
    def __init__(self, *, root: Path, timeout_s: float, claude_model: str):
        self.log_path = root / 'logs' / 'repair-tiers.jsonl'
        self.tiers = [
            ScriptRepairer(model=claude_model, timeout_s=timeout_s, api_provider='anthropic'),
            ScriptRepairer(
                model=env_value('SAMBA_REPAIR_CODEX_MODEL') or '',
                timeout_s=timeout_s,
                api_provider='codex_sdk',
            ),
        ]

    def record(self, stage, script, status, reason=''):
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open('a', encoding='utf-8') as stream:
            stream.write(
                json.dumps(
                    {
                        'at': datetime.now(timezone(timedelta(hours=9))).isoformat(),
                        'stage': stage,
                        'script': script,
                        'account_requested': ACCOUNT,
                        'status': status,
                        'reason': reason[:300],
                    },
                    ensure_ascii=False,
                )
                + '\n'
            )

    def repair(self, **kwargs):
        tests = 0
        for stage, tier in enumerate(self.tiers, 1):
            try:
                credentials(tier.api_provider)
            except RuntimeError:
                self.record(stage, kwargs['name'], 'credential_blocked')
                continue
            self.record(stage, kwargs['name'], 'started')
            try:
                outcome = tier.repair(**kwargs)
            except Exception:  # noqa: BLE001 — a failed provider must hand off to the next tier
                outcome = RepairOutcome('gave_up', 'repair tier raised an exception')
            tests += outcome.tests
            # Reasons can contain page data; log only fixed status labels.
            self.record(stage, kwargs['name'], outcome.status)
            if outcome.status in ('fixed', 'genuine'):
                outcome.tests = tests
                return outcome
        self.record(3, kwargs['name'], 'needs_review', '1/2차 미해결: 대화 감시에서 확인 필요')
        return RepairOutcome(
            'gave_up', '1차 Claude API·2차 Codex SDK 미해결 — 3차 확인 필요', tests=tests
        )


class TieredOperator:
    """Also escalate pre-payment blocked-job decisions through both APIs."""

    def __init__(self, *, root: Path, timeout_s: float, claude_model: str):
        from samba_agent.operator.agent import OperatorAgent

        self.audit = TieredRepairer(root=root, timeout_s=timeout_s, claude_model=claude_model)
        self.tiers = [
            OperatorAgent(model=t.model, timeout_s=timeout_s, api_provider=t.api_provider)
            for t in self.audit.tiers
        ]

    def judge(self, **kwargs):
        from samba_agent.operator.agent import Verdict

        for stage, tier in enumerate(self.tiers, 1):
            try:
                credentials(tier.api_provider)
            except RuntimeError:
                self.audit.record(stage, 'operator', 'credential_blocked')
                continue
            self.audit.record(stage, 'operator', 'started')
            verdict = tier.judge(**kwargs)
            self.audit.record(stage, 'operator', verdict.action)
            if verdict.action != 'human':
                return verdict
        self.audit.record(3, 'operator', 'needs_review')
        return Verdict('human', '1차 Claude API·2차 Codex SDK 미해결 — 3차 확인 필요')
