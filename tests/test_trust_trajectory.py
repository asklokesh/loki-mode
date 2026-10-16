"""tests/test_trust_trajectory.py -- R4 visible trust trajectory derivation.

Covers:
  - aggregation from fixture proof.json files (council/gate/iterations axes)
  - direction calc up / down / flat per axis polarity (higher- vs lower-better)
  - the insufficient-history (<2 runs) case -> insufficient=True, no fake trend
  - no-PII: only derived numbers + run_id + timestamps leave the function
  - malformed proof.json is skipped, not fatal
  - the intervention axis is available=False until a proof carries it
  - JSON/human formatting are stable and parseable
  - the cache file is written under .loki/metrics/

All fixtures are written to a tmp .loki dir; no provider calls, no paid calls.
The module filename uses an underscore so it imports directly (unlike
proof-generator.py which is invoked as a subprocess).
"""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODULE_PATH = os.path.join(_REPO, "autonomy", "lib", "trust_trajectory.py")

_spec = importlib.util.spec_from_file_location("trust_trajectory", _MODULE_PATH)
tt = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(tt)


def _write_proof(loki_dir, run_id, *, generated_at, final_verdict=None,
                 gates_passed=None, gates_total=None, iterations=None,
                 interventions=None, reviewers=None, raw=None):
    """Write a .loki/proofs/<run_id>/proof.json fixture."""
    d = os.path.join(loki_dir, "proofs", run_id)
    os.makedirs(d, exist_ok=True)
    if raw is not None:
        proof = raw
    else:
        council = {"enabled": True}
        if final_verdict is not None:
            council["final_verdict"] = final_verdict
        if reviewers is not None:
            council["reviewers"] = reviewers
        if interventions is not None:
            council["interventions"] = interventions
        quality_gates = {}
        if gates_passed is not None and gates_total is not None:
            quality_gates = {"passed": gates_passed, "total": gates_total}
        proof = {
            "schema_version": "1.0",
            "run_id": run_id,
            "generated_at": generated_at,
            "council": council,
            "quality_gates": quality_gates,
        }
        if iterations is not None:
            proof["iterations"] = {"count": iterations}
    with open(os.path.join(d, "proof.json"), "w", encoding="utf-8") as fh:
        json.dump(proof, fh)


class TestInsufficientHistory(unittest.TestCase):
    def test_no_proofs_dir(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            traj = tt.compute_trajectory(loki)
            self.assertEqual(traj["runs_count"], 0)
            self.assertTrue(traj["insufficient"])
            self.assertTrue(any("not enough history" in n for n in traj["notes"]))

    def test_single_run_is_insufficient(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="APPROVED", gates_passed=5, gates_total=5,
                         iterations=3)
            traj = tt.compute_trajectory(loki)
            self.assertEqual(traj["runs_count"], 1)
            self.assertTrue(traj["insufficient"])
            # No fake direction: single-run axes are flat with insufficient flag.
            cp = traj["axes"]["council_pass_rate"]
            self.assertTrue(cp["available"])
            self.assertTrue(cp.get("insufficient"))
            self.assertEqual(cp["direction"], "flat")
            self.assertIsNone(cp["improving"])


class TestDirectionUp(unittest.TestCase):
    def test_council_pass_rate_improving(self):
        # Earlier runs fail council, later runs pass -> council_pass_rate up,
        # and up is the GOOD direction for that axis (higher is better).
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="REJECTED")
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         final_verdict="REJECTED")
            _write_proof(loki, "r3", generated_at="2026-06-03T00:00:00Z",
                         final_verdict="APPROVED")
            _write_proof(loki, "r4", generated_at="2026-06-04T00:00:00Z",
                         final_verdict="APPROVED")
            traj = tt.compute_trajectory(loki)
            self.assertFalse(traj["insufficient"])
            cp = traj["axes"]["council_pass_rate"]
            self.assertEqual(cp["direction"], "up")
            self.assertTrue(cp["improving"])
            self.assertGreater(cp["delta"], 0)
            self.assertIn("council_pass_rate", traj["improving_axes"])

    def test_gate_pass_rate_improving(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         gates_passed=1, gates_total=4)
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         gates_passed=4, gates_total=4)
            traj = tt.compute_trajectory(loki)
            g = traj["axes"]["gate_pass_rate"]
            self.assertEqual(g["direction"], "up")
            self.assertTrue(g["improving"])


class TestDirectionDown(unittest.TestCase):
    def test_iterations_decreasing_is_improving(self):
        # Fewer iterations to completion over time -> direction down, but down
        # is the GOOD direction for iterations (lower is better).
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         iterations=10)
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         iterations=8)
            _write_proof(loki, "r3", generated_at="2026-06-03T00:00:00Z",
                         iterations=4)
            _write_proof(loki, "r4", generated_at="2026-06-04T00:00:00Z",
                         iterations=3)
            traj = tt.compute_trajectory(loki)
            it = traj["axes"]["iterations"]
            self.assertEqual(it["direction"], "down")
            self.assertTrue(it["improving"])  # lower is better
            self.assertIn("iterations", traj["improving_axes"])

    def test_council_pass_rate_regressing(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="APPROVED")
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         final_verdict="REJECTED")
            traj = tt.compute_trajectory(loki)
            cp = traj["axes"]["council_pass_rate"]
            self.assertEqual(cp["direction"], "down")
            self.assertFalse(cp["improving"])  # down on higher-is-better = bad
            self.assertIn("council_pass_rate", traj["regressing_axes"])


class TestDirectionFlat(unittest.TestCase):
    def test_constant_values_are_flat(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            for i, day in enumerate(("01", "02", "03", "04"), start=1):
                _write_proof(loki, "r%d" % i,
                             generated_at="2026-06-%sT00:00:00Z" % day,
                             final_verdict="APPROVED",
                             gates_passed=5, gates_total=5, iterations=4)
            traj = tt.compute_trajectory(loki)
            for axis in ("council_pass_rate", "gate_pass_rate", "iterations"):
                ax = traj["axes"][axis]
                self.assertEqual(ax["direction"], "flat", axis)
                self.assertIsNone(ax["improving"], axis)


class TestInterventionsAxis(unittest.TestCase):
    def test_unavailable_when_not_recorded(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="APPROVED")
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         final_verdict="APPROVED")
            traj = tt.compute_trajectory(loki)
            iv = traj["axes"]["interventions"]
            self.assertFalse(iv["available"])
            self.assertTrue(any("intervention trend unavailable" in n
                                for n in traj["notes"]))

    def test_available_and_decreasing_when_recorded(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="APPROVED", interventions=5)
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         final_verdict="APPROVED", interventions=1)
            traj = tt.compute_trajectory(loki)
            iv = traj["axes"]["interventions"]
            self.assertTrue(iv["available"])
            self.assertEqual(iv["direction"], "down")
            self.assertTrue(iv["improving"])  # fewer interventions = good


class TestReviewerFallback(unittest.TestCase):
    def test_reviewers_used_when_no_final_verdict(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            # No final_verdict; all reviewers approve -> pass=1.0.
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         reviewers=[{"vote": "APPROVE"}, {"vote": "REJECT"}])
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         reviewers=[{"vote": "APPROVE"}, {"vote": "APPROVE"}])
            traj = tt.compute_trajectory(loki)
            cp = traj["axes"]["council_pass_rate"]
            # r1 not unanimous -> 0.0, r2 unanimous -> 1.0 => improving up.
            self.assertEqual(cp["direction"], "up")
            self.assertTrue(cp["improving"])


class TestRobustness(unittest.TestCase):
    def test_malformed_proof_is_skipped(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "good1", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="APPROVED")
            _write_proof(loki, "good2", generated_at="2026-06-02T00:00:00Z",
                         final_verdict="APPROVED")
            # Write a garbage proof.json.
            bad = os.path.join(loki, "proofs", "bad")
            os.makedirs(bad, exist_ok=True)
            with open(os.path.join(bad, "proof.json"), "w", encoding="utf-8") as fh:
                fh.write("{not valid json")
            traj = tt.compute_trajectory(loki)
            # Only the two good runs counted; no exception.
            self.assertEqual(traj["runs_count"], 2)

    def test_time_ordering_respected(self):
        # Write out of order; series must come back ascending by generated_at.
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "later", generated_at="2026-06-09T00:00:00Z",
                         final_verdict="APPROVED")
            _write_proof(loki, "earlier", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="REJECTED")
            traj = tt.compute_trajectory(loki)
            ids = [s["run_id"] for s in traj["series"]]
            self.assertEqual(ids, ["earlier", "later"])


class TestNoPII(unittest.TestCase):
    def test_malformed_active_s_is_unmeasured(self):
        self.assertEqual(
            tt._intervention_detail({"interventions_detail": {"active_s": 1.5}})[2], None)
        self.assertEqual(
            tt._intervention_detail({"interventions_detail": {"active_s": -1}})[2], None)
        self.assertEqual(
            tt._intervention_detail({"interventions_detail": {"active_s": 90}})[2], 90)

    def test_only_derived_fields_leave_the_function(self):
        # A proof carrying a secret-looking spec/diff must NOT surface that
        # text anywhere in the trajectory output. Only run_id, timestamps, and
        # derived numeric axes are emitted.
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            secret = "API_KEY=sk-do-not-leak-12345"
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         raw={
                             "run_id": "r1",
                             "generated_at": "2026-06-01T00:00:00Z",
                             "spec": {"text": secret, "source": "/home/u/secret.md"},
                             "diffs": [secret],
                             "council": {"enabled": True, "final_verdict": "APPROVED",
                                         "reviewers": [{"summary": secret}]},
                             "quality_gates": {"passed": 5, "total": 5},
                             "iterations": {"count": 3},
                         })
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         raw={
                             "run_id": "r2",
                             "generated_at": "2026-06-02T00:00:00Z",
                             "spec": {"text": secret},
                             "council": {"enabled": True, "final_verdict": "APPROVED"},
                             "quality_gates": {"passed": 5, "total": 5},
                             "iterations": {"count": 2},
                         })
            traj = tt.compute_trajectory(loki)
            blob = tt.format_trajectory_json(traj)
            self.assertNotIn(secret, blob)
            self.assertNotIn("sk-do-not-leak", blob)
            self.assertNotIn("/home/u/secret.md", blob)
            self.assertNotIn("API_KEY", blob)
            # Human format too.
            human = tt.format_trajectory_human(traj)
            self.assertNotIn(secret, human)
            # The series carries only the whitelisted keys.
            allowed = {"run_id", "generated_at", "council_pass_rate",
                       "gate_pass_rate", "iterations", "interventions",
                       "verdict", "false_verified", "cost_usd",
                       "interventions_by_type", "waited_s", "active_s"}
            for row in traj["series"]:
                self.assertTrue(set(row.keys()).issubset(allowed),
                                "series row leaked extra keys: %s" % set(row.keys()))


class TestFormatting(unittest.TestCase):
    def test_json_is_parseable_and_versioned(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="APPROVED")
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         final_verdict="APPROVED")
            traj = tt.compute_trajectory(loki)
            parsed = json.loads(tt.format_trajectory_json(traj))
            self.assertEqual(parsed["schema_version"], 1)
            self.assertIn("axes", parsed)
            self.assertIn("series", parsed)

    def test_human_has_headline_and_axes(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="REJECTED", gates_passed=2, gates_total=4)
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         final_verdict="APPROVED", gates_passed=4, gates_total=4)
            human = tt.format_trajectory_human(tt.compute_trajectory(loki))
            self.assertIn("Trust Trajectory", human)
            self.assertIn("Council pass rate", human)
            self.assertIn("Gate pass rate", human)

    def test_insufficient_human_says_not_enough(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="APPROVED")
            human = tt.format_trajectory_human(tt.compute_trajectory(loki))
            self.assertIn("Not enough history yet", human)


class TestCache(unittest.TestCase):
    def test_cache_written_under_metrics(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            _write_proof(loki, "r1", generated_at="2026-06-01T00:00:00Z",
                         final_verdict="APPROVED")
            _write_proof(loki, "r2", generated_at="2026-06-02T00:00:00Z",
                         final_verdict="APPROVED")
            traj = tt.compute_trajectory(loki)
            path = tt.write_trajectory_cache(loki, traj)
            self.assertIsNotNone(path)
            self.assertTrue(os.path.isfile(path))
            self.assertEqual(
                os.path.normpath(path),
                os.path.normpath(os.path.join(loki, "metrics", "trust-trajectory.json")),
            )
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["schema_version"], 1)


class TestOutcomeEffort(unittest.TestCase):
    """Parity with loki-ts/tests/metrics/trust.test.ts outcome effort block."""

    def _raw(self, loki, rid, n, **extra):
        ts = "2026-06-0%dT00:00:00Z" % n
        raw = {"run_id": rid, "generated_at": ts}
        raw.update(extra)
        _write_proof(loki, rid, generated_at=ts, raw=raw)

    @staticmethod
    def _detail(i, a, w):
        return {"interventions_detail": {
            "by_type": {"steer": 0, "input": i, "authorization": a, "repair": 0},
            "waited_s": w}}

    def test_mixed_fixture(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            self._raw(loki, "r1", 1, verdict="VERIFIED", cost={"usd": 1}, interventions=1, **self._detail(1, 0, 120))
            self._raw(loki, "r2", 2, verdict="VERIFIED", cost={"usd": 2}, interventions=0, **self._detail(0, 0, 0))
            self._raw(loki, "r3", 3, verdict="VERIFIED", later_verdict="FAILED", cost={"usd": 3},
                      interventions=1, **self._detail(0, 1, 60))
            self._raw(loki, "r4", 4, verdict="FAILED", interventions=0, **self._detail(0, 0, 0))
            eff = tt.compute_trajectory(loki)["outcome_effort"]
            self.assertEqual(eff["accepted"], 2)
            self.assertEqual(eff["claimed_verified"], 3)
            self.assertEqual(eff["false_verified"], 1)
            self.assertAlmostEqual(eff["misleading_completion_rate"], 1 / 3, places=3)
            self.assertIsNone(eff["cost_per_accepted_usd"])
            self.assertIn("unmeasured", eff["cost_note"])
            self.assertEqual(eff["interventions_by_type"],
                             {"steer": 0, "input": 1, "authorization": 1, "repair": 0})
            self.assertEqual(eff["interventions_per_accepted"], 1)
            self.assertEqual(eff["waited_min_per_accepted"], 1.5)
            self.assertIn("waited, upper bound",
                          tt.format_trajectory_human(tt.compute_trajectory(loki)))

    def test_cost_per_accepted_and_nulls(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            self._raw(loki, "r1", 1, verdict="VERIFIED", cost={"usd": 1})
            self._raw(loki, "r2", 2, verdict="FAILED", cost={"usd": 3})
            eff = tt.compute_trajectory(loki)["outcome_effort"]
            self.assertEqual(eff["cost_per_accepted_usd"], 4)
            self.assertIsNone(eff["interventions_per_accepted"])
            self.assertIsNone(eff["waited_min_per_accepted"])
            self.assertIsNone(eff["interventions_by_type"])

    def test_no_accepted(self):
        with tempfile.TemporaryDirectory() as td:
            loki = os.path.join(td, ".loki")
            self._raw(loki, "r1", 1, verdict="FAILED", cost={"usd": 1})
            eff = tt.compute_trajectory(loki)["outcome_effort"]
            self.assertIsNone(eff["cost_per_accepted_usd"])
            self.assertIn("no accepted", eff["cost_note"])
            self.assertIsNone(eff["misleading_completion_rate"])


if __name__ == "__main__":
    unittest.main()
