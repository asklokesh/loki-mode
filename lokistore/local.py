"""
LocalStore: the default, always-available, zero-dependency LokiStore backend.

Backed by a base directory (the project `.loki/` by default). Behavior is
byte-identical to today's direct `.loki/` file writes:

- Atomic writes via a temp file in the same directory + os.replace (an atomic
  rename on the same filesystem), so a reader never sees a torn file.
- Best-effort fcntl advisory locking for concurrent writers of the same key,
  reentrant per-thread to avoid self-deadlock, using PERSISTENT lock files
  (never unlinked on release) to avoid the flock+unlink inode-replacement race
  documented in memory/storage.py.
- Path-traversal guard: a key can never escape the base directory.

This mirrors the house idiom in memory/storage.py and dashboard/registry.py so
local users get exactly the durability they have today, with no new deps.
"""

from __future__ import annotations

import contextlib
import os
import tempfile
import threading
from pathlib import Path
from typing import List, Union

from .base import LokiStore, normalize_key, read_source_bytes

try:
    import fcntl  # POSIX only; absent on Windows
except ImportError:  # pragma: no cover - exercised only on Windows
    fcntl = None  # type: ignore[assignment]


class LocalStore(LokiStore):
    """Filesystem-backed LokiStore rooted at a base directory."""

    def __init__(self, base_dir: Union[str, os.PathLike]):
        """
        Args:
            base_dir: Root directory for all keys. Created on first write.
                      Typically the project `.loki/` directory; the factory
                      resolves this honoring LOKI_DIR / TARGET_DIR.
        """
        self._base = Path(base_dir).expanduser()
        # Reentrant lock tracking, mirroring memory/storage.py: a thread that
        # already holds the lock for a path skips re-acquiring it, so nested
        # operations on the same key do not deadlock.
        self._held_locks: threading.local = threading.local()

    @property
    def base_dir(self) -> Path:
        """The resolved root directory for this store."""
        return self._base

    # -- internal helpers ---------------------------------------------------

    def _resolve(self, key: str) -> Path:
        """
        Map a normalized key to an absolute path inside the base dir, with a
        realpath-based defense in depth so even a symlink inside the base
        cannot redirect a read or write outside it.
        """
        clean = normalize_key(key)
        full = self._base / clean

        real_base = os.path.realpath(self._base)

        def _under_base(real_path: str) -> bool:
            return real_path == real_base or real_path.startswith(
                real_base + os.sep
            )

        # Guard the parent so a key can never be created outside the base, even
        # when the target itself does not exist yet (the write path).
        real_parent = os.path.realpath(full.parent)
        if not _under_base(real_parent):
            raise ValueError(f"key escapes store base directory: {key!r}")

        # Guard the full target too: a leaf symlink placed AT the key path and
        # pointing outside the base would otherwise be followed on read
        # (get/get_to/exists), leaking an arbitrary file. realpath resolves the
        # leaf symlink, so a target whose real location is outside the base is
        # rejected. This is a no-op for ordinary files and for not-yet-existing
        # keys (whose realpath stays inside the already-checked parent).
        real_full = os.path.realpath(full)
        if not _under_base(real_full):
            raise ValueError(f"key escapes store base directory: {key!r}")

        return full

    @contextlib.contextmanager
    def _file_lock(self, path: Path):
        """
        Reentrant, best-effort exclusive advisory lock around a single key's
        write. Uses a persistent sibling ".lock" file (never unlinked on
        release) to avoid the flock+unlink inode race. Degrades to a no-op
        where fcntl is unavailable (Windows); the atomic rename still
        guarantees no torn reads, only lost-update protection is best-effort.
        """
        lock_path = path.with_suffix(path.suffix + ".lock")
        lock_key = str(lock_path)

        if not hasattr(self._held_locks, "paths"):
            self._held_locks.paths = set()

        # Reentrant: this thread already holds it -> no-op.
        if lock_key in self._held_locks.paths:
            yield
            return

        if fcntl is None:
            # No advisory locking available; proceed (atomic rename still safe).
            yield
            return

        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_file = None
        try:
            lock_file = open(lock_path, "w")
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            self._held_locks.paths.add(lock_key)
            yield
        finally:
            self._held_locks.paths.discard(lock_key)
            if lock_file is not None:
                try:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                finally:
                    lock_file.close()
                # Deliberately do NOT unlink the lock file (see module
                # docstring and memory/storage.py for the inode-race rationale).

    def _atomic_write_bytes(self, path: Path, payload: bytes) -> None:
        """Write payload to path atomically (temp in same dir + os.replace)."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._file_lock(path):
            fd, tmp_path = tempfile.mkstemp(
                dir=str(path.parent), prefix=".tmp_", suffix=".part"
            )
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(payload)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp_path, str(path))
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp_path)
                raise

    # -- LokiStore interface ------------------------------------------------

    def put(self, key: str, data: Union[bytes, bytearray, str, os.PathLike]) -> None:
        payload = read_source_bytes(data)
        path = self._resolve(key)
        self._atomic_write_bytes(path, payload)

    def get(self, key: str) -> bytes:
        path = self._resolve(key)
        if not path.is_file():
            raise FileNotFoundError(f"no such key: {key!r}")
        with self._file_lock(path):
            with open(path, "rb") as f:
                return f.read()

    def get_to(self, key: str, dest_path: Union[str, os.PathLike]) -> None:
        payload = self.get(key)
        dest = Path(dest_path).expanduser()
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Reuse the atomic-write helper so the destination is never torn.
        self._atomic_write_bytes(dest, payload)

    def exists(self, key: str) -> bool:
        return self._resolve(key).is_file()

    def list(self, prefix: str = "") -> List[str]:
        # Normalize the prefix to a path under the base. An empty prefix lists
        # everything under the base.
        #
        # Walk the realpath of the base consistently with how relpath is taken
        # below. If the base is reached through a symlink (macOS /tmp ->
        # /private/tmp, k8s bind mounts, a symlinked LOKI_DIR), walking the
        # symlink path while computing relpath against the realpath would emit
        # "../../.." garbage keys that downstream sync then rejects as path
        # traversal -- silently breaking the whole object-store sync.
        real_base = os.path.realpath(self._base)
        if prefix:
            clean_prefix = normalize_key(prefix)
            search_root = Path(real_base) / clean_prefix
        else:
            search_root = Path(real_base)

        if not search_root.exists():
            return []

        base_str = real_base
        results: List[str] = []

        if search_root.is_file():
            # Prefix pointed directly at a key.
            rel = os.path.relpath(str(search_root), base_str).replace(os.sep, "/")
            return [rel]

        for root, _dirs, files in os.walk(search_root):
            for name in files:
                full = os.path.join(root, name)
                # Skip internal lock and temp files so they never surface as keys.
                if name.endswith(".lock") or name.startswith(".tmp_"):
                    continue
                rel = os.path.relpath(full, base_str).replace(os.sep, "/")
                results.append(rel)

        results.sort()
        return results

    def delete(self, key: str) -> bool:
        path = self._resolve(key)
        if not path.is_file():
            return False
        with self._file_lock(path):
            try:
                os.unlink(path)
                return True
            except FileNotFoundError:
                return False
