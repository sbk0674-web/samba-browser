"""사무실 101호·102호는 같은 곳이다 — 까대기 배송에서만 서로 인정한다."""
from samba_agent.agents.verifier import _detail_found


def test_office_rooms_match_each_other_for_kkadaegi():
    assert _detail_found('광중3길58|1층102호', '101호', 'kkadaegi')
    assert _detail_found('광중3길58|101호', '102호', 'kkadaegi')


def test_office_rooms_do_not_match_for_customer_delivery():
    assert not _detail_found('광중3길58|1층102호', '101호', 'direct')
    assert not _detail_found('광중3길58|1층102호', '101호', 'gift')


def test_other_rooms_are_still_a_mismatch():
    assert not _detail_found('광중3길58|103호', '101호', 'kkadaegi')
    assert not _detail_found('광중3길58|1102호', '101호', 'kkadaegi')
    assert not _detail_found('광중3길58|1층102호', '201호', 'kkadaegi')
