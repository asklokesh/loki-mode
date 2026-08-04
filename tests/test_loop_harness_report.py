"""loop-harness-v1 must not fabricate a verification manifest.

WHAT THIS GUARDS. A loop-harness manifest wants per-verifier eligibility,
criterion, retry and timeout caps, latency, tokens, cash cost, verdict,
whether the verdict changed the terminal outcome, false-positive review, and a
rollback switch. Measured at v9.12.5 the runtime emits almost none of it:

    code_review_complete        review_id, source, iteration
    review_verification_failed  reason, iteration, implementation_retry
    the three gate functions     nothing structured at all

The temptation in a reporting layer is to fill the gaps with defaults -- 0.0
for a cost, "yes" for eligibility, "pass" for a verdict. Every one of those
asserts a measurement nobody took, and a fabricated manifest ABOUT VERIFICATION
is worse than no manifest: it launders the absence of evidence into evidence.

So the tests below pin the honest behaviour, in both directions:

  - underivable fields read UNKNOWN, never a default
  - "no verifier events" is exit 3 with a reason, never an empty table that
    reads as a clean run
  - completion is NOT a verdict: code_review_complete fires when the council
    FINISHED, not when it approved
  - a real recorded reason IS surfaced, so the UNKNOWNs are not blanket
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "loop-harness-report.py"


def _run(loki_dir, as_json=True):
    argv = [sys.executable, str(_TOOL), "--loki-dir", str(loki_dir)]
    if as_json:
        argv.append("--json")
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=60)
    payload = None
    if as_json and proc.stdout.strip():
        try:
            payload = json.loads(proc.stdout)
        except ValueError:
            payload = None
    return proc.returncode, payload, proc.stdout


def _workspace(events=()):
    d = tempfile.mkdtemp()
    loki = os.path.join(d, ".loki")
    os.makedirs(loki, exist_ok=True)
    with open(os.path.join(loki, "events.jsonl"), "w") as fh:
        for rec in events:
            fh.write(json.dumps(rec) + "\n")
    return loki


class AnAbsentMeasurementIsNeverADefault(unittest.TestCase):

    def test_underivable_fields_read_unknown(self):
        loki = _workspace([{
            "type": "code_review_complete",
            "timestamp": "2026-08-04T01:00:00Z",
            "data": {"iteration": 1, "review_id": "r1"},
        }])
        code, env, _ = _run(loki)
        self.assertEqual(code, 0)
        row = env["rows"][0]
        for field in ("cost_usd", "tokens", "latency_ms", "eligible",
                      "criterion", "retry_cap", "timeout_cap",
                      "changed_terminal_outcome", "false_positive_reviewed",
                      "rollback_switch"):
            self.assertEqual(
                row[field], "UNKNOWN",
                "%s was defaulted to %r; the runtime does not emit it, and a "
                "manifest that fills it in is asserting a measurement nobody "
                "took" % (field, row[field]))

    def test_completion_is_not_a_verdict(self):
        """code_review_complete fires when the council FINISHED, not when it
        approved. Recording "pass" would invent an outcome."""
        loki = _workspace([{
            "type": "code_review_complete",
            "timestamp": "2026-08-04T01:00:00Z",
            "data": {"iteration": 1},
        }])
        _code, env, _ = _run(loki)
        self.assertEqual(
            env["rows"][0]["verdict"], "UNKNOWN",
            "a completion event was reported as a verdict; finishing and "
            "approving are different claims")

    def test_a_real_recorded_reason_is_surfaced(self):
        """Vacuity guard: if EVERY column were UNKNOWN the report would be
        useless and the assertions above would prove nothing."""
        loki = _workspace([{
            "type": "review_verification_failed",
            "timestamp": "2026-08-04T01:05:00Z",
            "data": {"iteration": 2, "reason": "infrastructure_inconclusive"},
        }])
        _code, env, _ = _run(loki)
        self.assertEqual(env["rows"][0]["verdict"],
                         "infrastructure_inconclusive")


class EmptyIsNeverReportedAsClean(unittest.TestCase):

    def test_a_trace_with_no_verifier_events_exits_3_with_a_reason(self):
        loki = _workspace([{"type": "session_start",
                            "timestamp": "2026-08-04T01:00:00Z"}])
        code, env, _ = _run(loki)
        self.assertEqual(
            code, 3,
            "a trace with no verifier events did not exit 3 (nothing to "
            "check)")
        self.assertEqual(env["rows"], [])
        self.assertTrue(
            env["reason"],
            "an empty result carried no reason; 'no verifier ran' and 'the "
            "verifiers all passed' would be indistinguishable")

    def test_a_missing_workspace_exits_3_and_says_so(self):
        d = tempfile.mkdtemp()
        code, env, _ = _run(os.path.join(d, ".loki"))
        self.assertEqual(code, 3)
        self.assertIn("no .loki", (env["reason"] or "").lower())

    def test_the_unmeasured_field_list_is_reported(self):
        """The UNKNOWNs are the deliverable: the report must name which
        instrumentation is missing."""
        loki = _workspace()
        _code, env, _ = _run(loki)
        self.assertIn("cost_usd", env["unmeasured_fields"])
        self.assertIn("latency_ms", env["unmeasured_fields"])


class TheToolIsReadOnly(unittest.TestCase):

    def test_it_writes_nothing_to_the_workspace(self):
        loki = _workspace([{"type": "code_review_complete",
                            "timestamp": "2026-08-04T01:00:00Z",
                            "data": {"iteration": 1}}])
        before = sorted(os.listdir(loki))
        _run(loki)
        self.assertEqual(
            sorted(os.listdir(loki)), before,
            "the report wrote into the workspace it was reading; it is "
            "specified as read-only and rollback assumes no state to unwind")

    def test_a_usage_error_exits_64_not_2(self):
        """2 means 'could not check the subject'. A bad flag is not that."""
        proc = subprocess.run(
            [sys.executable, str(_TOOL), "--no-such-flag"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 64)


if __name__ == "__main__":
    unittest.main()
