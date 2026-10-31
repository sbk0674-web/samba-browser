# 외부 기입 라우팅 — 판매처 문자열로 대상 프로그램을 정한다
from pathlib import Path

import pytest
from pydantic import ValidationError

from samba_agent.export.routing import ExportRouting
from samba_agent.settings import DEFAULT_ROOT

ROUTING = ExportRouting(
    emp=('GS이숍', '롯데아이몰', '현대H몰', 'KT알파'),
    skip=('포이즌', '크림'),
    default='shopmine',
)


@pytest.mark.parametrize(
    'seller',
    ['GS이숍(캐논)', '롯데아이몰', '현대H몰', 'KT알파쇼핑', 'gs이숍 (캐논)', '현대 h몰'],
)
def test_플레이오토_경유_판매처는_emp(seller):
    assert ROUTING.target_for(seller) == 'emp'


@pytest.mark.parametrize('seller', ['포이즌', 'POIZON 포이즌', '크림'])
def test_제외_판매처는_기입하지_않는다(seller):
    assert ROUTING.target_for(seller) is None


@pytest.mark.parametrize('seller', ['스마트스토어', '쿠팡', '11번가'])
def test_나머지는_샵마인(seller):
    assert ROUTING.target_for(seller) == 'shopmine'


@pytest.mark.parametrize('seller', [None, '', '   '])
def test_판매처를_모르면_기입하지_않는다(seller):
    assert ROUTING.target_for(seller) is None


def test_제외가_emp_보다_먼저다():
    routing = ExportRouting(emp=('몰',), skip=('포이즌몰',), default='shopmine')
    assert routing.target_for('포이즌몰') is None


def test_설정_파일을_읽는다(tmp_path: Path):
    path = tmp_path / 'export.yaml'
    path.write_text('emp: [GS이숍]\nskip: [포이즌]\ndefault: shopmine\n', encoding='utf-8')
    routing = ExportRouting.load(path)
    assert routing.target_for('GS이숍(캐논)') == 'emp'


def test_모르는_키는_로딩을_거부한다(tmp_path: Path):
    path = tmp_path / 'export.yaml'
    path.write_text('emp: [GS이숍]\nemps: [오타]\n', encoding='utf-8')
    with pytest.raises(ValidationError):
        ExportRouting.load(path)


def test_저장소의_설정_파일이_스펙과_같다():
    routing = ExportRouting.load(DEFAULT_ROOT / 'export.yaml')
    assert routing.target_for('GS이숍(캐논)') == 'emp'
    assert routing.target_for('롯데아이몰') == 'emp'
    assert routing.target_for('현대H몰') == 'emp'
    assert routing.target_for('KT알파쇼핑') == 'emp'
    assert routing.target_for('포이즌') is None
    assert routing.target_for('크림') is None
    assert routing.target_for('스마트스토어') is None


def test_기본_대상을_끄면_emp만_남는다(tmp_path: Path):
    path = tmp_path / 'export.yaml'
    path.write_text('emp: [롯데홈쇼핑]\ndefault: null\n', encoding='utf-8')
    routing = ExportRouting.load(path)
    assert routing.target_for('롯데홈쇼핑(계정)') == 'emp'
    assert routing.target_for('쿠팡') is None
    assert routing.target_for('당근마켓') is None
