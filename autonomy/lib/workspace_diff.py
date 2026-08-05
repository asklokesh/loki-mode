#!/usr/bin/env python3
"""Final-worktree diff facts shared by proof generation and verification."""

from __future__ import annotations

import os
import subprocess


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
    for path in sorted(p for p in (untracked or "").split("\0") if p and not _excluded(p)):
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


__all__ = ["collect_workspace_diff"]
