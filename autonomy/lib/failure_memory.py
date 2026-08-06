#!/usr/bin/env python3
"""Failure memory: the agent gets better at YOUR repo by having been wrong in it.

WHY THIS EXISTS. Neither competitor learns from being wrong, and one of them
shipped a UI to manage that fact.

Factory AI has no memory system at all -- verified by grep over their whole doc
corpus. AGENTS.md is hand-authored by the human, AutoWiki regenerates from CODE
rather than from outcomes, QA failure learning is `suggest_in_report` (a human
reads it and decides), and mission-generated skills live under {missionDir} and
are DISCARDED with the mission. Devin has a real memory layer, but every session
starts from a fresh snapshot copy and all changes are discarded at teardown --
and their Session Insights ships a "Misleading Knowledge" tab enumerating memory
items that led Devin astray. They built an interface for their memory poisoning
output.

So on both systems, an agent that failed a gate in your repo yesterday starts
today knowing nothing about it.

WHAT MAKES THIS DIFFERENT, AND WHY IT IS NOT THE SAME TRAP. The reason Devin
needed a "Misleading Knowledge" tab is that memory written from an agent's own
narration is unfalsifiable: it records what the agent BELIEVED, which is exactly
what was wrong when it failed. So nothing here is written from narration. A
lesson is created only from a MEASURED event -- a named gate that failed, with
its verdict -- and it carries the evidence that produced it. A lesson whose
evidence no longer holds can be retired mechanically instead of accumulating.

This is deliberately built on the outcome ledger's discipline: a lesson is
recorded only when the event that justifies it is a fact, and everything else
reports UNKNOWN with a named reason rather than being written as a weak guess.

WHAT IT DOES NOT DO. It does not summarize, generalize, or ask a model what the
lesson "means". A generalization is a judgement, and a judgement stored as memory
is indistinguishable from a fact by the next reader -- which is the poisoning
mechanism. It stores the gate, the verdict, the evidence, and a count. Deciding
what that implies stays with whoever reads it.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = "1.0"

UNKNOWN = "UNKNOWN"

REASONS = {
    "no_gate": "no gate name was given, so there is nothing to attribute the failure to",
    "no_evidence": "no evidence was given, so the lesson would be unfalsifiable",
    "no_lessons": "no failure lessons recorded for this project",
    "unreadable": "the lesson store exists but could not be parsed",
}


def _path(loki_dir):
    return os.path.join(loki_dir, "memory", "failures.jsonl")


def record_failure(loki_dir, gate, verdict, evidence, run_id=None):
    """Turn a measured gate failure into a durable, falsifiable lesson.

    Requires EVIDENCE. A lesson without it is the agent's own account of why it
    failed, which is precisely the unfalsifiable memory that made Devin's need a
    "Misleading Knowledge" tab. If we cannot say what was observed, we do not
    write anything.
    """
    if not gate:
        return {"status": UNKNOWN, "reason": "no_gate", "detail": REASONS["no_gate"]}
    if not evidence:
        return {"status": UNKNOWN, "reason": "no_evidence",
                "detail": REASONS["no_evidence"]}

    rec = {
        "schema_version": SCHEMA_VERSION,
        "recorded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "gate": gate,
        "verdict": verdict or "FAIL",
        # The falsifiability anchor. A future reader can check whether this still
        # holds instead of taking the lesson on faith.
        "evidence": evidence,
        "run_id": run_id or "",
        # Deliberately absent: any summary, generalization, or "what this means".
        # A judgement stored beside facts becomes indistinguishable from one.
    }

    p = _path(loki_dir)
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, sort_keys=True) + "\n")
    except OSError as exc:
        return {"status": UNKNOWN, "reason": "unreadable", "detail": str(exc)}
    return {"status": "recorded", "path": p, "record": rec}


def recall(loki_dir, gate=None):
    """What has actually gone wrong here before.

    Returns counts per gate, most-failed first. Counts, not prose: "the mock
    integrity gate has failed here 6 times" is a fact a reader can act on, while
    "this repo tends to have mocking problems" is a generalization that sounds
    the same and is not checkable.
    """
    p = _path(loki_dir)
    if not os.path.isfile(p):
        return {"status": UNKNOWN, "reason": "no_lessons",
                "detail": REASONS["no_lessons"]}

    per_gate, recent, bad = {}, [], 0
    try:
        with open(p, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    # Counted, never silently skipped: a memory that quietly
                    # drops what it cannot read is worse than one that admits it.
                    bad += 1
                    continue
                g = r.get("gate")
                if not g or (gate and g != gate):
                    continue
                per_gate[g] = per_gate.get(g, 0) + 1
                recent.append(r)
    except OSError as exc:
        return {"status": UNKNOWN, "reason": "unreadable", "detail": str(exc)}

    if not per_gate:
        return {"status": UNKNOWN, "reason": "no_lessons",
                "detail": REASONS["no_lessons"]}

    return {
        "status": "measured",
        "unparseable_lines": bad,
        "by_gate": dict(sorted(per_gate.items(), key=lambda kv: -kv[1])),
        "total": sum(per_gate.values()),
        # Newest last so a reader sees the current state at the bottom, matching
        # how the file itself is ordered.
        "recent": recent[-5:],
    }


def prompt_context(loki_dir, limit=3):
    """The lines worth putting in front of the next run.

    Returns bare facts. A repo where the same gate has failed repeatedly is
    information the next iteration should have; what to DO about it is left to
    the agent, because prescribing the fix from a count would be inventing a
    causal claim the data does not contain.
    """
    r = recall(loki_dir)
    if r.get("status") != "measured":
        return {"status": r.get("status"), "reason": r.get("reason"), "lines": []}
    lines = []
    for gate, n in list(r["by_gate"].items())[:limit]:
        if n > 1:
            lines.append(f"the {gate} gate has failed {n} times in this repo before")
        else:
            lines.append(f"the {gate} gate has failed here before")
    return {"status": "measured", "lines": lines}


def main(argv):
    if not argv:
        print("usage: failure_memory.py record|recall|context [...]", file=sys.stderr)
        return 2
    action = argv[0]
    cwd = os.environ.get("LOKI_FAILMEM_CWD") or os.getcwd()
    loki_dir = os.environ.get("LOKI_DIR") or os.path.join(cwd, ".loki")

    kv = {}
    for a in argv[1:]:
        if a.startswith("--") and "=" in a:
            k, v = a[2:].split("=", 1)
            kv[k] = v

    if action == "record":
        res = record_failure(loki_dir, kv.get("gate"), kv.get("verdict"),
                             kv.get("evidence"), kv.get("run_id"))
    elif action == "recall":
        res = recall(loki_dir, kv.get("gate"))
    elif action == "context":
        res = prompt_context(loki_dir)
    else:
        print(f"unknown action: {action}", file=sys.stderr)
        return 2

    print(json.dumps(res, indent=2))
    return 0 if res.get("status") in ("recorded", "measured") else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
