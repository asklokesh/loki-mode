"""Schedule CRUD.

A schedule binds a cron expression to a target (function name, URL, or
event-bus topic) and an optional payload. The runner ticks once per
second in the dashboard background loop; on tick, it fires every
schedule whose next_fire_time has passed.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from .cron import next_fire_time, validate_expression


class ScheduleError(Exception):
    pass


_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,62}$")
_ALLOWED_TARGET_TYPES = {"function", "url", "event"}


def _path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "schedules", "schedules.json")


def _load(forge_dir: str) -> List[Dict[str, Any]]:
    p = _path(forge_dir)
    if not os.path.isfile(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    return list(data) if isinstance(data, list) else []


def _save(forge_dir: str, items: List[Dict[str, Any]]) -> None:
    p = _path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=2, sort_keys=True)
    os.replace(tmp, p)


def create(forge_dir: str, name: str, cron: str,
           target: Dict[str, Any], payload: Optional[Dict[str, Any]] = None,
           *, bus_channel: Optional[str] = None,
           tags: Optional[List[str]] = None
           ) -> Dict[str, Any]:
    if not _NAME_RE.match(name or ""):
        raise ScheduleError("name must match ^[a-z][a-z0-9_-]{1,62}$")
    try:
        validate_expression(cron)
    except Exception as e:
        raise ScheduleError(f"invalid cron expression: {e}") from e
    t_type = (target or {}).get("type")
    if t_type not in _ALLOWED_TARGET_TYPES:
        raise ScheduleError(
            f"target.type must be one of {sorted(_ALLOWED_TARGET_TYPES)}"
        )
    # Per-type validation.
    if t_type == "function":
        if not target.get("name"):
            raise ScheduleError("target.name required for function target")
    elif t_type == "url":
        u = target.get("url", "")
        if not isinstance(u, str) or not u.startswith(("http://", "https://")):
            raise ScheduleError("target.url must be http(s)")
    elif t_type == "event":
        if not target.get("topic"):
            raise ScheduleError("target.topic required for event target")

    items = _load(forge_dir)
    if any(s.get("name") == name for s in items):
        raise ScheduleError(f"schedule exists: {name}")
    # N-77: validate bus_channel format up front so typos surface
    # here instead of silently routing to a non-existent stream.
    if bus_channel is not None:
        import re as _re
        if not _re.match(r"^[a-z][a-z0-9_.\-]{1,63}$", bus_channel):
            raise ScheduleError(
                f"bus_channel must match ^[a-z][a-z0-9_.\\-]{{1,63}}$"
            )
    rec = {
        "id": uuid.uuid4().hex,
        "name": name,
        "cron": cron,
        "target": target,
        "payload": payload or {},
        "created_at": int(time.time()),
        "last_fire_ts": None,
        "next_fire_ts": next_fire_time(cron),
        "enabled": True,
    }
    if bus_channel:
        rec["bus_channel"] = bus_channel
    if tags:
        # N-103: validate tag shape so /metrics labels stay safe.
        # N-112: cap at 8 tags so cardinality on the metric axis
        # stays bounded.
        if len(tags) > 8:
            raise ScheduleError("at most 8 tags per schedule (N-112)")
        import re as _re
        cleaned = []
        for t in tags:
            if not isinstance(t, str) or not _re.match(r"^[a-z0-9_:-]{1,32}$", t):
                raise ScheduleError(
                    f"invalid tag {t!r}: ^[a-z0-9_:-]{{1,32}}$"
                )
            cleaned.append(t)
        rec["tags"] = sorted(set(cleaned))
    items.append(rec)
    _save(forge_dir, items)
    return rec


def list_schedules(forge_dir: str) -> List[Dict[str, Any]]:
    return _load(forge_dir)


def get(forge_dir: str, name: str) -> Optional[Dict[str, Any]]:
    for s in _load(forge_dir):
        if s.get("name") == name:
            return s
    return None


def update(forge_dir: str, name: str, **fields: Any) -> Dict[str, Any]:
    items = _load(forge_dir)
    for s in items:
        if s.get("name") == name:
            if "cron" in fields:
                validate_expression(fields["cron"])
                s["cron"] = fields["cron"]
                s["next_fire_ts"] = next_fire_time(fields["cron"])
            if "enabled" in fields:
                s["enabled"] = bool(fields["enabled"])
            if "payload" in fields:
                s["payload"] = fields["payload"] or {}
            if "target" in fields and isinstance(fields["target"], dict):
                # Re-validate with same rules as create().
                t = fields["target"]
                if t.get("type") not in _ALLOWED_TARGET_TYPES:
                    raise ScheduleError("invalid target.type")
                s["target"] = t
            if "bus_channel" in fields:
                # N-93: same validation as create() so typos surface
                # in update() too.
                bc = fields["bus_channel"]
                if bc is None or bc == "":
                    s.pop("bus_channel", None)
                else:
                    import re as _re
                    if not _re.match(r"^[a-z][a-z0-9_.\-]{1,63}$", bc):
                        raise ScheduleError(
                            "bus_channel must match ^[a-z][a-z0-9_.\\-]{1,63}$"
                        )
                    s["bus_channel"] = bc
            _save(forge_dir, items)
            return s
    raise ScheduleError(f"schedule not found: {name}")


def delete(forge_dir: str, name: str) -> bool:
    items = _load(forge_dir)
    new = [s for s in items if s.get("name") != name]
    if len(new) == len(items):
        return False
    _save(forge_dir, new)
    return True


def _emit_schedule_event(forge_dir: str, name: str, event: str) -> None:
    """N-54: publish a schedule:* event on the realtime bus so
    dashboards see pause/resume transitions live.
    N-69: when the schedule defines `bus_channel`, route the event
    to that channel instead of the global `_system.schedules`.
    N-123: when no explicit bus_channel AND the schedule has exactly
    one tag, route to `_system.schedules.<tag>` so per-tenant
    dashboards see only their slice without operator setup.
    """
    try:
        from forge.services.realtime.bus import publish as _pub
        sched = get(forge_dir, name) or {}
        channel = sched.get("bus_channel")
        if not channel:
            tags = sched.get("tags") or []
            if len(tags) == 1:
                # Sanitize tag chars not legal in channel names.
                safe = tags[0].replace(":", "-")
                channel = f"_system.schedules.{safe}"
            else:
                channel = "_system.schedules"
        _pub(forge_dir, channel, {
            "type": event, "schedule": name,
        }, sender_user_id="__schedules__")
    except Exception:
        pass


def pause(forge_dir: str, name: str) -> Dict[str, Any]:
    """N-54: disable a schedule and emit `schedule:paused`. Idempotent
    when already paused: still emits so observers can drop watchdog
    timers safely."""
    res = update(forge_dir, name, enabled=False)
    _emit_schedule_event(forge_dir, name, "schedule:paused")
    return res


def resume(forge_dir: str, name: str) -> Dict[str, Any]:
    """N-54: re-enable a schedule and emit `schedule:resumed`."""
    res = update(forge_dir, name, enabled=True)
    _emit_schedule_event(forge_dir, name, "schedule:resumed")
    return res
