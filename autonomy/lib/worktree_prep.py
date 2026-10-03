#!/usr/bin/env python3
"""Shared worktree substrate (D51 Phase B, D61 slice 7).

prepare_worktree() creates a git worktree for a run from a clean start point,
never carrying the source checkout's uncommitted edits, and prepares
dependencies (setup command, else copy-on-write copy of ignored dep dirs).
"""

import fcntl
import json
import os
import re
import subprocess
import sys
import time

DEP_DIRS = ("node_modules", ".venv", "venv", "vendor")


def _git(repo, *args, check=True):
    return subprocess.run(
        ["git", "-C", repo, *args], capture_output=True, text=True, check=check
    )


def _slug(repo):
    real = os.path.realpath(repo)
    return re.sub(r"[^A-Za-z0-9._-]+", "-", real).strip("-")[-120:] or "repo"


def _lock_path(repo):
    d = os.path.join(os.path.expanduser("~"), ".loki", "repos")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, _slug(repo) + ".lock")


def _start_point(repo, base):
    if base:
        return base
    if _git(repo, "remote", check=False).stdout.strip():
        _git(repo, "fetch", "--quiet", check=False)
    for ref in ("origin/HEAD", "HEAD"):
        probe = _git(repo, "rev-parse", "--verify", "--quiet", ref + "^{commit}", check=False)
        if probe.returncode == 0:
            return ref
    raise RuntimeError("no start point: repository has no commits")


def _left_out_changes(repo):
    out = _git(repo, "status", "--porcelain", check=False).stdout
    return len([line for line in out.splitlines() if line.strip()])


def _cow_copy(src, dst):
    if sys.platform == "darwin":
        cmds = [["cp", "-c", "-R", src, dst]]
    else:
        cmds = [["cp", "-R", "--reflink=auto", src, dst]]
    cmds.append(["cp", "-R", src, dst])
    for cmd in cmds:
        if os.path.lexists(dst):
            subprocess.run(["rm", "-rf", dst], check=False)
        if subprocess.run(cmd, capture_output=True).returncode == 0:
            return True
    return False


def _escapes_source(path):
    """True if a dep dir links or points outside itself.

    Flags absolute symlinks, relative symlinks resolving outside the dep dir,
    editable finders, and bin/* scripts whose shebang names the source path.
    """
    base = os.path.realpath(path)
    sources = {os.path.dirname(base).encode(), os.path.dirname(os.path.abspath(path)).encode()}
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            p = os.path.join(root, name)
            if os.path.islink(p):
                target = os.readlink(p)
                if os.path.isabs(target):
                    return True
                real = os.path.realpath(os.path.join(root, target))
                if real != base and not real.startswith(base + os.sep):
                    return True
            elif name.endswith(".pth") or name.startswith("__editable__"):
                return True
        if os.path.basename(root) == "bin":
            for name in files:
                p = os.path.join(root, name)
                if os.path.islink(p):
                    continue
                try:
                    with open(p, "rb") as f:
                        first = f.readline(4096)
                except OSError:
                    continue
                if first.startswith(b"#!") and any(x in first for x in sources):
                    return True
    return False


def _lock_timeout():
    try:
        return float(os.environ.get("LOKI_PREP_LOCK_TIMEOUT", "120"))
    except ValueError:
        return 120.0


def _acquire_lock(lock):
    deadline = time.monotonic() + _lock_timeout()
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise RuntimeError("FAILED: lock contention")
            time.sleep(0.1)


def _copy_deps(source, dest, start):
    copied = 0
    for name in DEP_DIRS:
        s = os.path.join(source, name)
        if not os.path.isdir(s) or os.path.islink(s):
            continue
        if _git(source, "check-ignore", "-q", name + "/", check=False).returncode != 0:
            continue
        if _git(source, "ls-tree", "-d", start, name, check=False).stdout.strip():
            continue
        if _escapes_source(s):
            raise RuntimeError("deps: copy unsafe, declare setup")
        if not _cow_copy(s, os.path.join(dest, name)):
            raise RuntimeError("deps: copy failed, declare setup")
        copied += 1
    return copied


def prepare_worktree(source_repo, dest, branch, setup=None, base=None):
    source_repo = os.path.abspath(source_repo)
    dest = os.path.abspath(dest)
    lock = open(_lock_path(source_repo), "w")
    try:
        _acquire_lock(lock)
        left_out = _left_out_changes(source_repo)
        start = _start_point(source_repo, base)
        base_sha = _git(source_repo, "rev-parse", start + "^{commit}").stdout.strip()
        _git(source_repo, "worktree", "add", "-b", branch, dest, base_sha)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()

    deps = "none"
    if setup:
        r = subprocess.run(setup, shell=True, cwd=dest)
        if r.returncode != 0:
            raise RuntimeError("deps: setup command failed (exit %d)" % r.returncode)
        deps = "setup"
    elif _copy_deps(source_repo, dest, base_sha):
        deps = "cow" if sys.platform in ("darwin", "linux") else "copy"
    return {"path": dest, "base_sha": base_sha, "deps": deps, "left_out_changes": left_out}


def main(argv=None):
    import argparse

    p = argparse.ArgumentParser(description="Prepare an isolated git worktree")
    p.add_argument("source")
    p.add_argument("dest")
    p.add_argument("branch")
    p.add_argument("--setup", default=None)
    p.add_argument("--base", default=None)
    a = p.parse_args(argv)
    try:
        res = prepare_worktree(a.source, a.dest, a.branch, a.setup, a.base)
    except (RuntimeError, subprocess.CalledProcessError) as e:
        print(json.dumps({"error": str(e)}))
        return 1
    print(json.dumps(res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
