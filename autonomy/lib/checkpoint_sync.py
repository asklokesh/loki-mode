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
  local volume came up empty.
- It ALSO syncs the git refs/loki/cp/* worktree snapshots (the working-tree
  state captured by `git stash create` and anchored under refs/loki/cp/<id>).
  Those commits live in .git (outside LokiStore's .loki root), so they cannot be
  copied as plain objects; instead, for each checkpoint that carries a
  worktree-snapshot.txt SHA we export a `git bundle` of that commit to the store
  (key runs/<run-id>/worktree-bundles/<checkpoint-id>.bundle) and, on hydrate,
  `git fetch` it back and re-create the ref. This makes a fresh-node resume able
  to restore the full working tree, not just the .loki metadata. Best-effort and
  gated on git being present; a repo without git or without snapshots simply
  skips this part. Honest remaining limit: snapshots capture TRACKED changes only
  (the same limit as create_checkpoint's `git stash create`).
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
import subprocess
import sys
import tempfile

# Local-first guard: this shim is only meaningful for a non-local backend. If the
# backend is local/unset, do nothing (run.sh should not even call us, but be
# defensive so a stray call is a no-op rather than a needless local copy).
_BACKEND = (os.environ.get("LOKI_STORAGE_BACKEND") or "local").strip().lower()

# The subtree of the .loki/ store that holds checkpoint state.
_CHECKPOINT_PREFIX = "state/checkpoints/"
# Object-store subkey holding the git-bundle exports of refs/loki/cp/* snapshots.
_BUNDLE_SUBKEY = "worktree-bundles/"


def _project_dir() -> str:
    """The project working directory (git repo root containing .loki/)."""
    loki_dir = os.environ.get("LOKI_DIR") or os.path.join(
        os.environ.get("TARGET_DIR", "."), ".loki"
    )
    # .loki lives at <project>/.loki, so the project dir is its parent.
    return os.path.dirname(os.path.abspath(loki_dir))


def _git(args, cwd, capture=True):
    """Run a git command best-effort; return (rc, stdout). Never raises."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
        return proc.returncode, (proc.stdout or "").strip()
    except (OSError, ValueError):
        return 1, ""


def _have_git_repo(project_dir) -> bool:
    if not project_dir or not os.path.isdir(project_dir):
        return False
    rc, _ = _git(["rev-parse", "--is-inside-work-tree"], project_dir)
    return rc == 0


def _iter_checkpoint_snapshots(local):
    """Yield (checkpoint_id, snapshot_sha) for every worktree-snapshot.txt found
    in the local checkpoint store. checkpoint_id is the directory name under
    state/checkpoints/ that owns the snapshot."""
    for subkey in local.list(_CHECKPOINT_PREFIX):
        # subkey like state/checkpoints/<cp-id>/worktree-snapshot.txt
        if not subkey.endswith("/worktree-snapshot.txt"):
            continue
        parts = subkey.split("/")
        # .../checkpoints/<cp-id>/worktree-snapshot.txt -> cp-id is parts[-2]
        if len(parts) < 2:
            continue
        cp_id = parts[-2]
        try:
            sha = local.get(subkey).decode("utf-8", "replace").strip()
        except Exception:
            continue
        if sha:
            yield cp_id, sha


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

    # Also export the git refs/loki/cp/* worktree snapshots as bundles (V2).
    bundles = _sync_worktree_bundles(local, remote, run_id)
    if bundles:
        sys.stderr.write(
            f"[checkpoint-sync] pushed {bundles} worktree snapshot bundle(s)\n"
        )
    return 0


def _sync_worktree_bundles(local, remote, run_id) -> int:
    """For each checkpoint snapshot SHA, `git bundle` the commit and store it.
    Best-effort; returns the count pushed. Skips silently without git/snapshots."""
    project_dir = _project_dir()
    if not _have_git_repo(project_dir):
        return 0
    pushed = 0
    for cp_id, sha in _iter_checkpoint_snapshots(local):
        # Symmetric with hydrate: never bundle/store an unsafe cp_id ref name.
        if not _safe_cp_id(cp_id):
            sys.stderr.write(f"[checkpoint-sync] skipped unsafe snapshot id: {cp_id}\n")
            continue
        # Verify the commit still exists locally before bundling.
        rc, _ = _git(["cat-file", "-e", f"{sha}^{{commit}}"], project_dir)
        if rc != 0:
            continue
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".bundle")
        os.close(tmp_fd)
        try:
            # `git bundle create` needs a REF-style argument; a bare SHA (or a
            # single-rev `sha`/`sha~0..sha`) makes git refuse with "empty bundle"
            # because there is no ref to anchor. The snapshot is already anchored
            # at refs/loki/cp/<cp_id> by create_checkpoint, so bundle THAT ref.
            # The bundle is self-contained for the snapshot commit + its history.
            rc, _ = _git(
                ["bundle", "create", tmp_path, f"refs/loki/cp/{cp_id}"],
                project_dir,
                capture=False,
            )
            if rc != 0 or not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
                continue
            with open(tmp_path, "rb") as f:
                data = f.read()
            remote.put(_run_key(run_id, f"{_BUNDLE_SUBKEY}{cp_id}.bundle"), data)
            # Persist the SHA alongside so hydrate can re-create the exact ref.
            remote.put(
                _run_key(run_id, f"{_BUNDLE_SUBKEY}{cp_id}.sha"),
                (sha + "\n").encode("utf-8"),
            )
            pushed += 1
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    return pushed


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

    # Restore git refs/loki/cp/* worktree snapshots from their bundles (V2).
    restored = _hydrate_worktree_bundles(remote, run_id)
    if restored:
        sys.stderr.write(
            f"[checkpoint-sync] restored {restored} worktree snapshot ref(s)\n"
        )
    return 0


def _hydrate_worktree_bundles(remote, run_id) -> int:
    """Fetch each stored worktree bundle and re-create refs/loki/cp/<id>.
    Best-effort; returns the count restored. No-op without git or bundles."""
    project_dir = _project_dir()
    if not _have_git_repo(project_dir):
        return 0
    bundle_prefix = _run_key(run_id, _BUNDLE_SUBKEY)
    try:
        remote_keys = remote.list(bundle_prefix)
    except Exception:
        return 0
    restored = 0
    for rk in remote_keys:
        if not rk.endswith(".bundle"):
            continue
        cp_id = rk.rsplit("/", 1)[-1][: -len(".bundle")]
        # Guard cp_id against ref-injection (the bundle key comes from the store).
        if not _safe_cp_id(cp_id):
            sys.stderr.write(f"[checkpoint-sync] skipped unsafe bundle id: {cp_id}\n")
            continue
        # Recover the snapshot SHA (stored sidecar) so we re-create the exact ref.
        sha = ""
        try:
            sha = remote.get(_run_key(run_id, f"{_BUNDLE_SUBKEY}{cp_id}.sha")).decode(
                "utf-8", "replace"
            ).strip()
        except Exception:
            sha = ""
        if not sha or any(c not in "0123456789abcdef" for c in sha.lower()):
            continue
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".bundle")
        os.close(tmp_fd)
        try:
            remote.get_to(rk, tmp_path)
            # Fetch the commit objects out of the bundle into this repo.
            rc, _ = _git(["fetch", tmp_path, sha], project_dir, capture=False)
            if rc != 0:
                continue
            # Re-create the anchored ref so `git gc` cannot prune it and a resume
            # can find the snapshot exactly as create_checkpoint left it.
            rc, _ = _git(
                ["update-ref", f"refs/loki/cp/{cp_id}", sha], project_dir, capture=False
            )
            if rc == 0:
                restored += 1
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    return restored


# Safe characters for a checkpoint id used in a git ref path (defense vs
# ref-injection from a crafted object-store key). Checkpoint ids are of the form
# cp-<iter>-<epoch>. We do NOT rely on git's own ref-name validation as the only
# backstop (defense-in-depth): reject the git-special forms too.
_SAFE_CP_CHARS = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
)


def _safe_cp_id(cp_id: str) -> bool:
    """True iff cp_id is safe to interpolate into refs/loki/cp/<cp_id>.

    Char-allowlist PLUS explicit rejection of git-special ref forms that the
    allowlist would otherwise permit ('.', '..', a trailing dot, a '.lock'
    suffix, 'HEAD', '@'). Not exploitable today (cp ids are locally minted), but
    this must not depend on git's validation when the id can come from a store key.
    """
    if not cp_id or any(c not in _SAFE_CP_CHARS for c in cp_id):
        return False
    if cp_id in (".", "..", "HEAD", "@"):
        return False
    if cp_id.endswith(".") or cp_id.endswith(".lock"):
        return False
    return True


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
