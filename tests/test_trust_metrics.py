"""tests/test_trust_metrics.py -- trust-layer metrics aggregator.

Covers the four AVAILABLE-TODAY metrics from
internal/BENCHMARK-PROGRAM-2026-06.md section 3, computed from a synthetic
.loki tree:
  - Metric 1 evidence-gate block rate over INSTRUMENTED runs (not the proof
    corpus), proving the honesty rule that distinguishes "0 measured" from
    "not instrumented"
  - Metric 2 gate failure distribution (median, p90, per-gate breakdown)
  - Metric 3 council rejection rate and split-verdict-among-rejections rate
  - Metric 4 cost-per-verified-task over the local verified denominator,
    excluding verified runs without cost data and refusing to divide by zero
  - record_trust_event appends durable JSONL and never raises
  - empty / proofs-only corpus yields available=False, never a fabricated 0
  - JSON / human formatting are stable and parseable

All fixtures are written to a tmp .loki dir; no provider calls, no paid calls.
The module filename uses an underscore so it imports directly.
"""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODULE_PATH = os.path.join(_REPO, "autonomy", "lib", "trust_metrics.py")

_spec = importlib.util.spec_from_file_location("trust_metrics", _MODULE_PATH)
tm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tm)


def _write_proof(loki_dir, run_id, final_verdict, usd=None, tokens=None):
    d = os.path.join(loki_dir, "proofs", run_id)
    os.makedirs(d, exist_ok=True)
    cost = {}
    if usd is not None:
        cost["usd"] = usd
    if tokens is not None:
        cost["total_tokens"] = tokens
    proof = {
        "run_id": run_id,
        "council": {"final_verdict": final_verdict},
        "cost": cost,
    }
    with open(os.path.join(d, "proof.json"), "w", encoding="utf-8") as fh:
        json.dump(proof, fh)


class TestRecordEvent(unittest.TestCase):
    def test_append_and_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            loki = os.path.join(tmp, ".loki")
            self.assertTrue(tm.record_trust_event(loki, "run_start", run_id="A", iteration=0))
            self.assertTrue(tm.record_trust_event(loki, "gate_failure", run_id="A", iteration=1, gate="tests"))
            events = tm._load_events(loki)
            self.assertEqual(len(events), 2)
            self.assertEqual(events[0]["type"], "run_start")
            self.assertEqual(events[0]["run_id"], "A")
            self.assertEqual(events[1]["gate"], "tests")
            # Each record carries the join key + iteration + ts.
            for e in events:
                self.assertIn("run_id", e)
                self.assertIn("iteration", e)
                self.assertIn("ts", e)

    def test_never_raises_on_bad_dir(self):
        # A path under a file (un-creatable) must not raise; returns False.
        with tempfile.NamedTemporaryFile() as f:
            bad = os.path.join(f.name, "nope", ".loki")
            self.assertFalse(tm.record_trust_event(bad, "run_start", run_id="A"))

    def test_torn_line_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            loki = os.path.join(tmp, ".loki")
            tm.record_trust_event(loki, "run_start", run_id="A", iteration=0)
            path = os.path.join(loki, "metrics", "trust-events.jsonl")
            with open(path, "a", encoding="utf-8") as fh:
                fh.write('{"type": "council_vote", "run_id":\n')  # torn line
            events = tm._load_events(loki)
            self.assertEqual(len(events), 1)


class TestMetricsHappyPath(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.loki = os.path.join(self._td.name, ".loki")
        # Run A: instrumented, 1 block, 2 gate failures, 1 split-reject + 1 approve
        tm.record_trust_event(self.loki, "run_start", run_id="A", iteration=0)
        tm.record_trust_event(self.loki, "gate_failure", run_id="A", iteration=1, gate="tests")
        tm.record_trust_event(self.loki, "gate_failure", run_id="A", iteration=1, gate="lint")
        tm.record_trust_event(self.loki, "evidence_block", run_id="A", iteration=1, reason="empty_diff")
        tm.record_trust_event(self.loki, "council_vote", run_id="A", iteration=2, approve=1, reject=2, result="REJECTED")
        tm.record_trust_event(self.loki, "council_vote", run_id="A", iteration=3, approve=3, reject=0, result="APPROVED")
        # Run B: instrumented, no block, 1 approve
        tm.record_trust_event(self.loki, "run_start", run_id="B", iteration=0)
        tm.record_trust_event(self.loki, "council_vote", run_id="B", iteration=1, approve=3, reject=0, result="APPROVED")
        # proofs: A + B verified with cost, C verified without cost
        _write_proof(self.loki, "A", "APPROVED", usd=2.0, tokens=1000)
        _write_proof(self.loki, "B", "APPROVED", usd=4.0, tokens=3000)
        _write_proof(self.loki, "C", "APPROVED")
        self.m = tm.compute_trust_metrics(self.loki)

    def tearDown(self):
        self._td.cleanup()

    def test_metric1_block_rate_over_instrumented_runs(self):
        e = self.m["metrics"]["evidence_block_rate"]
        self.assertTrue(e["available"])
        # Denominator is instrumented runs (2), NOT the 3-proof corpus.
        self.assertEqual(e["instrumented_runs"], 2)
        self.assertEqual(e["runs_with_block"], 1)
        self.assertEqual(e["block_events_total"], 1)
        self.assertEqual(e["block_rate"], 0.5)

    def test_metric2_gate_distribution(self):
        g = self.m["metrics"]["gate_failure_distribution"]
        self.assertTrue(g["available"])
        self.assertEqual(g["instrumented_runs"], 2)
        self.assertEqual(g["total_gate_failures"], 2)
        # Per-run counts are [0 (B), 2 (A)] sorted -> median 1.0, p90 2, max 2.
        self.assertEqual(g["per_run_median"], 1.0)
        self.assertEqual(g["per_run_p90"], 2)
        self.assertEqual(g["per_run_max"], 2)
        self.assertEqual(g["gate_breakdown"], {"lint": 1, "tests": 1})

    def test_metric3_council_rejection_and_split(self):
        c = self.m["metrics"]["council_rejection_rate"]
        self.assertTrue(c["available"])
        self.assertEqual(c["total_votes"], 3)
        self.assertEqual(c["rejected_votes"], 1)
        self.assertEqual(c["rejection_rate"], round(1 / 3, 4))
        # The single reject had an approver -> split.
        self.assertEqual(c["split_rejected_votes"], 1)
        self.assertEqual(c["split_rate_of_rejections"], 1.0)

    def test_metric4_cost_per_verified_local_denominator(self):
        cv = self.m["metrics"]["cost_per_verified_task"]
        self.assertTrue(cv["available"])
        # 3 verified runs total, but only 2 carry cost.
        self.assertEqual(cv["verified_runs"], 3)
        self.assertEqual(cv["verified_runs_with_cost"], 2)
        # (2.0 + 4.0) / 2 = 3.0 ; (1000 + 3000) / 2 = 2000.
        self.assertEqual(cv["usd_per_verified"], 3.0)
        self.assertEqual(cv["tokens_per_verified"], 2000.0)

    def test_formatting_stable(self):
        human = tm.format_metrics_human(self.m)
        self.assertIn("Evidence-gate block rate", human)
        self.assertIn("Cost per VERIFIED task", human)
        parsed = json.loads(tm.format_metrics_json(self.m))
        self.assertEqual(parsed["schema_version"], tm.SCHEMA_VERSION)


class TestHonestyRule(unittest.TestCase):
    def test_proofs_only_corpus_is_not_instrumented(self):
        # An old corpus (proofs, no event log) must NOT report 0% block rate.
        with tempfile.TemporaryDirectory() as tmp:
            loki = os.path.join(tmp, ".loki")
            _write_proof(loki, "X", "APPROVED")
            m = tm.compute_trust_metrics(loki)
            self.assertFalse(m["metrics"]["evidence_block_rate"]["available"])
            self.assertFalse(m["metrics"]["gate_failure_distribution"]["available"])
            self.assertFalse(m["metrics"]["council_rejection_rate"]["available"])
            # Cost: no proof carries cost -> not available, not $0.
            self.assertFalse(m["metrics"]["cost_per_verified_task"]["available"])

    def test_empty_corpus_all_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            loki = os.path.join(tmp, ".loki")
            m = tm.compute_trust_metrics(loki)
            for key in ("evidence_block_rate", "gate_failure_distribution",
                        "council_rejection_rate", "cost_per_verified_task"):
                self.assertFalse(m["metrics"][key]["available"], key)

    def test_instrumented_run_with_zero_events_is_measured_zero(self):
        # A run_start with no block/gate events is a MEASURED 0, available=True.
        with tempfile.TemporaryDirectory() as tmp:
            loki = os.path.join(tmp, ".loki")
            tm.record_trust_event(loki, "run_start", run_id="A", iteration=0)
            m = tm.compute_trust_metrics(loki)
            e = m["metrics"]["evidence_block_rate"]
            self.assertTrue(e["available"])
            self.assertEqual(e["block_rate"], 0.0)
            self.assertEqual(e["instrumented_runs"], 1)

    def test_cost_exists_but_no_verified_run_refuses_divide(self):
        with tempfile.TemporaryDirectory() as tmp:
            loki = os.path.join(tmp, ".loki")
            _write_proof(loki, "X", "REJECTED", usd=5.0, tokens=100)
            m = tm.compute_trust_metrics(loki)
            cv = m["metrics"]["cost_per_verified_task"]
            self.assertFalse(cv["available"])
            self.assertEqual(cv["verified_runs"], 0)


if __name__ == "__main__":
    unittest.main()
