"""Per-function run log reader."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional


def _logs_dir(forge_dir: str, name: str) -> str:
    return os.path.join(forge_dir, "functions", name, "logs")


def list_runs(forge_dir: str, name: str, limit: int = 100) -> List[Dict[str, Any]]:
    d = _logs_dir(forge_dir, name)
    if not os.path.isdir(d):
        return []
    entries = sorted(os.listdir(d), reverse=True)[:max(1, min(int(limit), 10000))]
    out: List[Dict[str, Any]] = []
    for e in entries:
        if not e.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, e), "r", encoding="utf-8") as f:
                out.append(json.load(f))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def read_run_log(forge_dir: str, name: str, run_id: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(_logs_dir(forge_dir, name), f"{run_id}.json")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
