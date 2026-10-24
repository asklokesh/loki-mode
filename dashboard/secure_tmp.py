"""Shared write-temp-then-rename for secrets, plus the stale-temp sweep.

One-line justification for a new file: no existing dashboard module owns
secret-temp creation and cleanup (build_supervisor._atomic_write is private to
execution state and does not sweep). A writer killed between the temp write and
the rename would otherwise leave the secret on disk forever.

Mirrors sweepStaleTmp / writeExclusiveTmp in loki-ts/src/util/atomic.ts and
_loki_mcp_sweep_stale_tmp in autonomy/lib/mcp-config.sh.
"""
import os
import re
import stat
import time
from pathlib import Path

STALE_SECONDS = 60 * 60


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # EPERM: the process exists, owned by someone else
    except (OSError, OverflowError, ValueError):
        return False
    return True


def sweep_stale_tmp(directory, pattern: str) -> None:
    """Remove temps left by a dead writer.

    `pattern` is fullmatched against each name in `directory` (never recursive)
    and its first group is the writer pid. An entry is removed only when it is a
    regular file (not a symlink), owned by this uid, not ours, and its pid is
    dead or its mtime is over 60 minutes (pid reuse). A live writer's temp stays.
    """
    rx = re.compile(pattern, re.DOTALL)
    uid = os.getuid()
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return
    for entry in entries:
        m = rx.fullmatch(entry.name)
        if not m:
            continue
        pid = int(m.group(1))
        if pid == os.getpid():
            continue
        if pid > 2**31 - 1:
            continue  # not a pid we could own; never signal or remove it
        try:
            st = os.lstat(entry.path)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != uid:
                continue
            if _pid_alive(pid) and time.time() - st.st_mtime <= STALE_SECONDS:
                continue
            os.unlink(entry.path)
        except OSError:
            continue


def write_secret_atomic(dest, data: bytes, mode: int = 0o600) -> None:
    """Write `data` to `dest` via `.<name>.<pid>.tmp` then rename.

    The temp is created O_CREAT|O_EXCL|O_NOFOLLOW so a planted symlink or file
    is never written through. Stale temps of dead writers are swept first.
    """
    dest = Path(dest)
    sweep_stale_tmp(dest.parent, r"\.%s\.(\d+)\.tmp" % re.escape(dest.name))
    tmp = dest.with_name(".%s.%d.tmp" % (dest.name, os.getpid()))
    try:
        os.unlink(tmp)  # our own pid left over from a reused pid
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        try:
            os.fchmod(fd, mode)
            os.write(fd, data)
        finally:
            os.close(fd)
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
