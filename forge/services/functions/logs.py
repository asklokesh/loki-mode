"""Per-function run log reader."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional


def _logs_dir(forge_dir: str, name: str) -> str:
    return os.path.join(forge_dir, "functions", name, "logs")


def list_runs(forge_dir: str, name: str, limit: int = 100,
              *, outcome: Optional[str] = None) -> List[Dict[str, Any]]:
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
        out.append(rec)
        if len(out) >= cap:
            break
    return out


def read_run_log(forge_dir: str, name: str, run_id: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(_logs_dir(forge_dir, name), f"{run_id}.json")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
