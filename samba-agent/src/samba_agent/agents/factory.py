"""등록부 → 실제 에이전트 객체. 감독자는 이 사전만 받는다."""

from samba_agent.agents.base import AgentFailure, DecideFn
from samba_agent.agents.buyer import BuyerAgent, ScriptsPendingBuyer, ShippingFn
from samba_agent.agents.payer import PayerAgent
from samba_agent.agents.recorder import RecorderAgent
from samba_agent.agents.registry import Registry
from samba_agent.agents.verifier import VerifierAgent
from samba_agent.bridge.client import BridgeClient
from samba_agent.failures import FailReason
from samba_agent.supervisor.graph import AgentFn
from samba_agent.wave.client import WaveClient

_CLASSES = {
    'buyer': BuyerAgent,
    'payer': PayerAgent,
    'recorder': RecorderAgent,
    'verifier': VerifierAgent,
}


def build_agents(
    reg: Registry,
    bridge: BridgeClient,
    decide: DecideFn,
    wave: WaveClient | None = None,
    compare_accounts_max: int = 5,
) -> dict[str, AgentFn]:
    """이름 → 호출 가능한 에이전트. 새 소싱처는 sources.yaml 1행이면 여기 자동으로 생긴다.

    저장 스크립트가 없는 소싱처(status: scripts_pending)도 만들어 둔다 — 부르면 곧바로
    needs_human('스크립트 미작성: <id>') 이다.

    ``wave`` 를 주면 구매는 배송지를, 결제는 결제 직전 재조회를, 기록·검증은 삼바웨이브 행을
    앱 화면 대신 내부 API 로 본다. ``compare_accounts_max`` 는 구매가 원가를 비교할 계정 수 상한이다.
    """
    shipping_fn = _shipping_provider(wave)
    agents: dict[str, AgentFn] = {}
    for spec in [s for kind in _CLASSES for s in reg.of_kind(kind)]:
        source = reg.source_of(spec.name)
        if source is not None and source.status == 'scripts_pending':
            agents[spec.name] = ScriptsPendingBuyer(spec, source)
            continue
        agent = _CLASSES[spec.kind](spec, bridge, decide)
        if isinstance(agent, BuyerAgent):
            agent.set_shipping_provider(shipping_fn)
            agent.compare_accounts_max = compare_accounts_max
        elif isinstance(agent, PayerAgent | RecorderAgent | VerifierAgent):
            agent.set_wave(wave)
        agents[spec.name] = agent
    # 교차 비교 짝(무신사 ↔ 29CM) — 소싱처 표의 cross_with 로 잇는다
    by_source = {
        reg.source_of(n).id: ag  # type: ignore[union-attr]
        for n, ag in agents.items()
        if isinstance(ag, BuyerAgent) and reg.source_of(n) is not None
    }
    # 짝으로만 쓰는 소싱처(hold — SSG ↔ H몰): 에이전트는 만들되 등록 사전(agents)에는 넣지 않는다 — 그 소싱처 주문은 받지 않는다
    for spec in reg.cross_only_specs():
        src = reg.source_of(spec.name)
        if src is None or src.id in by_source:
            continue
        only = BuyerAgent(spec, bridge, decide)
        only.set_shipping_provider(shipping_fn)
        only.compare_accounts_max = compare_accounts_max
        by_source[src.id] = only
    for n, ag in agents.items():
        src = reg.source_of(n)
        if isinstance(ag, BuyerAgent) and src is not None and src.cross_with:
            sib = by_source.get(src.cross_with)
            if isinstance(sib, BuyerAgent) and sib is not ag:
                ag.sibling = sib
    return agents


def _shipping_provider(wave: WaveClient | None) -> ShippingFn | None:
    """(주문 키(행 id 또는 주문번호), 배송 종류) → 배송지 사전. 개인정보라 여기서 만들어 바로 넘기고 아무 데도 담지 않는다.

    - 전화번호는 사전에 없다 — 고객 번호는 어디에도 입력하지 않고, 배송 연락처는 앱이 키마스터
      신원정보(identity.phone)로 채운다. 하네스는 번호를 보지 않는다(사용자 결정 2026-09-23).
    - 까대기를 요청했는데 삼바웨이브가 다른 종류(고객 주소)를 주면 그대로 쓰지 않고 멈춘다 —
      고객 집으로 보내는 사고보다 낫다. (구매 에이전트는 까대기면 기본 배송지를 유지해 이 공급자를
      부르지 않지만, 다른 호출부가 까대기로 부르면 이 검사가 막는다.)
    """
    if wave is None:
        return None

    def fetch(order_no: str, order_type: str) -> dict[str, object]:
        detail = wave.get_order(order_no, order_type=order_type)  # type: ignore[arg-type]
        if order_type == 'kkadaegi' and detail.order_type != 'kkadaegi':
            raise AgentFailure(
                'needs_human',
                '사무실 배송지를 받지 못했다 — 삼바웨이브 상세 API 가 order_type 요청을 지원해야 한다',
                FailReason.UNKNOWN,
            )
        return dict(detail.shipping.to_script_args())

    return fetch
