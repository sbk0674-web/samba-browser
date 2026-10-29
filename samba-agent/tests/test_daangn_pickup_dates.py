from datetime import date
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('pickup_dates', Path(__file__).parents[1] / 'tools/daangn/pickup_dates.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_owned_stock_earliest_and_musinsa_latest():
    xml = ('<hierarchy><node text="택배를 언제 수거할까요?"/>'
           '<node text="10월 30일(금)" bounds="[1,2][30,40]"/>'
           '<node text="11월 6일(금)" bounds="[1,50][30,80]"/></hierarchy>')
    assert module.choose_pickup_date(xml, today=date(2026, 10, 29), is_musinsa=False)[0] == date(2026, 10, 30)
    assert module.choose_pickup_date(xml, today=date(2026, 10, 29), is_musinsa=True)[0] == date(2026, 11, 6)


def test_missing_or_invisible_date_never_selects():
    xml = ('<hierarchy><node text="택배를 언제 수거할까요?"/>'
           '<node text="10월 30일(금)" bounds="[0,0][0,0]"/></hierarchy>')
    with pytest.raises(ValueError):
        module.choose_pickup_date(xml, today=date(2026, 10, 29), is_musinsa=False)


def test_rollover_to_new_year_uses_next_year():
    xml = ('<hierarchy><node text="택배를 언제 수거할까요?"/>'
           '<node text="1월 2일(토)" bounds="[1,2][30,40]"/></hierarchy>')
    assert module.choose_pickup_date(xml, today=date(2026, 12, 31), is_musinsa=False)[0] == date(2027, 1, 2)
