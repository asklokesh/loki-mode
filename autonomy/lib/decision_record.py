#!/usr/bin/env python3
"""LLM Decision Record: which model, at what temperature, decided what.

WHY THIS EXISTS. Factory AI's audit log has eight event types and NOT ONE
records an agent action -- they are all admin configuration (membership, API
keys, integrations, managed settings). Agent forensics exists only as
customer-built OTEL: metrics by default, message content opt-in, and the customer
must stand up and retain the pipeline. So "which agent changed this line, on
whose authority, and what did it verify" is answerable only if the buyer built
the plumbing themselves. Devin's audit log is likewise session and admin scoped.

8090's evaluation framework records, per AI operation: session id, pipeline
stage, model id, temperature, timestamps, token counts, reasoning trace,
confidence. Their stated reason is the one that matters to a regulated buyer:
capturing model id and temperature makes a MODEL SWAP DETECTABLE. Without it,
a provider silently changing a model underneath you is invisible in your own
records, and "we used an approved configuration" becomes unfalsifiable.

WHAT THIS IS. An append-only record of agent decisions, written next to the
receipt so the chain of custody is complete: the receipt says what was proven,
the outcome ledger says what happened afterwards, and this says what made the
call. Append-only because an audit trail a later run can rewrite is not an audit
trail.

WHAT THIS DELIBERATELY DOES NOT CAPTURE. No prompt bodies, no file contents, no
credentials, no environment. 8090's own boundary applies with more force to us
than to them: an adoption tool that exfiltrates a user's environment would cost
exactly the trust this product sells. Fields are a fixed allowlist, and a test
asserts the allowlist so a future contributor cannot widen it casually.

IT IS NOT TELEMETRY. Nothing here is transmitted. It writes a local JSONL file
that the user owns and can read, diff, and delete. autonomy/telemetry.sh remains
the single egress point.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = "1.0"

# The complete set of fields a record may carry. Anything not on this list is
# dropped rather than written: a record that can grow a new field by accident is
# how an audit log becomes a data-exfiltration surface. The test suite asserts
# this exact set, so widening it is a deliberate, reviewed act.
ALLOWED_FIELDS = (
    "schema_version",
    "recorded_at",
    "session_id",
    "run_id",
    "stage",          # which part of the loop made the call
    "model_id",       # THE field that makes a silent model swap detectable
    "temperature",    # same: a config drift nobody announced
    "provider",
    "tokens_in",
    "tokens_out",
    "duration_ms",
    "outcome",        # coarse: ok | error | refused | timeout
    "confidence",     # self-reported, and labelled as such below
)

# Fields whose value is the AGENT'S OWN OPINION, never a measurement. Kept
# separate so a reader cannot mistake a self-report for an observation -- the
# same FACTS-vs-ASSESSMENTS split the receipts already enforce.
SELF_REPORTED = ("confidence",)


def _records_path(loki_dir):
    return os.path.join(loki_dir, "decisions", "decisions.jsonl")


def record(loki_dir, fields):
    """Append one decision record. Returns the written record, or a reason.

    Append-only by construction: opened "a", never "w". A trail a later run can
    rewrite is not a trail, and the whole value here is that a reader can trust
    what it says about a run that already finished.
    """
    clean = {}
    dropped = []
    for k, v in (fields or {}).items():
        if k in ALLOWED_FIELDS:
            clean[k] = v
        else:
            dropped.append(k)

    if not clean.get("model_id"):
        # A record without a model id cannot answer the question this exists to
        # answer, so it is refused rather than written as a half-record.
        return {"status": "UNKNOWN", "reason": "no_model_id",
                "detail": "a decision record without model_id cannot make a swap detectable"}

    clean["schema_version"] = SCHEMA_VERSION
    clean["recorded_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    path = _records_path(loki_dir)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(clean, sort_keys=True) + "\n")
    except OSError as exc:
        return {"status": "UNKNOWN", "reason": "unwritable", "detail": str(exc)}

    out = {"status": "recorded", "path": path, "record": clean}
    if dropped:
        # Surfaced, not silent: a caller trying to log a prompt body should see
        # that it was refused rather than assume it was stored.
        out["dropped_fields"] = sorted(dropped)
    return out


def summarize(loki_dir):
    """What models actually ran, and did the configuration change mid-flight?

    The useful audit question is not "how many calls" but "did the thing that
    decided change without anyone saying so". A run whose records name two model
    ids is exactly the case a regulated buyer needs surfaced.
    """
    path = _records_path(loki_dir)
    if not os.path.isfile(path):
        return {"status": "UNKNOWN", "reason": "no_records",
                "detail": "no decision records for this project"}

    models, temps, stages, n, bad = {}, {}, {}, 0, 0
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    # A corrupt line is counted, never silently skipped: an audit
                    # trail that quietly drops what it cannot parse is worse than
                    # one that admits a gap.
                    bad += 1
                    continue
                n += 1
                m = rec.get("model_id")
                if m:
                    models[m] = models.get(m, 0) + 1
                t = rec.get("temperature")
                if t is not None:
                    temps[str(t)] = temps.get(str(t), 0) + 1
                s = rec.get("stage")
                if s:
                    stages[s] = stages.get(s, 0) + 1
    except OSError as exc:
        return {"status": "UNKNOWN", "reason": "unreadable", "detail": str(exc)}

    return {
        "status": "measured",
        "records": n,
        "unparseable_lines": bad,
        "models": models,
        "temperatures": temps,
        "stages": stages,
        # The headline fact. More than one model id, or more than one
        # temperature, means the configuration changed during this project and
        # the records prove it.
        "model_changed": len(models) > 1,
        "temperature_changed": len(temps) > 1,
        "self_reported_fields": list(SELF_REPORTED),
    }


def main(argv):
    if not argv:
        print("usage: decision_record.py record|summary [--field=value ...]",
              file=sys.stderr)
        return 2
    action = argv[0]
    cwd = os.environ.get("LOKI_DECISION_CWD") or os.getcwd()
    loki_dir = os.environ.get("LOKI_DIR") or os.path.join(cwd, ".loki")

    if action == "record":
        fields = {}
        for arg in argv[1:]:
            if arg.startswith("--") and "=" in arg:
                k, v = arg[2:].split("=", 1)
                fields[k] = v
        res = record(loki_dir, fields)
    elif action == "summary":
        res = summarize(loki_dir)
    else:
        print(f"unknown action: {action}", file=sys.stderr)
        return 2

    print(json.dumps(res, indent=2))
    return 0 if res.get("status") in ("recorded", "measured") else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
