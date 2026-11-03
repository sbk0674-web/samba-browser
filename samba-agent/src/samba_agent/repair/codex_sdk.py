"""Codex SDK proposes actions; only the harness's guarded tools execute them."""

import json
import os
import re
import tempfile
import tomllib
from pathlib import Path

from openai_codex import ApprovalMode, AsyncCodex, CodexConfig, Sandbox

from samba_agent.repair.api import ACCOUNT, tool_schema


def sdk_config(cwd: str) -> CodexConfig:
    overrides = [
        'features.shell_tool=false',
        'features.apps=false',
        'features.plugins=false',
        'features.hooks=false',
        'features.multi_agent=false',
        'agents.enabled=false',
        'features.memories=false',
        'features.remote_plugin=false',
        'web_search="disabled"',
        'project_doc_max_bytes=0',
    ]
    # Do not inherit user-configured MCP services (they may write to external apps).
    home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    config = home / 'config.toml'
    if config.exists():
        data = tomllib.loads(config.read_text(encoding='utf-8-sig'))
        for name in data.get('mcp_servers', {}):
            if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
                raise RuntimeError('Unsupported MCP server name; refuse inherited tools')
            overrides.append(f'mcp_servers.{name}.enabled=false')
    # No application secrets are handed to the SDK process. It uses its own saved login.
    env = {
        k: v
        for k, v in os.environ.items()
        if not any(x in k.upper() for x in ('TOKEN', 'SECRET', 'API_KEY'))
    }
    return CodexConfig(cwd=cwd, env=env, config_overrides=tuple(overrides))


async def run_sdk_loop(model, prompt, system, tools, max_turns, finished):
    handlers = {t.name: t.handler for t in tools}
    properties = {
        name: {'type': ['string', 'null']} for t in tools for name in tool_schema(t)['properties']
    }
    schema = {
        'type': 'object',
        'properties': {
            'tool': {'type': 'string', 'enum': [*handlers, 'done']},
            'arguments': {
                'type': 'object',
                'properties': properties,
                'required': list(properties),
                'additionalProperties': False,
            },
        },
        'required': ['tool', 'arguments'],
        'additionalProperties': False,
    }
    tool_info = [
        {'name': t.name, 'description': t.description, 'schema': tool_schema(t)} for t in tools
    ]
    instructions = (
        system + '\nReturn only the next tool request as JSON. arguments is an object; '
        'set unused fields to null. Use only the listed tools. Native tools, file '
        'access and commands are forbidden. Harness executes the tools and grades '
        'the result. A claim of success without a passing test is never success.\n'
        + json.dumps(tool_info, ensure_ascii=False)
    )
    with tempfile.TemporaryDirectory(prefix='samba-codex-repair-') as cwd:
        async with AsyncCodex(sdk_config(cwd)) as codex:
            account = (await codex.account()).model_dump(mode='json').get('account') or {}
            if account.get('email', '').casefold() != ACCOUNT or account.get('type') != 'chatgpt':
                raise RuntimeError('Codex SDK requested account login missing')
            if not model:
                models = (await codex.models()).model_dump(mode='json').get('data', [])
                model = next((m['model'] for m in models if m.get('is_default')), '')
                if not model:
                    raise RuntimeError('Codex SDK did not return an available default model')
            thread = await codex.thread_start(
                model=model or None,
                cwd=cwd,
                ephemeral=True,
                sandbox=Sandbox.read_only,
                approval_mode=ApprovalMode.deny_all,
                base_instructions=instructions,
            )
            next_input = prompt
            for _ in range(max_turns):
                result = await thread.run(next_input, output_schema=schema)
                action = json.loads(result.final_response)
                name = action['tool']
                if name == 'done':
                    return
                if name not in handlers:
                    raise RuntimeError('Codex SDK requested an unavailable tool')
                args = action['arguments']
                if not isinstance(args, dict):
                    raise TypeError('Codex SDK tool arguments must be an object')
                args = {k: v for k, v in args.items() if v is not None}
                output = await handlers[name](args)
                if finished():
                    return
                next_input = json.dumps({'tool': name, 'result': output}, ensure_ascii=False)
