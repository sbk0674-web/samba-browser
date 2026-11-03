import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from tools.daangn import pickup_dates
from tools.daangn.android_phone import AndroidPhone

FIXTURES = Path(__file__).parent / 'fixtures' / 'daangn_pickup'


def png(name):
    return (FIXTURES / name).read_bytes()


def test_detect_actual_radio_rows_and_selected_state_from_four_evidence_images():
    expected = {
        'current-date.png': (6, [0]), 'scrolled-date.png': (6, []),
        'selected-date.png': (6, [5]), 'location.png': (3, [0]),
    }
    for name, (count, selected) in expected.items():
        rows = pickup_dates.detect_radio_rows(png(name))
        assert len(rows) == count, name
        assert [i for i, row in enumerate(rows) if row['selected']] == selected, name
        assert all(0 < row['bounds'][0] < row['bounds'][2] < 720 for row in rows)


def test_scroll_mapping_uses_overlapping_text_not_screen_ratios():
    first, known = pickup_dates.map_radio_rows(
        pickup_dates.detect_radio_rows(png('current-date.png')), 7)
    assert [r['index'] for r in first] == list(range(6))
    scrolled, known = pickup_dates.map_radio_rows(
        pickup_dates.detect_radio_rows(png('scrolled-date.png')), 7, known)
    assert [r['index'] for r in scrolled] == list(range(1, 7))
    selected, _ = pickup_dates.map_radio_rows(
        pickup_dates.detect_radio_rows(png('selected-date.png')), 7, known)
    assert [r['index'] for r in selected if r['selected']] == [6]
    assert selected[-1]['bounds'][1] < 1050 < selected[-1]['bounds'][3]


def test_mapping_never_guesses_without_overlap_or_with_ambiguous_selection():
    rows = pickup_dates.detect_radio_rows(png('scrolled-date.png'))
    with pytest.raises(ValueError):
        pickup_dates.map_radio_rows(rows, 7)
    with pytest.raises(ValueError):
        pickup_dates.map_radio_rows(rows, 7, {'unknown': 0})


def test_zero_bounds_date_labels_keep_all_seven_xml_dates_in_order():
    labels = ['10월 31일(토)', '11월 2일(월)', '11월 3일(화)', '11월 4일(수)',
              '11월 5일(목)', '11월 6일(금)', '11월 7일(토)']
    xml = '<hierarchy><node text="택배를 언제 수거할까요?"/>' + ''.join(
        f'<node text="{label}" bounds="[0,0][0,0]"/>' for label in labels) + '</hierarchy>'
    dates = pickup_dates.calendar_dates(xml, today=date(2026, 10, 30))
    assert [d for d, _ in dates] == [date(2026, 10, 31), *[date(2026, 11, d) for d in range(2, 8)]]


def calendar():
    labels = ['10월 31일(토)', '11월 2일(월)', '11월 3일(화)', '11월 4일(수)',
              '11월 5일(목)', '11월 6일(금)', '11월 7일(토)']
    return '<hierarchy><node text="택배를 언제 수거할까요?"/>' + ''.join(
        f'<node text="{label}" bounds="[0,0][0,0]"/>' for label in labels
    ) + '<node text="다음" bounds="[34,1215][686,1328]"/></hierarchy>'


def visual_phone(monkeypatch, frames):
    phone = object.__new__(AndroidPhone)
    commands, taps = [], []
    images = iter(frames)
    def run(*args):
        if args == ('exec-out', 'screencap', '-p'):
            return next(images)
        commands.append(args)
        return b''
    phone._run = run
    phone._tap_bounds = taps.append
    phone._screen = lambda: (calendar(), ET.fromstring(calendar()))
    monkeypatch.setattr('tools.daangn.android_phone.time.sleep', lambda _: None)
    return phone, commands, taps


def test_visual_date_scrolls_to_last_xml_date_and_verifies_actual_selected_ring(monkeypatch):
    phone, commands, taps = visual_phone(monkeypatch, [png(n) for n in (
        'current-date.png', 'scrolled-date.png', 'selected-date.png')])
    chosen = phone._visual_pickup_date(calendar(), today=date(2026, 10, 30), is_musinsa=True)
    assert chosen == date(2026, 11, 7)
    assert len(commands) == 1 and commands[0][:3] == ('shell', 'input', 'swipe')
    assert len(taps) == 1
    assert taps[0] == '[610,1029][652,1071]'


def test_wrong_selection_after_tap_is_held_before_next_or_journal(monkeypatch):
    phone, _, _ = visual_phone(monkeypatch, [png(n) for n in (
        'current-date.png', 'scrolled-date.png', 'scrolled-date.png')])
    with pytest.raises(ValueError, match='선택'):
        phone._visual_pickup_date(calendar(), today=date(2026, 10, 30), is_musinsa=True)


def test_scroll_without_visual_movement_is_held(monkeypatch):
    phone, _, _ = visual_phone(monkeypatch, [png('current-date.png')] * 2)
    with pytest.raises(ValueError, match='스크롤'):
        phone._visual_pickup_date(calendar(), today=date(2026, 10, 30), is_musinsa=True)


def test_owned_inventory_keeps_earliest_visible_date_without_scrolling(monkeypatch):
    phone, commands, taps = visual_phone(monkeypatch, [png('current-date.png')] * 2)
    assert phone._visual_pickup_date(calendar(), today=date(2026, 10, 30), is_musinsa=False) == date(2026, 10, 31)
    assert commands == [] and taps == ['[610,375][652,418]']


def test_changed_xml_dates_after_scroll_are_held_before_tap(monkeypatch):
    phone, _, taps = visual_phone(monkeypatch, [png('current-date.png')])
    wrong = calendar().replace('11월 7일(토)', '11월 8일(일)')
    phone._screen = lambda: (wrong, ET.fromstring(wrong))
    with pytest.raises(ValueError, match='불일치'):
        phone._visual_pickup_date(calendar(), today=date(2026, 10, 30), is_musinsa=True)
    assert taps == []


def test_720_full_reservation_replay_uses_visual_last_date_and_verified_door(monkeypatch):
    phone, commands, taps = visual_phone(monkeypatch, [png(n) for n in (
        'current-date.png', 'scrolled-date.png', 'selected-date.png', 'location.png')])
    place = '<hierarchy><node text="어디에서 수거할까요?"/>' + ''.join(
        f'<node text="{label}" bounds="[0,0][0,0]"/>' for label in ('문 앞', '경비실', '직접 입력')
    ) + '<node text="완료" bounds="[369,1215][686,1328]"/></hierarchy>'
    receipt = '<hierarchy><node text="택배 접수가 완료됐어요"/><node text="11월 7일 수거"/>' \
              '<node text="진행 현황 보기"/></hierarchy>'
    xmls = iter(['<hierarchy><node text="날짜 선택하기"/></hierarchy>', calendar(),
                 calendar(), calendar(), place, place, receipt])
    def screen():
        xml = next(xmls)
        return xml, ET.fromstring(xml)
    phone._screen = screen
    actions = []
    phone._tap_unique = lambda root, label: actions.append(label)
    phone.owner, phone.room_id = '김귀옥', 'room'
    phone.journal = SimpleNamespace(begin=Mock(side_effect=lambda *a: actions.append('journal') or True))
    assert phone.reserve_pickup(is_musinsa=True, today=date(2026, 10, 30), location='문 앞') == date(2026, 11, 7)
    assert actions == ['날짜 선택하기', '다음', 'journal', '완료', '진행 현황 보기']
    assert len(taps) == 1 and len(commands) == 1


def test_location_wrong_radio_after_tap_is_rejected(monkeypatch):
    import tools.daangn.android_phone as module
    rows = pickup_dates.detect_radio_rows(png('location.png'))
    wrong = [{**r, 'selected': i == 1} for i, r in enumerate(rows)]
    monkeypatch.setattr(module, 'detect_radio_rows', lambda _: wrong)
    phone, _, taps = visual_phone(monkeypatch, [b'fake'] * 2)
    with pytest.raises(ValueError, match='문 앞'):
        phone._visual_pickup_location()
    assert len(taps) == 1


def test_date_selection_failure_never_reaches_next_or_reservation_journal(monkeypatch):
    phone, _, _ = visual_phone(monkeypatch, [png(n) for n in (
        'current-date.png', 'scrolled-date.png', 'scrolled-date.png')])
    xmls = iter(['<hierarchy><node text="날짜 선택하기"/></hierarchy>', calendar(), calendar()])
    def screen():
        xml = next(xmls)
        return xml, ET.fromstring(xml)
    phone._screen = screen
    actions = []
    phone._tap_unique = lambda root, label: actions.append(label)
    phone.owner, phone.room_id = '김귀옥', 'room'
    phone.journal = SimpleNamespace(begin=Mock())
    with pytest.raises(ValueError, match='선택'):
        phone.reserve_pickup(is_musinsa=True, today=date(2026, 10, 30), location='문 앞')
    assert actions == ['날짜 선택하기']
    phone.journal.begin.assert_not_called()
