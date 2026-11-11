"""에이전트 등록부. 새 소싱처는 sources.yaml 에 1행 + 규칙 파일이면 된다(스펙 §4.3)."""

from collections.abc import Mapping
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict

from samba_agent import local_aliases
from samba_agent.agents.contracts import OrderRef
from samba_agent.sources import Source, Sources

# 앱의 createSambaTools 가 내보내는 도구 이름(docs/bridge.md). 여기 없는 이름은 등록부에 못 쓴다
BRIDGE_TOOLS = frozenset(
    {
        'get_page',
        'find_elements',
        'screenshot',
        'ocr',
        'navigate',
        'click',
        'type',
        'select',
        'scroll',
        'dismiss_overlay',
        'run_js',
        'wait',
        'new_tab',
        'list_tabs',
        'switch_tab',
        'reveal_tab',
        'close_tab',
        'list_accounts',
        'fill_secret',
        'login',
        'progress',
        'remember_site',
        'save_script',
        'run_script',
        'list_playbooks',
        'update_playbook',
        'phone_tap',
        'phone_type',
        'phone_key',
        'phone_swipe',
        'phone_screenshot',
        'phone_get_screen',
        'phone_approve_payment',
    }
)

AgentKind = Literal['buyer', 'payer', 'recorder', 'verifier']

# 구매 에이전트의 브릿지 허용 목록. 소싱처가 달라도 같다 — 사이트 차이는 규칙 파일과 저장
# 스크립트가 흡수한다(예전에는 registry.yaml 의 buyer 행마다 같은 목록을 적어 두었다)
BUYER_TOOLS: tuple[str, ...] = (
    'get_page',
    'find_elements',
    'ocr',
    'navigate',
    'click',
    'type',
    'select',
    'scroll',
    'dismiss_overlay',
    'run_js',
    'run_script',
    'save_script',
    'wait',
    'new_tab',
    'list_tabs',
    'switch_tab',
    'close_tab',
    'list_accounts',
    'login',
    # 직배 배송지의 전화 칸 — 앱이 키마스터 신원정보(identity.phone)로 채운다. 결제 비밀이 아니라
    # 배송 연락처라 dry-run 에서도 허용한다
    'fill_secret',
    'progress',
)
# 소싱처별 규칙 파일이 없으면 쓰는 공통 규칙
DEFAULT_BUYER_RULES = 'rules/buyer_default.md'


class AgentSpec(BaseModel):
    """등록부 1행. 모르는 필드(오타)는 조용히 버리지 않고 로딩을 거부한다."""

    model_config = ConfigDict(extra='forbid')

    name: str
    kind: AgentKind
    match: dict[str, str] = {}
    tools: tuple[str, ...]
    rules: str
    prompts: str
    dataset: str
    retry: int = 0


def buyer_spec(root: Path, source: Source) -> AgentSpec:
    """소싱처 1행 → 구매 에이전트 1행. 규칙 파일이 없으면 공통 규칙으로 떨어진다."""
    rules = f'rules/buyer_{source.key}.md'
    if not (root / rules).exists():
        rules = DEFAULT_BUYER_RULES
    return AgentSpec(
        name=source.agent_name,
        kind='buyer',
        match={'source': source.id},
        tools=BUYER_TOOLS,
        rules=rules,
        prompts=f'samba/buyer-{source.key}',
        dataset=f'ds.buyer.{source.key}',
        retry=1,
    )


def buyer_specs(root: Path, sources: Sources) -> list[AgentSpec]:
    """등록할 소싱처(hold 제외) → 구매 에이전트 행. 스크립트를 공유하는 소싱처는 한 행만 만든다."""
    specs: list[AgentSpec] = []
    seen: set[str] = set()
    for source in sources.registered():
        if source.key in seen:
            continue
        seen.add(source.key)
        specs.append(buyer_spec(root, source))
    return specs


class Registry:
    """registry.yaml 을 읽어 들고 있는 객체. 감독자는 kind 만 알고 이름은 여기서 고른다."""

    def __init__(self, root: Path, specs: list[AgentSpec], sources: Sources | None = None) -> None:
        self._root = root
        self._specs = specs
        self._sources = sources if sources is not None else Sources([])
        self._by_name = {s.name: s for s in specs}

    @classmethod
    def load(cls, root: Path) -> 'Registry':
        raw = yaml.safe_load((root / 'registry.yaml').read_text(encoding='utf-8')) or {}
        sources_file = raw.get('buyers_from')
        sources = Sources.load(root, sources_file) if sources_file else Sources([])
        specs = buyer_specs(root, sources)
        specs += [AgentSpec.model_validate(row) for row in raw.get('agents', [])]
        for s in specs:
            bad = sorted(set(s.tools) - BRIDGE_TOOLS)
            if bad:
                raise ValueError(f'{s.name}: 브릿지에 없는 도구 {bad}')
            if not (root / s.rules).exists():
                raise ValueError(f'{s.name}: 규칙 파일이 없다 {s.rules}')
        return cls(root, specs, sources)

    @property
    def sources(self) -> Sources:
        return self._sources

    def source_of(self, agent_name: str) -> Source | None:
        """구매 에이전트 이름 → 소싱처 행. buyer 가 아니거나 표에 없으면 None."""
        if not agent_name.startswith('buyer.'):
            return None
        return self._sources.by_agent(agent_name)

    def of_kind(self, kind: str) -> list[AgentSpec]:
        return [s for s in self._specs if s.kind == kind]

    def cross_only_specs(self) -> list[AgentSpec]:
        """교차 비교 짝으로만 쓰는 소싱처(hold 인데 등록 소싱처의 cross_with)의 구매 에이전트 행.

        등록부(_specs)에는 넣지 않는다 — 그 소싱처 주문은 여전히 배정되지 않고(unsupported), 짝 소싱처가 교차 비교로만 부른다.
        """
        return [buyer_spec(self._root, s) for s in self._sources.cross_only()]

    def _canon_source(self, value: str | None) -> str | None:
        """소싱처 이름을 비교용 키로 맞춘다 — 한글 이름·id·key 가 모두 같은 값이 된다.

        키로 맞추는 이유: 그랜드스테이지처럼 ABC마트와 흐름(스크립트)을 공유하는 소싱처는
        id 가 달라도 같은 구매 에이전트가 맡는다.
        """
        found = self._sources.by_id(value)
        return found.key if found else value

    def pick(self, kind: str, order: OrderRef, options: Mapping[str, str]) -> AgentSpec | None:
        """담당 조건이 맞는 첫 에이전트. 없으면 None → 감독자가 needs_ai(unsupported)."""
        fields = {'source': order.source, 'seller': order.seller, **dict(options)}
        for s in self.of_kind(kind):
            if all(self._matches(fields, k, v) for k, v in s.match.items()):
                return s
        return None

    def _matches(self, fields: Mapping[str, object], key: str, want: str) -> bool:
        if key == 'source':
            return self._canon_source(str(fields.get(key) or '')) == self._canon_source(want)
        return fields.get(key) == want

    def rules_text(self, spec: AgentSpec) -> str:
        """에이전트에 쥐여 줄 규칙 본문.

        소싱처별 구매 규칙은 공통 규칙을 '잇는다' — 사이트 특이점만 적어 두므로 공통 규칙을
        앞에 붙여서 준다(파일만 넘기면 LLM 은 공통 규칙을 보지 못한다).
        """
        # 규칙 문서의 가명(계정·사무실)은 이 PC 의 실제 값으로 바꿔 준다(local_aliases)
        text = local_aliases.apply((self._root / spec.rules).read_text(encoding='utf-8'))
        default = self._root / DEFAULT_BUYER_RULES
        if spec.kind == 'buyer' and spec.rules != DEFAULT_BUYER_RULES and default.exists():
            sep = '\n\n---\n\n'
            return local_aliases.apply(default.read_text(encoding='utf-8')).rstrip() + sep + text
        return text

    def names(self) -> list[str]:
        return [s.name for s in self._specs]

    def __getitem__(self, name: str) -> AgentSpec:
        return self._by_name[name]
