#!/usr/bin/env python3
"""loop-harness-v1: what the verifiers in a run actually recorded.

READ-ONLY. Opens .loki/events.jsonl and nothing else. Writes nothing, spawns
nothing, and touches no runtime path. Rollback is deleting this file.

WHY THIS REPORTS MOSTLY UNKNOWN, AND WHY THAT IS THE POINT. A loop-harness
manifest wants, per verifier invocation: eligibility, the deterministic
criterion, retry and timeout caps, latency, tokens, cash cost, the verdict,
whether it changed the terminal outcome, false-positive review, and a rollback
switch.

Measured at v9.12.5, the runtime emits almost none of that:

    code_review_complete        review_id, source, iteration
    review_verification_failed  reason, iteration, implementation_retry
    _evidence_gate_and_surface  nothing structured
    _invariant_gate_and_surface nothing structured
    _semantic_gate_and_surface  nothing structured

So this reader CANNOT derive most columns. It reports them UNKNOWN rather than
defaulting them, because a manifest that fills a cost column with 0.0 or an
eligibility column with "yes" is asserting a measurement nobody took -- and a
fabricated manifest about verification is worse than no manifest at all.

The UNKNOWNs are the deliverable. They say exactly which instrumentation is
missing, so a later decision to add it is evidenced rather than assumed.

Exit codes follow this repo's convention:
    0  verifier records were found and reported
    2  the trace could not be read
    3  nothing to check -- no verifier events in this workspace
   64  usage error
"""

import argparse
import json
import os
import sys

sys.dont_write_bytecode = True

UNKNOWN = "UNKNOWN"

# Event types that represent a verifier doing something. Derived from
# autonomy/run.sh's emit_event_json call sites, not invented here.
_VERIFIER_EVENTS = {
    "code_review_start",
    "code_review_complete",
    "code_review_council_complete",
    "review_verification_failed",
    "managed_review_council_ok",
    "gate_stuck",
    "policy_denied",
    "task_completion_claim",
}

# Fields a loop-harness manifest wants, and where each one comes from today.
# "" means no emitter records it, so the column reads UNKNOWN for every row.
_FIELD_SOURCES = {
    "verifier": "event type",
    "iteration": "iteration",
    "verdict": "partial: only the failure path records a reason",
    "eligible": "",
    "criterion": "",
    "retry_cap": "",
    "timeout_cap": "",
    "latency_ms": "",
    "tokens": "",
    "cost_usd": "",
    "changed_terminal_outcome": "",
    "false_positive_reviewed": "",
    "rollback_switch": "",
}


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo 2 means "could NOT be checked" -- a real answer about the
    subject. A mistyped flag is not that.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _events(path):
    """Every well-formed record, oldest first. A torn line is skipped.

    events.jsonl is appended to by concurrent shell writers, so a partial
    final line is normal operation and must not blank out the history behind
    it.
    """
    out = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except (ValueError, json.JSONDecodeError):
                    continue
                if isinstance(rec, dict):
                    out.append(rec)
    except OSError:
        return None
    return out


def _row(rec):
    """One verifier invocation, with every underivable field UNKNOWN."""
    data = rec.get("data") if isinstance(rec.get("data"), dict) else {}
    etype = rec.get("type") or UNKNOWN

    verdict = UNKNOWN
    if etype in ("code_review_complete", "managed_review_council_ok"):
        # Completion is not a verdict: these fire when the council FINISHED,
        # not when it approved. Recording "pass" here would invent an outcome.
        verdict = UNKNOWN
    elif etype == "review_verification_failed":
        verdict = data.get("reason") or "failed"
    elif etype == "policy_denied":
        verdict = "denied"

    row = {
        "verifier": etype,
        "timestamp": rec.get("timestamp") or UNKNOWN,
        "iteration": data.get("iteration", UNKNOWN),
        "verdict": verdict,
    }
    for field, source in _FIELD_SOURCES.items():
        if field in row:
            continue
        row[field] = UNKNOWN if not source else data.get(field, UNKNOWN)
    return row


def report(loki_dir):
    """The manifest envelope. Empty results always carry a reason."""
    path = os.path.join(loki_dir, "events.jsonl")
    env = {
        "report": "loop-harness-v1",
        "source": [path],
        "rows": [],
        "count": 0,
        "unmeasured_fields": sorted(f for f, s in _FIELD_SOURCES.items()
                                    if not s),
        "reason": None,
    }
    if not os.path.isdir(loki_dir):
        env["reason"] = "no .loki directory at %s" % loki_dir
        return env, 3
    if not os.path.isfile(path):
        env["reason"] = ("%s does not exist, so no verifier ever recorded "
                         "anything here" % path)
        return env, 3

    records = _events(path)
    if records is None:
        env["reason"] = "%s could not be read" % path
        return env, 2

    rows = [_row(r) for r in records if r.get("type") in _VERIFIER_EVENTS]
    if not rows:
        # NOT an empty table. "no verifier events" and "the verifiers all
        # passed" are different claims, and only one of them is supported.
        env["reason"] = (
            "no verifier events among %d records in this trace (the run "
            "predates verifier tracing, or no verifier ran)" % len(records))
        return env, 3

    env["rows"] = rows
    env["count"] = len(rows)
    return env, 0


def main(argv=None):
    parser = _Parser(description="loop-harness-v1 verifier manifest (read-only)")
    parser.add_argument("--loki-dir", default=os.environ.get("LOKI_DIR")
                        or os.path.join(os.getcwd(), ".loki"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    env, code = report(args.loki_dir)

    if args.json:
        print(json.dumps(env, indent=2))
        return code

    print("loop-harness-v1  source: %s" % ", ".join(env["source"]))
    if not env["rows"]:
        print("  nothing to check: %s" % env["reason"])
    else:
        print("  %-30s %-10s %s" % ("VERIFIER", "ITERATION", "VERDICT"))
        for r in env["rows"]:
            print("  %-30s %-10s %s"
                  % (r["verifier"], r["iteration"], r["verdict"]))
        print("  %d verifier records" % env["count"])
    print("")
    print("  NOT RECORDED BY THE RUNTIME (every row reads UNKNOWN):")
    for f in env["unmeasured_fields"]:
        print("    - %s" % f)
    print("  These are the fields a loop-harness manifest needs and the")
    print("  runtime does not emit. They are reported UNKNOWN rather than")
    print("  defaulted, because a fabricated verification manifest is worse")
    print("  than an absent one.")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
