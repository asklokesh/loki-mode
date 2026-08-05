#!/usr/bin/env python3
"""Find the longest stretches where a build told the user nothing.

WHY THIS EXISTS. The loudest complaints about agents in this category are not
"it was wrong", they are "it went quiet and I could not tell if it was working":
opencode#11112 "always stuck at Preparing write" (76 comments), continue#7143
"not making changes to code", continue#5696 "agent does not execute functions".
In each case the agent may well be working. The user cannot tell, so they kill
it or leave.

Wall-clock total is the wrong metric for that experience. A ten-minute build
that reports something every twenty seconds feels fast; a four-minute build that
goes silent for three of them feels broken. What matters is the LONGEST GAP.

This reads the events the engine already writes and reports the worst silences,
so the number can be driven down instead of guessed at.

HOW TO MEASURE IT HONESTLY, learned the hard way here:
  - Read wall clock from the engine's own event stream, never from `ps etime` on
    a supervising process. A hung harness once reported 39 minutes for a 20
    minute run.
  - Separate IDLE time between sessions from SILENCE during a build. A gap
    between two `session_resume` events is a human having lunch, not a defect,
    and counting it makes the report useless.
  - Report the event on each side of a gap. "Silent for 214s" is not actionable;
    "silent for 214s after code_review_start" names the step to fix.

Usage:
    python3 autonomy/lib/silence_report.py [--events .loki/events.jsonl]
                                           [--threshold 30] [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime

# Events that mark a session boundary rather than build progress. A gap
# alongside one of these is a human being away, not the engine being silent.
_BOUNDARY = {
    "session_resume",
    "session_start",
    "claude_hook_sessionstart",
    "cli_command_deprecated",
}


def _parse(path):
    """Yield (datetime, event_type). Malformed lines are skipped, not defaulted.

    A line we cannot parse must not become a synthetic timestamp: that would
    invent a gap or hide one, and either way the report stops being evidence.
    """
    out = []
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return out
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("timestamp") or d.get("ts") or d.get("at")
            if not isinstance(t, str) or not t:
                continue
            try:
                dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
            except Exception:
                continue
            kind = d.get("type") or d.get("event") or "unknown"
            out.append((dt, str(kind)))
    out.sort(key=lambda r: r[0])
    return out


def analyse(events_path, threshold_s=30.0, session_gap_s=1800.0):
    evs = _parse(events_path)
    if len(evs) < 2:
        return {
            "events": len(evs),
            "gaps_over_threshold": 0,
            "worst": [],
            "threshold_s": threshold_s,
            "notes": ["fewer than two timestamped events: nothing to measure"],
        }

    gaps = []
    skipped_boundary = 0
    for i in range(1, len(evs)):
        prev_t, prev_k = evs[i - 1]
        cur_t, cur_k = evs[i]
        secs = (cur_t - prev_t).total_seconds()
        if secs <= 0:
            continue
        # A gap longer than the session window, or one touching a session
        # boundary event, is idle time rather than in-build silence.
        if secs >= session_gap_s or prev_k in _BOUNDARY or cur_k in _BOUNDARY:
            skipped_boundary += 1
            continue
        gaps.append({"seconds": round(secs, 1), "after": prev_k, "before": cur_k})

    gaps.sort(key=lambda g: g["seconds"], reverse=True)
    over = [g for g in gaps if g["seconds"] > threshold_s]

    notes = []
    if not gaps:
        notes.append(
            "no in-build gaps found: this event stream is session/CLI telemetry, "
            "not a build. Point --events at a real build's .loki/events.jsonl"
        )
    if skipped_boundary:
        notes.append(
            f"{skipped_boundary} gap(s) ignored as idle time between sessions, "
            "not in-build silence"
        )
    return {
        "events": len(evs),
        "in_build_gaps": len(gaps),
        "gaps_over_threshold": len(over),
        "threshold_s": threshold_s,
        "worst": gaps[:10],
        "notes": notes,
    }


def _render(r):
    lines = ["Silence report", "==============", ""]
    lines.append(f"Events:            {r['events']}")
    lines.append(f"In-build gaps:     {r.get('in_build_gaps', 0)}")
    lines.append(f"Over {int(r['threshold_s'])}s:          {r['gaps_over_threshold']}")
    if r["worst"]:
        lines.append("")
        lines.append("Longest silences:")
        for g in r["worst"][:5]:
            lines.append(
                f"  {g['seconds']:>8.1f}s  after '{g['after']}' before '{g['before']}'"
            )
    for n in r.get("notes", []):
        lines.append("")
        lines.append(f"note: {n}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--events", default=".loki/events.jsonl")
    ap.add_argument("--threshold", type=float, default=30.0)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    r = analyse(args.events, args.threshold)
    print(json.dumps(r, indent=2) if args.json else _render(r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
