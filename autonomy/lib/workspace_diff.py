#!/usr/bin/env python3
"""Final-worktree diff facts shared by proof generation and verification."""

from __future__ import annotations

import hashlib
import os
import stat as _stat
import subprocess
import sys


_EMPTY = {"count": 0, "insertions": 0, "deletions": 0, "files": []}


def _git(repo_dir, args, allowed=(0,)):
    try:
        result = subprocess.run(
            ["git", "-C", repo_dir] + args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="surrogateescape",
            timeout=30,
        )
    except Exception:
        return None
    return result.stdout if result.returncode in allowed else None


def _excluded(path):
    return path == ".loki" or path.startswith(".loki/")


# Written by run.sh setup_agent_branch (_loki_snapshot_preexisting): the paths
# git did not track when the session started, untracked and gitignored,
# NUL-delimited and relative to the repo top. An entry ending in "/" is an
# ignored directory and covers its subtree. The sibling holds "<sha256> <path>"
# records, one per file entry, written by write_snapshot_hashes below.
_SNAPSHOT = "preexisting-untracked.z"
_SNAPSHOT_HASHES = "preexisting-untracked.sha.z"


def _content_hash(path):
    """sha256 of a regular file's bytes or a symlink's target, else None.

    The snapshot writer and the receipt reader both call this, so the two sides
    always agree (git hash-object varies with filters and object format).
    """
    try:
        st = os.lstat(path)
        digest = hashlib.sha256()
        if _stat.S_ISLNK(st.st_mode):
            digest.update(b"link\0" + os.fsencode(os.readlink(path)))
        elif _stat.S_ISREG(st.st_mode):
            with open(path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    digest.update(chunk)
        else:
            return None
        return digest.hexdigest()
    except OSError:
        return None


def write_snapshot_hashes(top, snapshot):
    """Record a content hash for every file entry of ``snapshot`` that exists
    now (a directory entry or a missing path gets none), atomically, into the
    sibling hashes file."""
    with open(snapshot, "rb") as fh:
        raw = fh.read()
    top_b = os.fsencode(top)
    records = []
    for path in raw.split(b"\0"):
        if not path or path.endswith(b"/"):
            continue
        digest = _content_hash(os.path.join(top_b, path))
        if digest:
            records.append(digest.encode("ascii") + b" " + path + b"\0")
    dest = os.path.join(os.path.dirname(snapshot), _SNAPSHOT_HASHES)
    with open(dest + ".tmp", "wb") as fh:
        fh.write(b"".join(records))
    os.replace(dest + ".tmp", dest)


def _preexisting_untracked(repo_dir):
    """The session-start snapshot: (prefix of repo_dir inside the repo, set of
    repo-top-relative paths, {path: content hash}). Those paths are not this
    run's work, so the receipt lists one only when its content changed;
    tree_sha256 still binds their bytes. Empty when absent."""
    state = os.path.join(repo_dir, ".loki", "state")
    try:
        with open(os.path.join(state, _SNAPSHOT), "rb") as fh:
            raw = fh.read()
    except OSError:
        return "", frozenset(), {}
    paths = frozenset(p.decode("utf-8", "surrogateescape") for p in raw.split(b"\0") if p)
    hashes = {}
    try:
        with open(os.path.join(state, _SNAPSHOT_HASHES), "rb") as fh:
            raw = fh.read()
    except OSError:
        raw = b""
    for record in raw.split(b"\0"):
        digest, sep, path = record.partition(b" ")
        if sep:
            hashes[path.decode("utf-8", "surrogateescape")] = digest.decode("ascii", "replace")
    return (_git(repo_dir, ["rev-parse", "--show-prefix"]) or "").strip(), paths, hashes


def _covered(key, paths):
    """True when ``key`` or one of its parent directories ("a/", "a/b/") is in
    ``paths``: an ignored directory entry covers everything below it."""
    if key in paths:
        return True
    cut = key.find("/")
    while cut != -1:
        if key[:cut + 1] in paths:
            return True
        cut = key.find("/", cut + 1)
    return False


def _parse_numstat(raw):
    files = []
    for record in (raw or "").split("\0"):
        if not record:
            continue
        parts = record.split("\t", 2)
        if len(parts) != 3 or _excluded(parts[2]):
            continue
        ins_s, del_s, path = parts
        files.append({
            "path": path,
            "insertions": 0 if ins_s == "-" else int(ins_s),
            "deletions": 0 if del_s == "-" else int(del_s),
            "status": "binary" if ins_s == "-" else "modified",
        })
    return files


def _split_patch(raw):
    chunks = []
    current = []
    for line in (raw or "").splitlines(keepends=True):
        if line.startswith("diff --git ") and current:
            chunks.append("".join(current))
            current = [line]
        else:
            current.append(line)
    if current:
        chunks.append("".join(current))
    return chunks


def collect_workspace_diff(repo_dir, base, include_diffs=False):
    """Describe final tracked and untracked bytes relative to ``base``.

    ``git diff <base>`` compares the base tree to the final working tree, so a
    single result covers committed, staged, unstaged, and deleted tracked
    files without double counting. Git omits untracked files, which are added
    explicitly. Harness-owned ``.loki`` state is never product work.
    """
    if _git(repo_dir, ["rev-parse", "--is-inside-work-tree"]) is None:
        return dict(_EMPTY), None

    comparison = base or "HEAD~1"
    raw = _git(repo_dir, ["diff", "--no-renames", "--numstat", "-z", comparison, "--"])
    if raw is None:
        # HEAD~1 is unusable (single-commit or empty repo). Fall back to the
        # EMPTY TREE, not to a bare "HEAD".
        #
        # A bare "HEAD" compares HEAD to the working tree, so it sees only
        # UNCOMMITTED changes and silently drops everything the run committed.
        # Measured on a real greenfield run: bare HEAD reported 5 files where
        # the truth was 9. The empty tree yields "everything that now exists",
        # which is the correct answer when no earlier commit exists to diff
        # against -- and it agrees with HEAD~1 on runs where both are valid.
        empty_tree = _git(repo_dir, ["hash-object", "-t", "tree", os.devnull])
        if empty_tree:
            comparison = empty_tree.strip()
            raw = _git(repo_dir, ["diff", "--no-renames", "--numstat", "-z", comparison, "--"])
    if raw is None:
        # Last resort: worktree-only. Undercounts a run that committed its work,
        # so it is reached only when even the empty-tree diff failed.
        comparison = "HEAD"
        raw = _git(repo_dir, ["diff", "--no-renames", "--numstat", "-z", comparison, "--"])
    if raw is None:
        return dict(_EMPTY), None

    files = _parse_numstat(raw)
    diffs = [] if include_diffs else None
    if diffs is not None:
        patch = _git(repo_dir, ["diff", "--no-renames", comparison, "--"])
        for chunk in _split_patch(patch):
            first = chunk.splitlines()[0] if chunk else ""
            path = first.split(" b/", 1)[1] if " b/" in first else ""
            if not _excluded(path):
                diffs.append({"path": path, "patch": chunk})

    untracked = _git(repo_dir, ["ls-files", "--others", "--exclude-standard", "-z"])
    prefix, preexisting, hashes = _preexisting_untracked(repo_dir)
    for path in sorted(p for p in (untracked or "").split("\0") if p and not _excluded(p)):
        key = prefix + path
        if _covered(key, preexisting):
            # The user's file, never committed. Listed only when the run changed
            # it, with no counts and no patch: the old bytes were never stored,
            # and its content (a config.local.json the agent un-ignored) must
            # not land in the receipt.
            recorded = hashes.get(key)
            if recorded and _content_hash(os.path.join(repo_dir, path)) != recorded:
                files.append({"path": path, "insertions": 0, "deletions": 0,
                              "status": "preexisting_modified"})
            continue
        stat = _git(
            repo_dir,
            ["diff", "--no-index", "--no-renames", "--numstat", "-z", "--", "/dev/null", path],
            allowed=(0, 1),
        )
        parsed = _parse_numstat(stat)
        entry = parsed[0] if parsed else {
            "path": path, "insertions": 0, "deletions": 0, "status": "untracked"
        }
        entry["path"] = path
        entry["status"] = "untracked_binary" if entry["status"] == "binary" else "untracked"
        files.append(entry)
        if diffs is not None:
            patch = _git(
                repo_dir,
                ["diff", "--no-index", "--no-renames", "--", "/dev/null", path],
                allowed=(0, 1),
            )
            if patch:
                diffs.append({"path": path, "patch": patch})

    files.sort(key=lambda item: item["path"])
    return {
        "count": len(files),
        "insertions": sum(item["insertions"] for item in files),
        "deletions": sum(item["deletions"] for item in files),
        "files": files,
    }, diffs


__all__ = ["collect_workspace_diff", "write_snapshot_hashes"]


if __name__ == "__main__":
    # run.sh: python3 -E workspace_diff.py hash-snapshot <repo top> <snapshot>
    if len(sys.argv) != 4 or sys.argv[1] != "hash-snapshot":
        sys.exit("usage: workspace_diff.py hash-snapshot <repo top> <snapshot>")
    write_snapshot_hashes(sys.argv[2], sys.argv[3])
