"""One harness per queue directory; the OS releases the lock on process exit."""

import os
from pathlib import Path


def acquire_harness_lock(root: Path):
    path = root.resolve() / 'logs' / 'harness-instance.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = path.open('a+b')
    if path.stat().st_size == 0:
        stream.write(b'0')
        stream.flush()
    stream.seek(0)
    try:
        if os.name == 'nt':
            import msvcrt

            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        stream.close()
        return None
    return stream  # Caller must retain this handle for the complete harness lifetime.
