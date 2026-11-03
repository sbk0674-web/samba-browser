"""API-only repair, using exactly the existing guarded repair tools."""

import json
from typing import Any

import httpx

from samba_agent.llm.auth import env_value

ACCOUNT = 'sbk0674@gmail.com'


def tool_schema(tool):
    raw = tool.input_schema
    if raw.get('type') == 'object':
        return {**raw, 'additionalProperties': False}
    kinds = {str: 'string', int: 'integer', float: 'number', bool: 'boolean'}
    return {
        'type': 'object',
        'properties': {name: {'type': kinds[kind]} for name, kind in raw.items()},
        'required': list(raw),
        'additionalProperties': False,
    }


def credentials(provider: str) -> tuple[str, str]:
    if provider == 'codex_sdk':
        # Authentication is checked through SDK.account() at session start.
        return '', ''
    prefix = 'SAMBA_REPAIR_CLAUDE' if provider == 'anthropic' else 'SAMBA_REPAIR_CODEX'
    # A CLI subscription login is not an API key. Never borrow its OAuth tokens.
    key = env_value(prefix + '_API_KEY')
    owner = env_value(prefix + '_ACCOUNT')
    if provider == 'anthropic' and not key:
        key = env_value('SAMBA_ANTHROPIC_API_KEY')
        workspace = env_value('SAMBA_ANTHROPIC_WORKSPACE_ID')
        if key:
            return key, workspace  # Existing API credential, not Claude subscription OAuth.
    if not key or owner.casefold() != ACCOUNT:
        raise RuntimeError(f'{provider}: requested account API credential missing/unconfirmed')
    workspace = env_value(prefix + '_WORKSPACE_ID') if provider == 'anthropic' else ''
    return key, workspace


async def run_api_loop(provider, model, prompt, system, tools, max_turns, finished):
    if provider == 'codex_sdk':
        from samba_agent.repair.codex_sdk import run_sdk_loop

        await run_sdk_loop(model, prompt, system, tools, max_turns, finished)
        return
    key, workspace = credentials(provider)
    handlers = {t.name: t.handler for t in tools}
    schemas = []
    for tool in tools:
        schema = tool_schema(tool)
        schemas.append(
            {
                'name': tool.name,
                'description': tool.description,
                'parameters': schema,
                'type': 'function',
                'strict': True,
            }
        )
    messages: list[dict[str, Any]] = [{'role': 'user', 'content': prompt}]
    headers = (
        {'x-api-key': key, 'anthropic-version': '2023-06-01'}
        if provider == 'anthropic'
        else {'Authorization': f'Bearer {key}'}
    )
    if workspace:
        headers['anthropic-workspace-id'] = workspace
    url = (
        'https://api.anthropic.com/v1/messages'
        if provider == 'anthropic'
        else 'https://api.openai.com/v1/responses'
    )
    async with httpx.AsyncClient(timeout=120) as client:
        for _ in range(max_turns):
            if provider == 'anthropic':
                payload = {
                    'model': model,
                    'system': system,
                    'messages': messages,
                    'max_tokens': 12000,
                    'tools': [
                        {
                            'name': t['name'],
                            'description': t['description'],
                            'input_schema': t['parameters'],
                        }
                        for t in schemas
                    ],
                }
            else:
                payload = {
                    'model': model,
                    'instructions': system,
                    'input': messages,
                    'tools': schemas,
                    'parallel_tool_calls': False,
                    'store': False,
                    'max_output_tokens': 16000,
                }
            response = await client.post(url, headers=headers, json=payload)
            if response.status_code != 200:
                # Never log response bodies: providers may echo submitted data.
                raise RuntimeError(f'{provider} API HTTP {response.status_code}')
            data = response.json()
            blocks = data.get('content', []) if provider == 'anthropic' else data.get('output', [])
            if provider == 'anthropic':
                messages.append({'role': 'assistant', 'content': blocks})
            else:
                messages.extend(blocks)
            results = []
            for block in blocks:
                if block.get('type') != (
                    'tool_use' if provider == 'anthropic' else 'function_call'
                ):
                    continue
                name = block.get('name')
                if name not in handlers:
                    raise RuntimeError('API requested an unavailable repair tool')
                args = (
                    block.get('input', {})
                    if provider == 'anthropic'
                    else json.loads(block['arguments'])
                )
                result = await handlers[name](args)
                if finished():
                    return  # Do not run extra tool calls after PASS/genuine.
                output = json.dumps(result, ensure_ascii=False)
                results.append(
                    {'type': 'tool_result', 'tool_use_id': block['id'], 'content': output}
                    if provider == 'anthropic'
                    else {
                        'type': 'function_call_output',
                        'call_id': block['call_id'],
                        'output': output,
                    }
                )
            if not results:
                return
            if provider == 'anthropic':
                messages.append({'role': 'user', 'content': results})
            else:
                messages.extend(results)
