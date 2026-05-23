"""Minimal cron expression parser/validator.

Supports the 5-field standard form (minute hour dom month dow) plus
the @-aliases (@hourly, @daily, @weekly, @monthly). Yearly and dom*dow
intersections handled conservatively.

We do not implement the full POSIX cron grammar (no L, no #, no slash
inside lists). The schedules we want to support are the ones agents
actually write: "0 8 * * *", "*/15 * * * *", "@hourly".
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Tuple


_ALIASES = {
    "@yearly":  "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly":  "0 0 * * 0",
    "@daily":   "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly":  "0 * * * *",
}

# (low, high) for each field index.
_BOUNDS = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]


class CronError(ValueError):
    pass


def _expand_field(field: str, lo: int, hi: int) -> List[int]:
    """Expand one field token into the sorted list of valid integers."""
    if field == "*":
        return list(range(lo, hi + 1))
    out: List[int] = []
    for part in field.split(","):
        step = 1
        if "/" in part:
            base, step_s = part.split("/", 1)
            try:
                step = int(step_s)
            except ValueError as e:
                raise CronError(f"invalid step in {part!r}") from e
            if step <= 0:
                raise CronError(f"step must be positive in {part!r}")
        else:
            base = part
        if base == "*":
            values = list(range(lo, hi + 1))
        elif "-" in base:
            try:
                a, b = base.split("-", 1)
                values = list(range(int(a), int(b) + 1))
            except ValueError as e:
                raise CronError(f"invalid range in {part!r}") from e
        else:
            try:
                values = [int(base)]
            except ValueError as e:
                raise CronError(f"invalid value in {part!r}") from e
        for v in values:
            if v < lo or v > hi:
                raise CronError(f"{v} out of [{lo},{hi}] in {part!r}")
        # Apply step.
        out.extend(v for i, v in enumerate(values) if (v - values[0]) % step == 0)
    return sorted(set(out))


def _normalize(expr: str) -> str:
    expr = expr.strip()
    if expr in _ALIASES:
        return _ALIASES[expr]
    return expr


def validate_expression(expr: str) -> None:
    """Raise CronError on invalid expression. Returns None on success."""
    expr = _normalize(expr)
    fields = expr.split()
    if len(fields) != 5:
        raise CronError(
            f"expected 5 fields (or @alias), got {len(fields)}: {expr!r}"
        )
    for i, f in enumerate(fields):
        _expand_field(f, *_BOUNDS[i])


def describe(expr: str) -> str:
    """X-75: render a cron expression as a human-readable sentence.

    Best-effort - covers the common shapes (every minute, hourly at
    minute N, daily at HH:MM, weekly on DOW at HH:MM, monthly on DOM).
    Falls back to a structured description for shapes we don't have a
    pretty mapping for.
    """
    expr = _normalize(expr)
    fields = expr.split()
    if len(fields) != 5:
        return f"invalid cron expression: {expr!r}"
    minute, hour, dom, month, dow = fields
    DAYS = {"0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday",
            "4": "Thursday", "5": "Friday", "6": "Saturday"}

    # @-style aliases (after _normalize re-expands them, we still
    # check the original input first for the obvious cases).
    if minute == "*" and hour == "*" and dom == "*" and month == "*" and dow == "*":
        return "every minute"
    if minute == "0" and hour == "*" and dom == "*" and month == "*" and dow == "*":
        return "hourly at :00"
    if minute.startswith("*/") and hour == "*" and dom == "*" and month == "*" and dow == "*":
        try:
            n = int(minute[2:])
            return f"every {n} minute{'s' if n != 1 else ''}"
        except ValueError:
            pass
    try:
        m_int = int(minute)
        h_int = int(hour)
    except ValueError:
        return f"cron {expr!r}"

    if dom == "*" and month == "*" and dow == "*":
        return f"daily at {h_int:02d}:{m_int:02d} UTC"
    if dom == "*" and month == "*" and dow in DAYS:
        return f"weekly on {DAYS[dow]} at {h_int:02d}:{m_int:02d} UTC"
    if dow == "*" and month == "*":
        try:
            d = int(dom)
            return (f"monthly on day {d} at {h_int:02d}:{m_int:02d} UTC")
        except ValueError:
            pass
    if dow == "*":
        try:
            d = int(dom); mm = int(month)
            return (f"yearly on {mm:02d}-{d:02d} at {h_int:02d}:{m_int:02d} UTC")
        except ValueError:
            pass
    return f"cron {expr!r} (custom)"


def lint(expr: str) -> Dict[str, Any]:
    """X-28: Lint a cron expression. Returns a structured report with
    warnings + the computed next fire times so CI can surface obvious
    mistakes (e.g. minute=* effectively spamming, or a schedule that
    will never fire on Feb 30)."""
    report: Dict[str, Any] = {"expr": expr, "warnings": [], "errors": []}
    try:
        validate_expression(expr)
    except CronError as e:
        report["errors"].append(str(e))
        return report
    norm = _normalize(expr)
    fields = norm.split()

    # Warning: minute=* means "fire every minute" (1440 fires/day) -
    # almost never what users want.
    if fields[0] == "*":
        report["warnings"].append(
            "minute='*' fires every minute; consider '*/N' or a specific minute"
        )

    # Warning: DOM > 28 fails in some months (Feb 30).
    for part in fields[2].split(","):
        try:
            v = int(part.split("/")[0].split("-")[0])
            if v > 28:
                report["warnings"].append(
                    f"day-of-month={v} never fires in months shorter than {v}"
                )
                break
        except ValueError:
            pass

    # Compute the next 3 fire times for surface visibility.
    try:
        import time as _time
        fires = []
        base = _time.time()
        for _ in range(3):
            n = next_fire_time(expr, after_ts=base)
            fires.append(n)
            base = n
        report["next_fires"] = fires
    except CronError as e:
        report["errors"].append(f"could not compute next fires: {e}")
    return report


def next_fire_time(expr: str, *, after_ts: float = None) -> int:
    """Return the next epoch-seconds firing time on or after after_ts (UTC)."""
    expr = _normalize(expr)
    fields = expr.split()
    if len(fields) != 5:
        raise CronError(f"expected 5 fields: {expr!r}")
    minutes = set(_expand_field(fields[0], 0, 59))
    hours = set(_expand_field(fields[1], 0, 23))
    days = set(_expand_field(fields[2], 1, 31))
    months = set(_expand_field(fields[3], 1, 12))
    dows = set(_expand_field(fields[4], 0, 6))

    base = after_ts if after_ts is not None else time.time()
    # Start at the next whole minute.
    start = datetime.fromtimestamp(base, tz=timezone.utc).replace(
        second=0, microsecond=0
    ) + timedelta(minutes=1)
    # Cap the search at 4 years out so a no-fire expression doesn't spin.
    cap = start + timedelta(days=4 * 366)
    cur = start
    while cur < cap:
        if (cur.minute in minutes
            and cur.hour in hours
            and cur.month in months
            and (cur.day in days or cur.weekday() % 7 + 1 - 1 in dows
                 if False else _dom_dow_match(cur, days, dows, fields))):
            return int(cur.replace(tzinfo=timezone.utc).timestamp())
        cur = cur + timedelta(minutes=1)
    raise CronError("no firing time within 4 years (expression unreachable?)")


def _dom_dow_match(cur: datetime, days: set, dows: set,
                   fields: List[str]) -> bool:
    """Standard cron semantics: when both DOM and DOW are restricted (not *),
    fire when EITHER matches. When one is *, both must match."""
    dom_star = fields[2] == "*"
    dow_star = fields[4] == "*"
    # cur.weekday() returns 0=Mon..6=Sun; cron uses 0=Sun..6=Sat.
    py_dow = (cur.weekday() + 1) % 7
    dom_ok = cur.day in days
    dow_ok = py_dow in dows
    if dom_star and dow_star:
        return True
    if dom_star:
        return dow_ok
    if dow_star:
        return dom_ok
    return dom_ok or dow_ok
