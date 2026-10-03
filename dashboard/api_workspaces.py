"""Read-only view over multi-repo workspace runs (D51-B13r).

`loki workspace run` records one integration.json per run under
<loki_dir>/workspaces/<workspace>/<run_id>/. That file is the ONLY evidence a
run leaves (runs never produce group.json), so this reader lists and returns
exactly it.

Honesty rules:
  - A missing workspaces directory is {runs: [], reason}, never a bare empty.
  - An unreadable or corrupt integration.json is a row with state
    "unreadable" and an error. It is never dropped.
  - stale is True/False only when both the recorded head and the worktree head
    are known. A missing worktree or recorded head reads None with a reason.

Nothing here mutates a run.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from typing import Any, Optional

__all__ = ["list_runs", "get_run", "valid_name", "NotFound", "BadName"]

_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_GIT_TIMEOUT_S = 5


class BadName(ValueError):
    pass


class NotFound(LookupError):
    pass


def valid_name(name: str) -> bool:
    return bool(name) and ".." not in name and _NAME_RE.match(name) is not None


def _slug(repo: str) -> str:
    # Mirrors autonomy/lib/workspace.py _slug.
    return repo.replace("/", "__")


def _worktree_head(run_dir: str, repo: str) -> tuple:
    wt = os.path.join(run_dir, "worktrees", _slug(repo))
    if not os.path.isdir(wt):
        return None, "worktree missing"
    try:
        r = subprocess.run(["git", "-C", wt, "rev-parse", "HEAD"],
                           capture_output=True, text=True, timeout=_GIT_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, "git failed: %s" % type(exc).__name__
    if r.returncode != 0:
        return None, "git rev-parse failed"
    return r.stdout.strip(), None


def _repo_rows(run_dir: str, ev: dict) -> list:
    heads = ev.get("heads")
    rows = []
    if not isinstance(heads, dict):
        return rows
    for repo in sorted(heads):
        recorded = heads[repo]
        row: dict[str, Any] = {"repo": repo, "head": recorded,
                               "current_head": None, "stale": None, "reason": None}
        if not recorded:
            row["reason"] = "no recorded head"
        else:
            cur, why = _worktree_head(run_dir, repo)
            row["current_head"] = cur
            if cur is None:
                row["reason"] = why
            else:
                row["stale"] = cur != recorded
        rows.append(row)
    return rows


def _row(root: str, ws: str, run_id: str, with_repos: bool = True) -> dict:
    run_dir = os.path.join(root, ws, run_id)
    path = os.path.join(run_dir, "integration.json")
    row: dict[str, Any] = {"workspace": ws, "run_id": run_id, "state": "ok",
                           "status": None, "exit_code": None, "error": None,
                           "repos": []}
    try:
        with open(path) as fh:
            ev = json.load(fh)
        if not isinstance(ev, dict):
            raise ValueError("integration.json is not an object")
    except (OSError, ValueError) as exc:
        row["state"] = "unreadable"
        row["error"] = "%s: %s" % (type(exc).__name__, exc)
        return row
    row["status"] = ev.get("status")
    row["exit_code"] = ev.get("exit_code")
    row["outcomes"] = ev.get("outcomes") if isinstance(ev.get("outcomes"), dict) else {}
    if with_repos:
        row["repos"] = _repo_rows(run_dir, ev)
    return row


def list_runs(loki_dir: str) -> dict:
    root = os.path.join(loki_dir, "workspaces")
    if not os.path.isdir(root):
        return {"runs": [], "reason": "no workspaces directory at %s" % root,
                "source": root}
    runs = []
    try:
        names = sorted(os.listdir(root))
    except OSError as exc:
        return {"runs": [], "reason": "workspaces directory unreadable: %s" % exc,
                "source": root}
    for ws in names:
        wdir = os.path.join(root, ws)
        if not valid_name(ws) or not os.path.isdir(wdir):
            continue
        try:
            ids = sorted(os.listdir(wdir))
        except OSError:
            continue
        for run_id in ids:
            if valid_name(run_id) and os.path.isdir(os.path.join(wdir, run_id)):
                runs.append(_row(root, ws, run_id))
    reason: Optional[str] = None if runs else "no workspace runs recorded"
    return {"runs": runs, "reason": reason, "source": root}


def get_run(loki_dir: str, ws: str, run_id: str) -> dict:
    if not valid_name(ws) or not valid_name(run_id):
        raise BadName("invalid workspace or run id")
    root = os.path.join(loki_dir, "workspaces")
    if not os.path.isdir(os.path.join(root, ws, run_id)):
        raise NotFound("unknown run")
    return _row(root, ws, run_id)
