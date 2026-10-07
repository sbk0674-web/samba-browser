"""판매처 → 외부 기입 대상. 목록은 export.yaml 에서 고친다(코드 수정 없이)."""

import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict

Target = Literal['emp', 'shopmine']
# 취소 연동은 같은 프로그램의 다른 작업이라 대상 이름을 따로 둔다 — 큐의 (주문번호, 대상)
# 유일 조건과 작업자의 대상별 처리를 그대로 쓴다
CANCEL_SUFFIX = '_cancel'
# 소싱처 미등록 주문의 판매자상품코드 읽기 — 값을 넣지 않고 읽기만 하는 작업이다
LOOKUP_SUFFIX = '_lookup'
QueueTarget = Literal[
    'emp', 'shopmine', 'emp_cancel', 'shopmine_cancel', 'emp_lookup', 'shopmine_lookup'
]


def lookup_target(target: str) -> str:
    """기입 대상 → 그 프로그램의 읽기 대상 이름."""
    return f'{target}{LOOKUP_SUFFIX}'


def cancel_target(target: str) -> str:
    """기입 대상 → 그 프로그램의 취소 대상 이름."""
    return f'{target}{CANCEL_SUFFIX}'


_SPACES = re.compile(r'\s+')


def _norm(text: str | None) -> str:
    """비교용 — 공백을 없애고 소문자로 맞춘다('현대 h몰' == '현대H몰')."""
    return _SPACES.sub('', text or '').lower()


class ExportRouting(BaseModel):
    """라우팅 설정. 모르는 키(오타)는 조용히 버리지 않고 로딩을 거부한다."""

    model_config = ConfigDict(extra='forbid')

    # 판매처 문자열에 이 표식이 들어 있으면 EMP 에 기입한다
    emp: tuple[str, ...] = ()
    # 이 표식이 들어 있으면 어디에도 기입하지 않는다
    skip: tuple[str, ...] = ()
    # 위 둘에 해당하지 않는 판매처의 대상
    default: Target = 'shopmine'

    @classmethod
    def load(cls, path: Path) -> 'ExportRouting':
        raw = yaml.safe_load(path.read_text(encoding='utf-8')) or {}
        return cls.model_validate(raw)

    def target_for(self, seller: str | None) -> Target | None:
        """기입할 프로그램. None 이면 기입하지 않는다(제외 판매처이거나 판매처를 모른다)."""
        s = _norm(seller)
        if not s:
            return None
        # 제외가 먼저다 — 제외 표식이 EMP 표식을 품고 있어도 기입하지 않는다
        if any(_norm(m) in s for m in self.skip if _norm(m)):
            return None
        if any(_norm(m) in s for m in self.emp if _norm(m)):
            return 'emp'
        return self.default
