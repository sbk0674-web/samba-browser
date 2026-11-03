from samba_agent.queue.singleton import acquire_harness_lock


def test_duplicate_is_denied_and_exit_releases_lock(tmp_path):
    first = acquire_harness_lock(tmp_path)
    assert first is not None
    assert acquire_harness_lock(tmp_path) is None
    first.close()
    next_owner = acquire_harness_lock(tmp_path)
    assert next_owner is not None
    next_owner.close()


def test_different_queue_directories_can_run_independently(tmp_path):
    first = acquire_harness_lock(tmp_path / 'one')
    other = acquire_harness_lock(tmp_path / 'two')
    assert first is not None and other is not None
    first.close()
    other.close()
