#!/usr/bin/env python3
"""
Regression test for the delete_episode lock-race fix in memory/storage.py.

delete_episode used to do, after removing the target episode's own file:

    for stale_lock in date_dir.glob("*.lock"):
        try:
            stale_lock.unlink()
        except OSError:
            pass

That blanket unlink is the same flock+unlink inode-replacement race that was
fixed in _file_lock and _cleanup_stale_locks (wave-6): a *.lock held by a
concurrent writer of a DIFFERENT episode in the SAME date dir would have its
inode unlinked. A third writer could then create a new inode at the same path
and flock that, entering the critical section while the original holder is
still inside (data loss).

The fix mirrors _cleanup_stale_locks: probe each lock with a non-blocking
flock and only unlink it when the probe succeeds (nobody holds it). A held
lock is left untouched.

Both tests below are NON-VACUOUS: the held-lock test fails on the pre-fix code
(the blanket unlink removes the held lock's inode) and passes after the fix;
the unheld-lock test confirms the GC of a free lock still happens.

Run directly:  python3 tests/test_storage_delete_episode_lock.py
Or via pytest: python3 -m pytest tests/test_storage_delete_episode_lock.py -q
"""

import fcntl
import os
import sys
import tempfile
from pathlib import Path

# Make the repo root importable so `import memory.*` resolves regardless of cwd.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from memory.storage import MemoryStorage  # noqa: E402


def _new_storage(tmpdir: str) -> MemoryStorage:
    """Fresh storage rooted at an isolated tempdir."""
    return MemoryStorage(base_path=Path(tmpdir))


def _save_two_episodes_same_date(storage: MemoryStorage):
    """Save two episodes that land in the SAME date dir.

    Returns (date_dir, lock_path_b) where lock_path_b is the .lock path a
    concurrent writer of episode B would hold.
    """
    ts = "2026-06-17T12:00:00+00:00"  # identical date -> same date_dir
    storage.save_episode({"id": "ep-A", "timestamp": ts, "task": "a"})
    storage.save_episode({"id": "ep-B", "timestamp": ts, "task": "b"})
    date_dir = storage.base_path / "episodic" / "2026-06-17"
    lock_path_b = date_dir / "task-ep-B.json.lock"
    return date_dir, lock_path_b


def test_delete_episode_does_not_unlink_a_held_lock() -> None:
    """
    A lock held by a concurrent writer of a DIFFERENT episode in the same date
    dir must survive delete_episode of another episode.

    Non-vacuity: pre-fix delete_episode unconditionally unlinked every *.lock
    in the date dir. We acquire a real flock on episode B's lock (simulating a
    live writer), record its inode, then delete episode A. The assertion that
    the lock path still exists AND keeps the SAME inode fails on the pre-fix
    code (the inode is unlinked, then absent or replaced) and passes after the
    probe-gated fix.
    """
    with tempfile.TemporaryDirectory() as tmp:
        storage = _new_storage(tmp)
        date_dir, lock_path_b = _save_two_episodes_same_date(storage)

        # Simulate a concurrent writer of episode B holding its lock.
        holder = open(lock_path_b, "w")
        try:
            fcntl.flock(holder.fileno(), fcntl.LOCK_EX)
            inode_before = os.fstat(holder.fileno()).st_ino

            # Delete a DIFFERENT episode in the same date dir.
            assert storage.delete_episode("ep-A") is True

            # The held lock must still be present at the same inode: nobody
            # may have unlinked it out from under the live holder.
            assert lock_path_b.exists(), (
                "held lock was unlinked by delete_episode (inode-replacement "
                "race): a concurrent writer of ep-B could be displaced"
            )
            inode_after = os.stat(lock_path_b).st_ino
            assert inode_after == inode_before, (
                "held lock inode changed (was unlinked + recreated): the live "
                f"holder no longer guards the path (before={inode_before}, "
                f"after={inode_after})"
            )
        finally:
            try:
                fcntl.flock(holder.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            holder.close()


def test_delete_episode_still_gcs_an_unheld_lock() -> None:
    """
    A free (unheld) leftover lock in the date dir is still cleaned up, so the
    empty-dir collapse keeps working when nothing is in use.

    Non-vacuity: we leave a stray, unlocked task-ep-B.json.lock behind, delete
    the only real episode, and assert the stray lock is gone afterwards. If the
    fix had simply removed the cleanup loop entirely this would fail.
    """
    with tempfile.TemporaryDirectory() as tmp:
        storage = _new_storage(tmp)
        date_dir, lock_path_b = _save_two_episodes_same_date(storage)

        # ep-B is just data here; drop its file but leave a stray, UNHELD lock.
        (date_dir / "task-ep-B.json").unlink()
        lock_path_b.write_text("")  # create lock file, hold nothing
        assert lock_path_b.exists()

        assert storage.delete_episode("ep-A") is True

        assert not lock_path_b.exists(), (
            "an unheld leftover lock was not GC'd by delete_episode"
        )


if __name__ == "__main__":
    test_delete_episode_does_not_unlink_a_held_lock()
    test_delete_episode_still_gcs_an_unheld_lock()
    print("OK: delete_episode lock-race tests passed")
