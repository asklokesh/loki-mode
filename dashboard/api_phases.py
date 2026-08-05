"""Read-only phase history for a run, derived from real `phase_change` events.

WHY THIS EXISTS. dashboard-ui/components/loki-session-timeline.js SYNTHESIZED
its timeline. It took a scalar status (uptime, current phase, iteration count),
rotated a fixed list `['planning','building','testing','reviewing']`, and gave
each invented segment a randomized duration:

    const duration = segmentDuration * (0.8 + Math.random() * 0.4);

An operator read plausible phase boundaries for work that never happened. The
runtime records the real thing -- autonomy/run.sh:6562 emits

    emit_event_json "phase_change" "from=$LAST_KNOWN_PHASE" \\
        "to=$current_phase" "iteration=$ITERATION_COUNT"

and emit_event_json (autonomy/run.sh:2435) appends to .loki/events.jsonl with a
UTC timestamp. So the fix is to READ the record, not to render UNKNOWN.

THE FILE IS events.jsonl, NOT metrics/trust-events.jsonl. Those are two
different append-only logs. api_runs.py documents the trust log and finds no
phase_change in it; looking there and concluding the data is absent is the
available wrong turn.

WHAT A phase_change EVENT CAN AND CANNOT TELL US
------------------------------------------------
Each record is {"timestamp": <utc>, "type": "phase_change",
"data": {"from":..., "to":..., "iteration":...}}. It marks an INSTANT, not an
interval -- there is no duration field anywhere. So a segment's end is the NEXT
event's timestamp, and the final `to` phase is still running.

Two boundaries are therefore genuinely unmeasured, and this module refuses to
invent either:

  THE FIRST SEGMENT'S START. The emitter only fires when LAST_KNOWN_PHASE is
  non-empty AND changed, so the run's opening phase has no recorded start.
  status.uptime_seconds is PROCESS uptime, not phase-0 start; subtracting it
  would be fabrication with extra steps. The first event's `from` phase is
  reported separately as `leading_phase` with start=None, never as a segment
  with a made-up start.

  THE LAST SEGMENT'S END. The trailing phase is ongoing. Its `end` is None and
  `ongoing` is True; the caller anchors it to `checked_at` (supplied here, as
  api_evidence.receipts_report already does) rather than to a client clock.

SAMPLED, NOT EXHAUSTIVE. The emitter lives in a polled monitor loop, so a phase
shorter than one poll interval never produced an event and is absent from this
history. `sampled: True` says so in the envelope. Absence of a segment is not
evidence the phase did not occur.

PHASE NAMES ARE PASSED THROUGH VERBATIM. The runtime writes UPPERCASE values
(BOOTSTRAP, BUILDING, COMPLETED, FAILED -- autonomy/run.sh:6229, :25537,
:25645, :25653) via _advance_current_phase, and the set is open: any string a
caller passes to that function becomes a phase. Mapping an unrecognized name
onto a known label is how "BOOTSTRAP" renders as "Idle", which is the same
class of lie as the simulation. Normalization is the renderer's problem and it
must fall back to the ACTUAL string.

THE HONESTY RULE, as elsewhere in this package: an empty result carries a
`reason`, an unmeasured value is None and never 0, and `source` names the real
path read so any row can be audited. A missing events.jsonl and an unreadable
one produce DIFFERENT reasons.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Optional

# Imported, not restated: a second copy of the freshness/UNKNOWN convention is
# how the honesty rule drifts (see api_runs.py's module docstring).
from .api_runs import UNKNOWN, _freshness, _mtime, _p

__all__ = ["phase_history", "UNKNOWN"]

_EVENTS = "events.jsonl"
_SOURCE_PATHS = (".loki/events.jsonl",)

# events.jsonl is append-only and unbounded. Read at most the trailing slice,
# matching the 10MB cap dashboard/server.py:_read_events already applies to the
# same file, so a long-running workspace cannot pin the dashboard's memory.
_MAX_BYTES = 10 * 1024 * 1024

# ponytail: a phase_change event is ~120 bytes, so the byte cap alone bounds
# this well below any render budget. No event-count cap on top of it.


def _iter_lines(path: str):
    """Trailing slice of an append-only log, newest-truncation-safe.

    Seeking mid-file lands inside a record, so the first partial line after a
    seek is discarded. Raises on an unreadable file: the caller distinguishes
    "absent" from "could not read", and swallowing the error here would erase
    that difference.
    """
    size = os.path.getsize(path)
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        if size > _MAX_BYTES:
            fh.seek(size - _MAX_BYTES)
            fh.readline()  # discard the partial record
        for line in fh:
            yield line


def _parse_ts(raw: Any) -> Optional[float]:
    """UTC ISO-8601 (`date -u +%Y-%m-%dT%H:%M:%SZ`) to epoch seconds.

    None on anything unparseable -- an event whose time cannot be read cannot
    anchor a segment, and guessing a time would place a measured phase at a
    fabricated moment.
    """
    if not isinstance(raw, str) or not raw:
        return None
    txt = raw.strip()
    if txt.endswith("Z"):
        txt = txt[:-1] + "+00:00"
    try:
        from datetime import datetime
        return datetime.fromisoformat(txt).timestamp()
    except (ValueError, TypeError):
        return None


def _phase_change_events(path: str) -> list:
    """Every well-formed phase_change record, oldest first.

    A malformed line is skipped rather than fatal: events.jsonl is appended to
    by concurrent shell writers, so a torn final line is normal operation and
    must not blank out the history behind it.
    """
    out = []
    for line in _iter_lines(path):
        line = line.strip()
        if not line or "phase_change" not in line:
            continue  # cheap prefilter; the log is mostly other event types
        try:
            rec = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(rec, dict) or rec.get("type") != "phase_change":
            continue
        ts = _parse_ts(rec.get("timestamp"))
        if ts is None:
            continue
        data = rec.get("data")
        if not isinstance(data, dict):
            continue
        out.append((ts, data))
    out.sort(key=lambda pair: pair[0])
    return out


def _iteration(data: dict) -> Optional[int]:
    """The iteration number, or None. Never 0 as a stand-in for absent."""
    raw = data.get("iteration")
    if isinstance(raw, bool):
        return UNKNOWN
    if isinstance(raw, int):
        return raw
    if isinstance(raw, str) and raw.strip().lstrip("-").isdigit():
        return int(raw.strip())
    return UNKNOWN


def _envelope(segments, leading, reason, freshness, checked_at, sampled=True):
    return {
        "segments": segments,
        "leading_phase": leading,
        "source": list(_SOURCE_PATHS),
        "freshness_s": freshness,
        "reason": reason,
        "checked_at": checked_at,
        "sampled": sampled,
    }


def phase_history(loki_dir: str, now: Optional[float] = None) -> dict:
    """Measured phase segments for the current run.

    Returns an envelope::

        {"segments": [{"phase", "start", "end", "ongoing", "iteration"}, ...],
         "leading_phase": {"phase", "start": None, "iteration"} | None,
         "source": [...], "freshness_s": int|None, "reason": str|None,
         "checked_at": float, "sampled": True}

    `segments` is empty with a populated `reason` in every no-data case, and
    the reasons are distinct so the UI can say WHY rather than showing one
    blank state for four different situations.
    """
    now = time.time() if now is None else now
    path = _p(loki_dir, _EVENTS)
    fresh = _freshness([_mtime(path)], now=now)

    if not os.path.exists(path):
        return _envelope(
            [], None,
            "no phase history: %s does not exist (the run has not started, or "
            "this workspace predates event logging)" % _SOURCE_PATHS[0],
            fresh, now)

    try:
        events = _phase_change_events(path)
    except OSError as exc:
        # NOT the same as "no events". A dashboard that renders an unreadable
        # log identically to an empty one reports healthy on a broken disk.
        return _envelope(
            [], None,
            "could not read phase history: %s is unreadable (%s)"
            % (_SOURCE_PATHS[0], exc),
            fresh, now)

    if not events:
        return _envelope(
            [], None,
            "phase history not recorded: %s exists but contains no "
            "phase_change events (the run never changed phase, or it predates "
            "phase_change emission)" % _SOURCE_PATHS[0],
            fresh, now)

    # The first event's `from` is a phase we know RAN but whose start was never
    # emitted. Reported with start=None so a renderer can name it without
    # drawing it on a time axis it has no coordinate for.
    first_ts, first_data = events[0]
    leading = None
    from_phase = first_data.get("from")
    if isinstance(from_phase, str) and from_phase:
        leading = {
            "phase": from_phase,
            "start": UNKNOWN,
            "end": first_ts,
            "iteration": _iteration(first_data),
        }

    # One segment per event: it starts where the event fired and ends where the
    # NEXT one did. Both endpoints are measured timestamps; nothing is derived
    # from a duration model.
    segments = []
    for idx, (ts, data) in enumerate(events):
        to_phase = data.get("to")
        if not isinstance(to_phase, str) or not to_phase:
            continue
        nxt = events[idx + 1][0] if idx + 1 < len(events) else None
        segments.append({
            "phase": to_phase,
            "start": ts,
            # None, not now: the run's final phase has no recorded end. The
            # caller anchors it to checked_at and knows it did so.
            "end": nxt,
            "ongoing": nxt is None,
            "iteration": _iteration(data),
        })

    if not segments:
        return _envelope(
            [], leading,
            "phase history not recorded: %d phase_change event(s) carried no "
            "usable 'to' phase" % len(events),
            fresh, now)

    return _envelope(segments, leading, None, fresh, now)
