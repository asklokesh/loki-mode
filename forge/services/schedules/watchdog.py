"""Schedule runner watchdog (X-22).

Tracks the last-seen tick timestamp; alert when more than N seconds
elapsed since the last tick (typically because the dashboard
background loop died).

Storage: <forge_dir>/schedules/.watchdog.json {last_tick_ts, ticks_total}.
The runner's tick() pings the watchdog implicitly; this module exposes
the inspection surface used by the /api/forge/health endpoint and the
agent.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict


_WATCHDOG = ".watchdog.json"
DEFAULT_THRESHOLD_SECONDS = 60


def _path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "schedules", _WATCHDOG)


def ping(forge_dir: str) -> Dict[str, Any]:
    """Record a tick. Called by the runner's tick() each iteration."""
    p = _path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    cur: Dict[str, Any] = {}
    if os.path.isfile(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                cur = json.load(f) or {}
        except (OSError, json.JSONDecodeError):
            cur = {}
    cur["last_tick_ts"] = int(time.time())
    cur["ticks_total"] = int(cur.get("ticks_total", 0)) + 1
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cur, f)
    os.replace(tmp, p)
    return cur


def status(forge_dir: str,
           threshold_seconds: int = DEFAULT_THRESHOLD_SECONDS) -> Dict[str, Any]:
    """Return watchdog status. Sets `stalled=True` when the gap since
    the last tick exceeds threshold_seconds."""
    p = _path(forge_dir)
    if not os.path.isfile(p):
        return {"ok": False, "stalled": False, "reason": "never_ticked",
                "threshold_seconds": threshold_seconds}
    try:
        with open(p, "r", encoding="utf-8") as f:
            cur = json.load(f) or {}
    except (OSError, json.JSONDecodeError):
        return {"ok": False, "stalled": False, "reason": "watchdog_unreadable"}
    last = int(cur.get("last_tick_ts", 0))
    now = int(time.time())
    gap = now - last
    stalled = gap > threshold_seconds
    return {
        "ok": not stalled,
        "stalled": stalled,
        "last_tick_ts": last,
        "ticks_total": int(cur.get("ticks_total", 0)),
        "seconds_since_last_tick": gap,
        "threshold_seconds": threshold_seconds,
    }
