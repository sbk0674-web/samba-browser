from tools.daangn.reservation_journal import ReservationJournal


def test_unknown_outcome_never_submits_twice_across_restarts(tmp_path):
    path = str(tmp_path / 'attempts.sqlite')
    assert ReservationJournal(path).begin('서병기', 'room-1') is True
    assert ReservationJournal(path).begin('서병기', 'room-1') is False
    assert ReservationJournal(path).begin('서병기', 'room-2') is True
    assert b'\xec\x84\x9c\xeb\xb3\x91\xea\xb8\xb0' not in (tmp_path / 'attempts.sqlite').read_bytes()
