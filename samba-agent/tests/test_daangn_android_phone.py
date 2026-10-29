import io
from unittest.mock import Mock

from PIL import Image, ImageDraw
import pytest
import xml.etree.ElementTree as ET
from datetime import date

from tools.daangn.android_phone import AndroidPhone


def phone(tmp_path):
    return AndroidPhone(adb='adb', transport='serial', serial='serial', owner='서병기',
                        nickname='계정', lock_owner='test', attachments=str(tmp_path))


def screenshot(*, selected=True, size=(1080, 2340)):
    img = Image.new('RGB', size, 'white')
    if selected and size == (1080, 2340):
        ImageDraw.Draw(img).ellipse((950, 487, 994, 531), fill=(20, 25, 30))
    out = io.BytesIO()
    img.save(out, format='PNG')
    return out.getvalue()


def test_selected_ring_needs_verified_dark_indicator(tmp_path):
    device = phone(tmp_path)
    device._run = Mock(return_value=screenshot())
    assert device._selected_ring(509) is True
    device._run.return_value = screenshot(selected=False)
    assert device._selected_ring(509) is False
    device._run.return_value = screenshot(size=(720, 1600))
    with pytest.raises(ValueError, match='선택 표시'):
        device._selected_ring(509)


def test_duplicate_reservation_is_blocked_before_completion(tmp_path):
    from tools.daangn.reservation_journal import ReservationJournal
    journal = ReservationJournal(str(tmp_path / 'attempts.sqlite'))
    assert journal.begin('서병기', 'room')
    assert not journal.begin('서병기', 'room')


def test_ambiguous_chat_target_is_never_tapped(tmp_path):
    device = phone(tmp_path)
    device._run = Mock(return_value=b'')
    tree = ET.fromstring('<hierarchy><node text="상대" bounds="[0,0][100,100]"/>'
                         '<node text="상대" bounds="[0,200][100,300]"/></hierarchy>')
    with pytest.raises(RuntimeError, match='여러 개'):
        device._tap_unique(tree, '상대')
    device._run.assert_not_called()


def test_inventory_reservation_uses_tomorrow_and_door_then_checks_receipt(tmp_path, monkeypatch):
    from tools.daangn.reservation_journal import ReservationJournal
    device = phone(tmp_path)
    device.journal = ReservationJournal(str(tmp_path / 'attempts.sqlite'))
    device.room_id = 'room'
    chat = '<hierarchy><node text="날짜 선택하기" bounds="[10,10][100,100]"/></hierarchy>'
    dates = ('<hierarchy><node text="택배를 언제 수거할까요?"/>'
             '<node text="10월 30일(금)" bounds="[91,483][341,535]"/>'
             '<node text="11월 6일(금)" bounds="[91,1500][341,1550]"/>'
             '<node text="다음" bounds="[42,2055][1039,2194]"/></hierarchy>')
    place = ('<hierarchy><node text="어디에서 수거할까요?"/><node text="문 앞"/>'
             '<node text="경비실"/><node text="직접 입력"/>'
             '<node text="완료" bounds="[548,2055][1039,2194]"/></hierarchy>')
    receipt = ('<hierarchy><node text="택배 접수가 완료됐어요"/>'
               '<node text="기사님이 10월 30일(금)에 방문 예정이에요."/>'
               '<node text="진행 현황 보기" bounds="[42,2055][1039,2194]"/></hierarchy>')
    screens = iter([chat, dates, dates, place, place, receipt])
    device._screen = lambda: (lambda x: (x, ET.fromstring(x)))(next(screens))
    actions = []
    device._tap_unique = lambda _root, label: actions.append(label)
    device._tap_bounds = lambda bounds: actions.append(bounds)
    device._run = lambda *args, **kwargs: actions.append(args) or b''
    device._selected_ring = lambda y: y == 509
    monkeypatch.setattr('tools.daangn.android_phone.time.sleep', lambda _: None)
    result = device.reserve_pickup(is_musinsa=False, today=date(2026, 10, 29), location='문 앞')
    assert result == date(2026, 10, 30)
    assert actions == ['날짜 선택하기', '[91,483][341,535]', '다음',
                       ('shell', 'input', 'tap', '200', '509'), '완료', '진행 현황 보기']
    assert not device.journal.begin('서병기', 'room')
