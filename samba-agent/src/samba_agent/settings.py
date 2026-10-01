"""`.env` → 설정 객체. 비밀은 SecretStr 로만 들고 다녀 로그·프롬프트에 새지 않는다."""

import os
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# 이 파일 기준 samba-agent/ 폴더 — registry.yaml 과 rules/ 가 있는 곳
DEFAULT_ROOT = Path(__file__).resolve().parents[2]
# 앱(SAMBA Browser)의 저장 스크립트 파일 — 하네스는 앱과 같은 PC 에서 돈다
DEFAULT_SITE_SCRIPTS_FILE = (
    Path(os.environ.get('APPDATA', '')) / 'SAMBA Browser' / 'site-scripts.json'
)


class Settings(BaseSettings):
    """하네스 설정. 이름은 환경변수 이름과 1:1 이다."""

    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    bridge_url: str = Field(default='http://127.0.0.1:47811', alias='SAMBA_BRIDGE_URL')
    bridge_token: SecretStr = Field(alias='SAMBA_BRIDGE_TOKEN')
    harness_env: Literal['dev', 'staging', 'prod'] = Field(default='dev', alias='HARNESS_ENV')
    langsmith_api_key: SecretStr | None = Field(default=None, alias='LANGSMITH_API_KEY')
    slack_bot_token: SecretStr | None = Field(default=None, alias='SLACK_BOT_TOKEN')
    slack_app_token: SecretStr | None = Field(default=None, alias='SLACK_APP_TOKEN')
    slack_channel: str = Field(default='#sambaorder', alias='SLACK_CHANNEL')
    # NoDecode: 환경변수 값을 JSON 으로 풀지 않고 아래 검증기가 쉼표로 나눈다(예: U1,U2)
    slack_allowed_users: Annotated[tuple[str, ...], NoDecode] = Field(
        default=(), alias='SLACK_ALLOWED_USERS'
    )
    # 삼바웨이브 내부 API — 토큰·테넌트가 둘 다 있어야 클라이언트를 만든다(없으면 앱 스크립트 경로)
    wave_url: str = Field(default='https://api.samba-wave.co.kr', alias='SAMBA_WAVE_URL')
    wave_internal_token: SecretStr | None = Field(default=None, alias='SAMBA_WAVE_INTERNAL_TOKEN')
    wave_tenant_id: str | None = Field(default=None, alias='SAMBA_WAVE_TENANT_ID')
    # 자동 수집 창(일)과 주기(초) — Task D 의 intake 고리가 쓴다
    intake_days: int = Field(default=7, ge=1, alias='SAMBA_INTAKE_DAYS')
    intake_interval_s: int = Field(default=300, ge=10, alias='SAMBA_INTAKE_INTERVAL_S')
    # 자동 수집 고리를 띄울지. 꺼 두면 슬랙 `주문처리 전체` 로 수동 수집만 한다
    intake_enabled: bool = Field(default=True, alias='SAMBA_INTAKE_ENABLED')
    # 한 바퀴에 새로 접수하는 상한(슬랙 폭주 방지)
    intake_max_new: int = Field(default=5, ge=1, alias='SAMBA_INTAKE_MAX_NEW')
    # 자동 수집 대상 소싱처(쉼표, 비우면 전부)와 판매처 제한(포이즌만)
    intake_sources: str = Field(default='', alias='SAMBA_INTAKE_SOURCES')
    intake_poison_only: bool = Field(default=False, alias='SAMBA_INTAKE_POISON_ONLY')
    # 포이즌 제한을 두지 않는(모든 판매처를 이행하는) 소싱처(쉼표). 예: MUSINSA
    intake_all_sellers_sources: str = Field(default='', alias='SAMBA_INTAKE_ALL_SELLERS_SOURCES')
    # 결제에 쓸 수 있는 결제 제공자(쉼표, 비우면 키마스터에 있는 것 전부). 예: site,musinsapay
    allowed_pay_providers: str = Field(default='', alias='SAMBA_ALLOWED_PAY_PROVIDERS')
    # True 면 결제 승인 요청을 사람 대신 즉시 승인한다(사용자가 자동 이행을 켠 경우만)
    auto_approve: bool = Field(default=False, alias='SAMBA_AUTO_APPROVE')
    # 자동 승인하지 않고 사람 승인을 받을 결제수단(쉼표, 표시 이름 일부) — 실결제 검증 전 수단(페이코 2026-09-25)
    manual_approve_methods: str = Field(default='', alias='SAMBA_MANUAL_APPROVE_METHODS')
    # 주문 계정이 지정되지 않은 구매에서 원가를 비교할 소싱 계정 수 상한(계정마다 로그인·주문서를 만든다)
    compare_accounts_max: int = Field(default=5, ge=1, alias='SAMBA_COMPARE_ACCOUNTS_MAX')
    root: Path = Field(default=DEFAULT_ROOT, alias='SAMBA_AGENT_ROOT')
    db_path: Path = Field(default=DEFAULT_ROOT / 'jobs.sqlite', alias='SAMBA_DB_PATH')
    # 판정·진단 산출물 위치. gate·eval·API 가 같은 곳을 본다(리뷰 지적 — I4)
    report_dir: Path = Field(default=DEFAULT_ROOT / 'ops' / 'reports', alias='SAMBA_REPORT_DIR')
    # 프롬프트 허브 커밋 — 추적 메타데이터에 실린다. 허브를 안 쓰면 'local' 이다
    prompt_commit: str = Field(default='local', alias='SAMBA_PROMPT_COMMIT')
    # 기본은 dry-run 이다. 외부 변경은 사용자 검토를 거친 뒤 명시로만 켠다(스펙 §10-1)
    dry_run: bool = Field(default=True, alias='SAMBA_DRY_RUN')
    # dry-run 에서 결제 비밀번호를 몇 자리까지 눌러 보고 취소할지(0 이면 결제창까지만).
    # 실기에서 키패드 자동 입력이 되는지만 보는 값이라 앱 스키마와 같은 1~3 자리를 쓴다
    dry_run_digits: int = Field(default=0, ge=0, le=3, alias='SAMBA_DRY_RUN_DIGITS')
    # 작업이 끝나도 브라우저 탭을 남긴다(다음 작업 시작 때 정리) — 사람이 과정을 눈으로 확인하려고
    keep_tabs: bool = Field(default=False, alias='SAMBA_KEEP_TABS')
    # 저장 스크립트가 실패하면 AI 가 화면을 보고 고쳐 이어 간다(검증 통과한 코드만 저장, 이전 판은 이력 폴더)
    # 기본 꺼짐 — 2026-09-24 수리 시험 중 '결제하기' 클릭으로 실결제 발생. 앱 쪽 결제 버튼 클릭 차단 전까지 켜지 않는다
    repair_enabled: bool = Field(default=False, alias='SAMBA_REPAIR_ENABLED')
    repair_model: str = Field(default='claude-opus-5-5', alias='SAMBA_REPAIR_MODEL')
    repair_timeout_s: float = Field(default=900.0, ge=60, alias='SAMBA_REPAIR_TIMEOUT_S')
    site_scripts_file: Path = Field(
        default=DEFAULT_SITE_SCRIPTS_FILE, alias='SAMBA_SITE_SCRIPTS_FILE'
    )
    # 외부 프로그램(EMP·샵마인) 원가·배송비 기입. 기본 꺼짐 — 입력 작업자와 어댑터를 실기로 확인한 뒤 켠다
    export_enabled: bool = Field(default=False, alias='SAMBA_EXPORT_ENABLED')
    # 하네스와 입력 작업자가 함께 보는 큐 파일
    export_db_path: Path = Field(
        default=DEFAULT_ROOT / 'exports.sqlite', alias='SAMBA_EXPORT_DB_PATH'
    )
    # 판매처 → 대상 라우팅 목록
    export_routing_file: Path = Field(
        default=DEFAULT_ROOT / 'export.yaml', alias='SAMBA_EXPORT_ROUTING_FILE'
    )
    # export 단계가 기입 결과를 기다리는 시간(초). 지나면 주문은 완료로 끝내고 결과는 나중에 알린다
    export_wait_s: float = Field(default=60.0, ge=0, alias='SAMBA_EXPORT_WAIT_S')
    # 입력 작업자가 맡을 대상(쉼표). 비우면 어댑터를 만들지 않는다. 예: shopmine
    export_targets: str = Field(default='', alias='SAMBA_EXPORT_TARGETS')
    # 소싱처 미등록 주문을 샵마인·EMP 의 판매자상품코드(cp_…)로 수집상품에 잇는다.
    # 삼바웨이브 상품 연결 API 가 수집상품 번호를 받게 된 뒤에 켠다
    link_by_seller_code: bool = Field(default=False, alias='SAMBA_LINK_BY_SELLER_CODE')

    @property
    def export_target_list(self) -> tuple[str, ...]:
        return tuple(x.strip() for x in self.export_targets.split(',') if x.strip())

    @field_validator('slack_allowed_users', mode='before')
    @classmethod
    def _split_users(cls, v: object) -> object:
        """쉼표로 붙인 슬랙 사용자 ID 목록을 튜플로 나눈다."""
        if isinstance(v, str):
            return tuple(x.strip() for x in v.split(',') if x.strip())
        return v


def load_settings(env_file: str | Path | None = '.env') -> Settings:
    """설정을 읽는다. 필수 값(브릿지 토큰)이 없으면 여기서 실패한다.

    env_file=None 이면 `.env` 를 읽지 않고 환경변수만 본다(테스트가 로컬 .env 에 물들지 않게)."""
    return Settings(_env_file=env_file)  # type: ignore[call-arg]


def default_report_dir() -> Path:
    """판정·실험 산출물 폴더. `SAMBA_REPORT_DIR` 가 있으면 그것, 없으면 `root/ops/reports`.

    gate·eval 은 모듈 상수로, API 는 root 기준 경로로 각자 다른 곳을 보고 있었다
    (리뷰 지적 — I4). 설정 하나로 모은다. `.env` 는 읽지 않는다 — 모듈 로딩 시점에
    불리는 함수라 환경변수만 본다.
    """
    import os

    raw = os.environ.get('SAMBA_REPORT_DIR')
    if raw:
        return Path(raw)
    root = os.environ.get('SAMBA_AGENT_ROOT')
    return (Path(root) if root else DEFAULT_ROOT) / 'ops' / 'reports'
