import json

import httpx
import pytest

from samba_agent.repair.agent import RepairOutcome, ScriptRepairer
from samba_agent.repair.tiers import TieredRepairer


def request_args(call):
    return {
        'call': call,
        'name': 'snapshot',
        'args': {},
        'goal': 'read current price',
        'problem': 'missing value',
        'last_output': '',
        'current': None,
        'validate': lambda out: None if out.get('price') == 42 else 'wrong price',
    }


@pytest.mark.parametrize('provider', ['anthropic', 'openai'])
def test_api_uses_guard_and_real_validator(monkeypatch, provider):
    monkeypatch.setattr('samba_agent.repair.api.credentials', lambda p: ('test-key', 'workspace'))
    actions = [
        ('run_js', {'code': 'return page.clickText("결제하기")'}),
        ('test_script', {'code': 'return {price:1}'}),
        ('test_script', {'code': 'return {price:42}'}),
    ]
    seen = []

    async def post(self, url, *, headers, json):
        __import__('json').dumps(json)  # Actual HTTP encoding must accept the tool schemas.
        seen.append(json)
        name, args = actions[len(seen) - 1]
        block = {'type': 'tool_use', 'id': str(len(seen)), 'name': name, 'input': args}
        if provider == 'openai':
            block = {
                'type': 'function_call',
                'call_id': str(len(seen)),
                'name': name,
                'arguments': __import__('json').dumps(args),
            }
        return httpx.Response(
            200, json={'content' if provider == 'anthropic' else 'output': [block]}
        )

    monkeypatch.setattr(httpx.AsyncClient, 'post', post)
    calls = []

    def bridge(tool, args):
        calls.append(args)
        return '{"price":42}' if '42' in args['code'] else '{"price":1}'

    outcome = ScriptRepairer(api_provider=provider, max_turns=4).repair(**request_args(bridge))
    assert outcome.status == 'fixed'
    assert outcome.tests == 2
    assert len(calls) == 2  # Payment click rejected before reaching the bridge.
    assert all(c['safety'] == 'no_pay' for c in calls)
    assert outcome.output == {'price': 42}


def test_failed_claude_hands_off_to_codex(monkeypatch, tmp_path):
    monkeypatch.setattr('samba_agent.repair.tiers.credentials', lambda p: ('key', ''))
    chain = TieredRepairer(root=tmp_path, timeout_s=60, claude_model='test')
    seen = []

    class Tier:
        def __init__(self, provider, result):
            self.api_provider, self.result = provider, result

        def repair(self, **kwargs):
            seen.append(self.api_provider)
            return self.result

    chain.tiers = [
        Tier('anthropic', RepairOutcome('gave_up', 'auth', tests=1)),
        Tier('openai', RepairOutcome('fixed', 'passed', {'price': 42}, 'code', 2)),
    ]
    assert chain.repair(**request_args(None)).tests == 3
    assert seen == ['anthropic', 'openai']
    events = [json.loads(x) for x in chain.log_path.read_text(encoding='utf8').splitlines()]
    assert [e['status'] for e in events] == ['started', 'gave_up', 'started', 'fixed']


def test_missing_keys_escalates_without_browser_or_false_success(monkeypatch, tmp_path):
    def unavailable(p):
        raise RuntimeError('missing')

    monkeypatch.setattr('samba_agent.repair.tiers.credentials', unavailable)
    chain = TieredRepairer(root=tmp_path, timeout_s=60, claude_model='test')
    result = chain.repair(**request_args(lambda *a: pytest.fail('must not use browser')))
    assert result.status == 'gave_up'
    assert result.tests == 0
    events = [json.loads(x) for x in chain.log_path.read_text(encoding='utf8').splitlines()]
    assert [e['status'] for e in events] == [
        'credential_blocked',
        'credential_blocked',
        'needs_review',
    ]


@pytest.mark.parametrize('email', ['sbk0674@gmail.com', 'wrong@example.com'])
def test_sdk_login_and_guarded_repair(monkeypatch, email):
    from types import SimpleNamespace

    actions = [
        {
            'tool': 'run_js',
            'arguments': {'code': 'return page.clickText("결제하기")', 'reason': None},
        },
        {'tool': 'test_script', 'arguments': {'code': 'return {price:42}', 'reason': None}},
    ]

    class Client:
        def __init__(self, config):
            assert 'features.shell_tool=false' in config.config_overrides
            assert 'features.hooks=false' in config.config_overrides

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def account(self):
            return SimpleNamespace(
                model_dump=lambda **k: {'account': {'email': email, 'type': 'chatgpt'}}
            )

        async def thread_start(self, **kwargs):
            assert kwargs['sandbox'].value == 'read-only'
            return self

        async def run(self, prompt, **kwargs):
            return SimpleNamespace(final_response=json.dumps(actions.pop(0)))

    monkeypatch.setattr('samba_agent.repair.codex_sdk.AsyncCodex', Client)
    seen = []

    def bridge(tool, args):
        seen.append(args)
        return '{"price":42}'

    result = ScriptRepairer(api_provider='codex_sdk', model='test').repair(**request_args(bridge))
    if email.startswith('wrong'):
        assert result.status == 'gave_up'
        assert not seen
    else:
        assert result.status == 'fixed'
        assert result.tests == 1
        assert len(seen) == 1
        assert seen[0]['safety'] == 'no_pay'
