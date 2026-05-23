"""Schedule runner.

A pure synchronous tick() that returns the list of schedules that fired
in this tick (so callers can fan-out invocations on their own loop).

This makes the runner trivially testable: feed it a clock, get back
the expected firings. The dashboard background loop wires it to
`time.time()`.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional

from .cron import next_fire_time
from .schedules import _load, _save, get


def _runs_dir(forge_dir: str) -> str:
    return os.path.join(forge_dir, "schedules", "runs")


def list_runs(forge_dir: str, schedule_name: Optional[str] = None,
              limit: int = 100) -> List[Dict[str, Any]]:
    d = _runs_dir(forge_dir)
    if not os.path.isdir(d):
        return []
    out: List[Dict[str, Any]] = []
    for f in sorted(os.listdir(d), reverse=True):
        if not f.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, f), "r", encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        if schedule_name and rec.get("schedule_name") != schedule_name:
            continue
        out.append(rec)
        if len(out) >= max(1, min(int(limit), 10000)):
            break
    return out


def _record_run(forge_dir: str, schedule: Dict[str, Any],
                outcome: str, detail: Optional[str] = None) -> Dict[str, Any]:
    runs_dir = _runs_dir(forge_dir)
    os.makedirs(runs_dir, exist_ok=True)
    rec = {
        "run_id": uuid.uuid4().hex,
        "schedule_name": schedule["name"],
        "schedule_id": schedule.get("id"),
        "fired_at": int(time.time()),
        "outcome": outcome,
        "detail": detail,
        "target": schedule.get("target"),
    }
    path = os.path.join(runs_dir, f"{rec['run_id']}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f)
    os.replace(tmp, path)
    return rec


def tick(forge_dir: str, *, now_ts: Optional[float] = None,
         invoke: Optional[callable] = None) -> List[Dict[str, Any]]:
    """One scheduler tick. Returns the list of schedules that fired.

    The optional `invoke` callable is called as `invoke(schedule)` for
    each firing - the dashboard loop passes a closure that dispatches
    based on target.type. If `invoke` is None we just record a 'recorded'
    outcome and the agent can sweep the runs collection.
    """
    items = _load(forge_dir)
    now = now_ts if now_ts is not None else time.time()
    fired: List[Dict[str, Any]] = []
    changed = False

    for s in items:
        if not s.get("enabled", True):
            continue
        next_ts = s.get("next_fire_ts") or 0
        if next_ts > now:
            continue
        # Fire.
        outcome = "recorded"
        detail = None
        if invoke is not None:
            try:
                result = invoke(s)
                outcome = "ok"
                if isinstance(result, dict) and result.get("error"):
                    outcome = "error"
                    detail = str(result.get("error"))
            except Exception as e:
                outcome = "error"
                detail = str(e)
        _record_run(forge_dir, s, outcome, detail)
        s["last_fire_ts"] = int(now)
        try:
            s["next_fire_ts"] = next_fire_time(s["cron"], after_ts=now)
        except Exception:
            s["enabled"] = False  # parking on parse failure
        changed = True
        fired.append(s)

    if changed:
        _save(forge_dir, items)

    # X-22 watchdog: ping on every tick so /api/forge/health can detect
    # a stalled scheduler loop.
    try:
        from .watchdog import ping
        ping(forge_dir)
    except Exception:
        pass

    return fired
