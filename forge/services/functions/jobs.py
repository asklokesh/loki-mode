"""Background job queue for forge functions (X-57).

A user-app can enqueue work that a function should process
asynchronously. The schedules runner picks up due jobs once per
second; retries on failure (capped); dead-letters after N
attempts.

Storage:
    <forge_dir>/functions/jobs/queue.jsonl       - pending jobs
    <forge_dir>/functions/jobs/<id>/             - per-job state
        attempts.jsonl                            - one row per try
        result.json (when terminal)
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional


_MAX_ATTEMPTS_DEFAULT = 5


def _root(forge_dir: str) -> str:
    return os.path.join(forge_dir, "functions", "jobs")


def _queue_path(forge_dir: str) -> str:
    return os.path.join(_root(forge_dir), "queue.jsonl")


def enqueue(forge_dir: str, *, function: str,
            payload: Optional[Dict[str, Any]] = None,
            max_attempts: int = _MAX_ATTEMPTS_DEFAULT,
            not_before_ts: Optional[int] = None) -> Dict[str, Any]:
    """Enqueue a job. Returns {job_id}. not_before_ts allows delayed
    execution (epoch seconds)."""
    if not isinstance(function, str) or not function:
        raise ValueError("function name required")
    if max_attempts < 1 or max_attempts > 50:
        raise ValueError("max_attempts must be 1..50")
    job = {
        "id": uuid.uuid4().hex,
        "function": function,
        "payload": payload or {},
        "attempts": 0,
        "max_attempts": max_attempts,
        "enqueued_at": int(time.time()),
        "not_before_ts": not_before_ts,
        "status": "pending",
    }
    os.makedirs(_root(forge_dir), exist_ok=True)
    with open(_queue_path(forge_dir), "a", encoding="utf-8") as f:
        f.write(json.dumps(job, separators=(",", ":")) + "\n")
    return {"job_id": job["id"]}


def _read_queue(forge_dir: str) -> List[Dict[str, Any]]:
    p = _queue_path(forge_dir)
    if not os.path.isfile(p):
        return []
    out: List[Dict[str, Any]] = []
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return out


def _write_queue(forge_dir: str, jobs: List[Dict[str, Any]]) -> None:
    p = _queue_path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for j in jobs:
            f.write(json.dumps(j, separators=(",", ":")) + "\n")
    os.replace(tmp, p)


def tick(forge_dir: str, *, now_ts: Optional[float] = None,
         invoke=None) -> List[Dict[str, Any]]:
    """Process the next pending job. Returns the list of jobs touched
    this tick (usually 0 or 1). The optional `invoke` callable is
    used in tests; default is the real forge.services.functions.invoke."""
    jobs = _read_queue(forge_dir)
    if not jobs:
        return []
    now = int(now_ts if now_ts is not None else time.time())
    target = None
    for j in jobs:
        if j.get("status") != "pending":
            continue
        nbt = j.get("not_before_ts")
        if isinstance(nbt, int) and nbt > now:
            continue
        target = j
        break
    if target is None:
        return []

    fn = invoke
    if fn is None:
        try:
            from .invoke import invoke as _real
            fn = _real
        except Exception:
            fn = None
    job_dir = os.path.join(_root(forge_dir), target["id"])
    os.makedirs(job_dir, exist_ok=True)
    target["attempts"] += 1
    try:
        if fn is None:
            raise RuntimeError("invoke unavailable")
        res = fn(forge_dir, target["function"], payload=target["payload"])
        ok = bool(res.get("ok"))
    except Exception as e:
        res = {"ok": False, "error": str(e)}
        ok = False
    with open(os.path.join(job_dir, "attempts.jsonl"), "a",
              encoding="utf-8") as f:
        f.write(json.dumps({
            "attempt": target["attempts"],
            "ts": now,
            "ok": ok,
            "result": res,
        }, separators=(",", ":")) + "\n")
    if ok:
        target["status"] = "completed"
        with open(os.path.join(job_dir, "result.json"), "w",
                  encoding="utf-8") as f:
            json.dump(res, f)
    elif target["attempts"] >= target["max_attempts"]:
        target["status"] = "dead"
        with open(os.path.join(job_dir, "result.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"ok": False, "dead_letter": True,
                       "last_result": res}, f)
    # else status stays pending for the next tick.
    _write_queue(forge_dir, jobs)
    return [target]


def list_jobs(forge_dir: str, *, status: Optional[str] = None,
              limit: int = 100) -> List[Dict[str, Any]]:
    jobs = _read_queue(forge_dir)
    if status:
        jobs = [j for j in jobs if j.get("status") == status]
    return jobs[-max(1, min(int(limit), 10000)):]
