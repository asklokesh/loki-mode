#!/usr/bin/env python3
"""
A3: object-store checkpoint sync shim for run.sh.

This is the thin bridge between run.sh (bash) and the LokiStore object-store
backends (S3 / GCS / Azure). It is invoked ONLY when LOKI_STORAGE_BACKEND is set
to a non-local backend; when the backend is local/unset, run.sh never calls this
and behavior is unchanged.

Honest scope
------------
- This syncs the lightweight checkpoint state (.loki/state/checkpoints/**) to the
  configured object store, and hydrates it back on a durable resume when the
  local volume came up empty. It does NOT sync the git refs/loki/cp/* worktree
  snapshots (those live in .git, not .loki, and are out of LokiStore's root);
  the checkpoint metadata + .loki snapshot are what this transfers.
- All operations are best-effort. A sync/hydrate error never raises to the
  caller's control flow (run.sh treats a nonzero exit as "skip, continue").
  The bash side logs and continues a build on any failure.

Run identity
------------
Object-store keys are namespaced per run so concurrent / sequential runs do not
overwrite each other:  runs/<run-id>/state/checkpoints/<...>
The run-id resolves from (first set wins): LOKI_RUN_ID, LOKI_SESSION_ID, or the
persisted trust-run-id at .loki/state/trust-run-id. For a durable resume on a
FRESH volume to find its prior checkpoints, the operator MUST provide a STABLE
id across pod restarts (set LOKI_RUN_ID or LOKI_SESSION_ID on the Job); the
minted trust-run-id is per-process and will not match after a restart.

Usage
-----
    checkpoint_sync.py sync     # push local .loki/state/checkpoints/** to store
    checkpoint_sync.py hydrate  # pull store -> local IF local checkpoints empty

Exit codes: 0 on success (including "nothing to do"); nonzero on any error
(caller ignores it and continues).
"""

from __future__ import annotations

import os
import sys

# Local-first guard: this shim is only meaningful for a non-local backend. If the
# backend is local/unset, do nothing (run.sh should not even call us, but be
# defensive so a stray call is a no-op rather than a needless local copy).
_BACKEND = (os.environ.get("LOKI_STORAGE_BACKEND") or "local").strip().lower()

# The subtree of the .loki/ store that holds checkpoint state.
_CHECKPOINT_PREFIX = "state/checkpoints/"


def _resolve_run_id() -> str:
    """Resolve the per-run key namespace component (see module docstring)."""
    for env_name in ("LOKI_RUN_ID", "LOKI_SESSION_ID"):
        val = os.environ.get(env_name)
        if val and val.strip():
            return val.strip()
    # Fall back to the persisted trust-run-id on the local volume.
    loki_dir = os.environ.get("LOKI_DIR") or os.path.join(
        os.environ.get("TARGET_DIR", "."), ".loki"
    )
    id_file = os.path.join(loki_dir, "state", "trust-run-id")
    try:
        with open(id_file, "r", encoding="utf-8") as f:
            persisted = f.read().strip()
            if persisted:
                return persisted
    except OSError:
        pass
    return "default"


def _run_key(run_id: str, store_subkey: str) -> str:
    """Build the object-store key for a checkpoint subkey under this run."""
    return f"runs/{run_id}/{store_subkey}"


def _get_store():
    """Import + construct the configured store. Raises on backend/SDK error."""
    # Make the repo root importable so `import lokistore` works regardless of cwd.
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(here, os.pardir, os.pardir))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    from lokistore import get_store  # noqa: E402

    return get_store()


def _local_store():
    """A LocalStore rooted at the project .loki/ for reading/writing local keys."""
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.abspath(os.path.join(here, os.pardir, os.pardir))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    from lokistore import build_store  # noqa: E402

    return build_store({"backend": "local"})


def cmd_sync() -> int:
    """Push local checkpoint state to the object store under this run's prefix."""
    if _BACKEND in ("local", "", "file", "filesystem"):
        return 0  # no-op for local backend

    run_id = _resolve_run_id()
    local = _local_store()
    remote = _get_store()

    keys = local.list(_CHECKPOINT_PREFIX)
    if not keys:
        return 0  # nothing to sync yet

    count = 0
    for subkey in keys:
        data = local.get(subkey)
        remote.put(_run_key(run_id, subkey), data)
        count += 1
    sys.stderr.write(
        f"[checkpoint-sync] pushed {count} checkpoint object(s) to "
        f"{_BACKEND} under runs/{run_id}/\n"
    )
    return 0


def cmd_hydrate() -> int:
    """
    Pull checkpoint state from the object store into the local volume, but ONLY
    when the local checkpoint state is empty (a fresh volume). If the local
    volume already has checkpoints, do nothing (the local copy wins; we never
    clobber a live volume).
    """
    if _BACKEND in ("local", "", "file", "filesystem"):
        return 0  # no-op for local backend

    local = _local_store()
    # Guard: never overwrite a non-empty local volume.
    if local.list(_CHECKPOINT_PREFIX):
        return 0

    run_id = _resolve_run_id()
    remote = _get_store()
    remote_prefix = _run_key(run_id, _CHECKPOINT_PREFIX)
    remote_keys = remote.list(remote_prefix)
    if not remote_keys:
        return 0  # store has nothing for this run; fall through to normal flow

    loki_dir = os.environ.get("LOKI_DIR") or os.path.join(
        os.environ.get("TARGET_DIR", "."), ".loki"
    )
    strip = f"runs/{run_id}/"
    loki_dir_real = os.path.realpath(loki_dir)
    count = 0
    for rk in remote_keys:
        if not rk.startswith(strip):
            continue
        local_subkey = rk[len(strip):]  # e.g. state/checkpoints/cp-1/metadata.json
        dest = os.path.join(loki_dir, *local_subkey.split("/"))
        # Path-traversal guard: a malicious/buggy store key with ../ could make
        # dest escape loki_dir. Skip + log anything that does not stay inside.
        if not os.path.realpath(dest).startswith(loki_dir_real + os.sep):
            sys.stderr.write(f"[checkpoint-sync] skipped out-of-tree key: {rk}\n")
            continue
        remote.get_to(rk, dest)
        count += 1
    sys.stderr.write(
        f"[checkpoint-sync] hydrated {count} checkpoint object(s) from "
        f"{_BACKEND} for runs/{run_id}/\n"
    )
    return 0


def main(argv) -> int:
    if len(argv) < 2 or argv[1] not in ("sync", "hydrate"):
        sys.stderr.write("usage: checkpoint_sync.py {sync|hydrate}\n")
        return 2
    try:
        if argv[1] == "sync":
            return cmd_sync()
        return cmd_hydrate()
    except Exception as exc:  # best-effort: never break the build
        sys.stderr.write(f"[checkpoint-sync] {argv[1]} skipped: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
