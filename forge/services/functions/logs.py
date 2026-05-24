"""Per-function run log reader."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional


def _logs_dir(forge_dir: str, name: str) -> str:
    return os.path.join(forge_dir, "functions", name, "logs")


def list_runs(forge_dir: str, name: str, limit: int = 100,
              *, outcome: Optional[str] = None,
              since_ts: Optional[int] = None) -> List[Dict[str, Any]]:
    """List recent function runs.

    N-58: `outcome` filters to a subset:
        - 'ok'    : only ok=True runs
        - 'error' : only ok=False runs (timeouts, exits, missing rt)
        - None    : all runs (back-compat default)
    The filter applies BEFORE the limit, so `limit=50, outcome='error'`
    returns up to 50 actual failures even when the channel is mostly
    successes.
    """
    d = _logs_dir(forge_dir, name)
    if not os.path.isdir(d):
        return []
    cap = max(1, min(int(limit), 10000))
    entries = sorted(os.listdir(d), reverse=True)
    out: List[Dict[str, Any]] = []
    for e in entries:
        if not e.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, e), "r", encoding="utf-8") as f:
                rec = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        if outcome == "ok" and not rec.get("ok"):
            continue
        if outcome == "error" and rec.get("ok"):
            continue
        # N-96: since_ts filters out runs older than the cutoff so
        # pollers only see new entries. started_at is an ISO string;
        # parse to epoch if present.
        if since_ts is not None:
            started = rec.get("started_at")
            ts = 0
            if isinstance(started, str):
                try:
                    import time as _t
                    ts = int(_t.mktime(_t.strptime(
                        started, "%Y-%m-%dT%H:%M:%SZ")))
                except Exception:
                    ts = 0
            if ts < int(since_ts):
                continue
        out.append(rec)
        if len(out) >= cap:
            break
    return out


def purge_runs(forge_dir: str, name: str, *,
               older_than_days: Optional[int] = None,
               keep_last_n: Optional[int] = None) -> int:
    """N-73: drop old run log files. Returns the number of files
    removed.

    Pass exactly one of `older_than_days` or `keep_last_n`:
        - older_than_days (1..365): mtime-based purge.
        - N-106 keep_last_n (>=1): keep the N newest files, drop
          the rest. Sorting is by mtime.
    """
    if (older_than_days is None) == (keep_last_n is None):
        raise ValueError("pass exactly one of older_than_days/keep_last_n")
    # Validate up-front so the cap fires regardless of whether the
    # logs dir exists yet (N-81 / N-115).
    if older_than_days is not None:
        if not isinstance(older_than_days, int) or older_than_days <= 0:
            raise ValueError("older_than_days must be a positive int")
        if older_than_days > 365:
            raise ValueError("older_than_days capped at 365; use a smaller value")
    if keep_last_n is not None:
        if not isinstance(keep_last_n, int) or keep_last_n < 1:
            raise ValueError("keep_last_n must be a positive int")
        if keep_last_n > 10000:
            raise ValueError("keep_last_n capped at 10000")
    d = _logs_dir(forge_dir, name)
    if not os.path.isdir(d):
        return 0
    files = [e for e in os.listdir(d) if e.endswith(".json")]
    if older_than_days is not None:
        import time as _t
        cutoff = _t.time() - older_than_days * 86400  # type: ignore[operator]
        removed = 0
        for e in files:
            path = os.path.join(d, e)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.unlink(path)
                    removed += 1
            except OSError:
                continue
        _record_purge(forge_dir, name, "older_than_days",
                      older_than_days, removed)
        return removed
    # keep_last_n branch (validated up-front).
    paths = [os.path.join(d, e) for e in files]
    paths.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    removed = 0
    for p in paths[keep_last_n:]:
        try:
            os.unlink(p)
            removed += 1
        except OSError:
            continue
    _record_purge(forge_dir, name, "keep_last_n", keep_last_n, removed)
    return removed


def _record_purge(forge_dir: str, name: str, mode: str, arg: int,
                  removed: int) -> None:
    """N-125: append a purge record so operators see when disk was
    reclaimed and by how much. Best-effort - never blocks the
    caller's return."""
    import json as _json
    import time as _t
    p = os.path.join(_logs_dir(forge_dir, name), "purges.jsonl")
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(_json.dumps({
                "ts": int(_t.time()),
                "mode": mode,
                "arg": arg,
                "removed": removed,
            }) + "\n")
        # N-134: rotate when the file passes 1000 lines so it never
        # grows unbounded. Keeps the most recent 1000.
        try:
            with open(p, "r", encoding="utf-8") as f:
                lines = f.readlines()
            if len(lines) > 1000:
                tmp = p + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.writelines(lines[-1000:])
                os.replace(tmp, p)
        except OSError:
            pass
    except OSError:
        pass


def read_run_log(forge_dir: str, name: str, run_id: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(_logs_dir(forge_dir, name), f"{run_id}.json")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
