#!/usr/bin/env python3
"""V2 (A3 extension): sync + hydrate of git refs/loki/cp/* worktree snapshots via
git bundles to the object store. Uses a LocalStore-rooted temp dir as the S3
stand-in and a real throwaway git repo, so it runs anywhere with git installed.

Verifies the round trip:
  1. create a checkpoint snapshot (git stash create + refs/loki/cp/<id>)
  2. cmd_sync exports the snapshot as a bundle to the remote store
  3. drop the local ref AND gc the commit (simulate a fresh node)
  4. cmd_hydrate fetches the bundle and re-creates refs/loki/cp/<id> at the SHA
"""
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "autonomy", "lib"))

_ENV_KEYS = (
    "LOKI_DIR", "TARGET_DIR", "LOKI_STORAGE_BACKEND", "LOKI_RUN_ID",
    "LOKI_SESSION_ID",
)
_SNAP = {k: os.environ.get(k) for k in _ENV_KEYS}


def _restore_env():
    for k, v in _SNAP.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


passed = 0
failed = 0


def check(cond, msg):
    global passed, failed
    if cond:
        print(f"PASS: {msg}")
        passed += 1
    else:
        print(f"FAIL: {msg}")
        failed += 1


def git(args, cwd, **kw):
    return subprocess.run(
        ["git", *args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, check=False, **kw,
    )


def _have_git():
    try:
        return subprocess.run(
            ["git", "--version"], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, check=False,
        ).returncode == 0
    except OSError:
        return False


def main():
    if not _have_git():
        print("SKIP: git not available")
        return 0

    work = os.path.realpath(tempfile.mkdtemp(prefix="loki-v2-bundle-"))
    project = os.path.join(work, "project")
    loki_dir = os.path.join(project, ".loki")
    remote_dir = os.path.join(work, "objectstore")
    os.makedirs(loki_dir, exist_ok=True)
    os.makedirs(remote_dir, exist_ok=True)

    # --- a real git repo with one commit + an uncommitted tracked change ---
    git(["init", "-q"], project)
    git(["config", "user.email", "t@t"], project)
    git(["config", "user.name", "t"], project)
    with open(os.path.join(project, "f.txt"), "w") as f:
        f.write("base\n")
    git(["add", "f.txt"], project)
    git(["commit", "-qm", "base"], project)
    # uncommitted tracked change -> this is what the snapshot must preserve
    with open(os.path.join(project, "f.txt"), "w") as f:
        f.write("WORKTREE-CHANGE\n")

    # --- create the snapshot exactly like create_checkpoint does ---
    snap = git(["stash", "create", "loki cp test"], project).stdout.strip()
    check(bool(snap), "git stash create produced a snapshot SHA")
    cp_id = "cp-1-1700000000"
    git(["update-ref", f"refs/loki/cp/{cp_id}", snap], project)
    # write the checkpoint dir + worktree-snapshot.txt the sync reads
    cp_dir = os.path.join(loki_dir, "state", "checkpoints", cp_id)
    os.makedirs(cp_dir, exist_ok=True)
    with open(os.path.join(cp_dir, "metadata.json"), "w") as f:
        f.write('{"id":"%s","iteration":1}' % cp_id)
    with open(os.path.join(cp_dir, "worktree-snapshot.txt"), "w") as f:
        f.write(snap + "\n")

    # --- point the shim at our temp dirs + a non-local backend ---
    os.environ["LOKI_DIR"] = loki_dir
    os.environ["TARGET_DIR"] = project
    os.environ["LOKI_STORAGE_BACKEND"] = "s3"
    os.environ["LOKI_RUN_ID"] = "run-v2"

    import checkpoint_sync as cs
    cs._BACKEND = "s3"
    from lokistore import build_store
    remote_store = build_store({"backend": "local", "base_dir": remote_dir})
    cs._get_store = lambda: remote_store

    # --- SYNC: bundle should land in the store ---
    rc = cs.cmd_sync()
    check(rc == 0, "cmd_sync returns 0")
    bundle_keys = remote_store.list("runs/run-v2/worktree-bundles/")
    check(
        any(k.endswith(f"{cp_id}.bundle") for k in bundle_keys),
        "worktree bundle present in the object store",
    )
    check(
        any(k.endswith(f"{cp_id}.sha") for k in bundle_keys),
        "snapshot SHA sidecar present in the object store",
    )

    # --- simulate a FRESH node: drop the ref + prune the commit locally ---
    git(["update-ref", "-d", f"refs/loki/cp/{cp_id}"], project)
    git(["stash", "clear"], project)
    git(["reflog", "expire", "--expire=now", "--all"], project)
    git(["gc", "--prune=now", "--quiet"], project)
    gone = git(["cat-file", "-e", f"{snap}^{{commit}}"], project).returncode != 0
    check(gone, "snapshot commit is gone locally (simulated fresh node)")
    # also wipe local checkpoints so hydrate proceeds
    shutil.rmtree(os.path.join(loki_dir, "state", "checkpoints"))

    # --- HYDRATE: ref + commit must come back ---
    rc = cs.cmd_hydrate()
    check(rc == 0, "cmd_hydrate returns 0")
    back = git(["rev-parse", "--verify", "--quiet", f"refs/loki/cp/{cp_id}"], project)
    check(
        back.returncode == 0 and back.stdout.strip() == snap,
        "refs/loki/cp/<id> restored at the exact snapshot SHA",
    )
    # the snapshot commit's tree must contain the worktree change we stashed
    show = git(["show", f"{snap}:f.txt"], project)
    check(
        show.returncode == 0 and "WORKTREE-CHANGE" in show.stdout,
        "restored snapshot preserves the uncommitted worktree change",
    )

    # --- ref-injection guard: a bundle id with unsafe chars must be skipped ---
    # (LocalStore blocks ../ at put; a real S3 backend allows arbitrary keys, so
    # hydrate itself must defend. Use a unsafe-but-store-legal id to exercise the
    # _SAFE_CP_CHARS guard, with a fresh local checkpoint dir cleared so hydrate
    # proceeds.)
    shutil.rmtree(os.path.join(loki_dir, "state", "checkpoints"), ignore_errors=True)

    class _FakeStore:
        _keys = {
            "runs/run-v2/state/checkpoints/x/metadata.json": b"{}",
            "runs/run-v2/worktree-bundles/evil;rm -rf.bundle": b"PWN",
            "runs/run-v2/worktree-bundles/evil;rm -rf.sha":
                b"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n",
        }

        def list(self, prefix=""):
            return [k for k in self._keys if k.startswith(prefix)]

        def get(self, key):
            return self._keys[key]

        def get_to(self, key, dest):
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(self._keys[key])

    cs._get_store = lambda: _FakeStore()
    refs_before = git(["for-each-ref", "refs/loki/cp/"], project).stdout
    rc = cs.cmd_hydrate()
    refs_after = git(["for-each-ref", "refs/loki/cp/"], project).stdout
    check(rc == 0, "cmd_hydrate stays best-effort with an unsafe bundle id")
    check(
        refs_before == refs_after,
        "unsafe bundle id created NO ref (ref-injection guard held)",
    )

    shutil.rmtree(work, ignore_errors=True)
    _restore_env()
    print(f"\nV2 RESULTS: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
else:
    _rc = main()
    assert _rc == 0, "V2 worktree-bundle sync: failures"
