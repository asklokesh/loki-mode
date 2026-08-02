"""A cost gate that greens an unmeasured run is worse than no gate.

tools/cost-guard.py exists to fail a merge when cost regressed. Its exit code
IS the merge decision, so the dangerous defect is not a wrong number -- it is a
confident 0 emitted when nothing was measured. That maps "no evidence" onto
"evidence of compliance", and makes the gate loudest at exactly the moment
instrumentation broke.

The whole suite runs the CLI through subprocess and asserts the REAL exit code,
because the exit code is the product. Nothing here imports the tool: it has a
hyphen in its name, and a stale .pyc from spec_from_file_location has produced
false mutation-probe results before.

Both directions are asserted. A guard so strict it also refused a genuinely
measured $0.00 would be the same lie pointed the other way -- zero is falsy, and
a falsy guard blanks a real observation (v8.72.0).
"""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_GUARD = _ROOT / "tools" / "cost-guard.py"

# Records present, every field zero: the exact shape a real run produced when
# the provider wrote no usage. record_is_measured() calls this UNMEASURED.
_UNMEASURED = {
    "iteration": 1, "input_tokens": 0, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "cost_usd": 0, "model": "high", "status": "completed",
}

_MEASURED = {
    "iteration": 1, "input_tokens": 9412, "output_tokens": 23,
    "cache_read_tokens": 11008, "cache_creation_tokens": 0,
    "cost_usd": 2.50, "model": "gpt-5.6-sol", "status": "completed",
}

# A REAL observation that happens to price at zero: tokens were counted, the
# cost was $0.00. Distinct from _UNMEASURED, and it must PASS.
_MEASURED_FREE = {
    "iteration": 1, "input_tokens": 5000, "output_tokens": 100,
    "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "cost_usd": 0.0, "model": "local-free", "status": "completed",
}


def _workspace(*records):
    d = pathlib.Path(tempfile.mkdtemp())
    eff = d / ".loki" / "metrics" / "efficiency"
    eff.mkdir(parents=True, exist_ok=True)
    for i, rec in enumerate(records, start=1):
        (eff / ("iteration-%d.json" % i)).write_text(
            json.dumps(rec), encoding="utf-8")
    return d


def _baseline(usd, **over):
    """A minimal proof.json carrying a measured cost block."""
    cost = {"usd": usd, "input_tokens": 1000, "output_tokens": 50,
            "cache_read_tokens": 0, "cache_creation_tokens": 0,
            "available": True}
    cost.update(over)
    path = pathlib.Path(tempfile.mkdtemp()) / "proof.json"
    path.write_text(json.dumps({"cost": cost}), encoding="utf-8")
    return path


def _run(*args):
    """The CLI, as CI runs it. sys.executable so a 3.12 run tests 3.12."""
    p = subprocess.run(
        [sys.executable, str(_GUARD)] + [str(a) for a in args],
        capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout + p.stderr


class UnmeasuredNeverPassesTheGate(unittest.TestCase):
    """The defect this whole feature exists to prevent."""

    def setUp(self):
        self.ws = _workspace(_UNMEASURED)

    def test_absolute_ceiling_cannot_be_evaluated(self):
        rc, out = _run(self.ws, "--max-usd", "5.00")
        self.assertNotEqual(
            rc, 0, "an UNMEASURED run passed a cost gate: absence was read as "
                   "compliance, which is the exact failure this gate exists "
                   "to prevent")
        self.assertEqual(rc, 2, "unmeasured must be 'cannot evaluate' (2), "
                                "not a regression verdict")
        self.assertIn("UNMEASURED", out,
                      "the output must SAY it could not measure, or a reader "
                      "cannot tell 2 apart from a broken invocation")

    def test_percentage_policy_cannot_be_evaluated_either(self):
        """The second policy path must fail closed the same way."""
        rc, out = _run(self.ws, "--baseline", _baseline(1.00),
                       "--max-increase-pct", "10")
        self.assertEqual(rc, 2)
        self.assertIn("UNMEASURED", out)

    def test_json_output_also_refuses(self):
        rc, out = _run(self.ws, "--max-usd", "5.00", "--json")
        self.assertEqual(rc, 2)
        d = json.loads(out)
        self.assertEqual(d["status"], "cannot_evaluate")
        self.assertIsNone(d["actual_usd"], "an unmeasured cost was rendered "
                                           "as a number")

    def test_missing_workspace_is_not_a_pass(self):
        rc, _ = _run(pathlib.Path(tempfile.mkdtemp()), "--max-usd", "5.00")
        self.assertEqual(rc, 2, "a workspace with no records at all passed")

    def test_no_policy_is_not_a_pass(self):
        """A gate given nothing to check must not report a green check."""
        rc, out = _run(_workspace(_MEASURED))
        self.assertEqual(rc, 2, "the gate checked nothing and said PASS")
        self.assertIn("no budget policy", out)

    def test_half_a_policy_is_not_a_pass(self):
        """--baseline without --max-increase-pct would be silently ignored."""
        rc, out = _run(_workspace(_MEASURED), "--max-usd", "5.00",
                       "--baseline", _baseline(1.00))
        self.assertEqual(rc, 2, "the baseline was ignored and a pass reported")
        self.assertIn("half applied", out)

    def test_unmeasured_baseline_is_not_a_pass(self):
        """Half a measurement is not a measurement."""
        rc, out = _run(_workspace(_MEASURED), "--baseline",
                       _baseline(0.0, input_tokens=0, output_tokens=0),
                       "--max-increase-pct", "10")
        self.assertEqual(rc, 2)
        self.assertIn("no measured cost", out)

    def test_unreadable_baseline_is_not_a_pass(self):
        rc, _ = _run(_workspace(_MEASURED), "--baseline", "/nope/proof.json",
                     "--max-increase-pct", "10")
        self.assertEqual(rc, 2)


class MeasuredCostIsJudgedOnItsNumber(unittest.TestCase):

    def test_within_budget_passes(self):
        rc, out = _run(_workspace(_MEASURED), "--max-usd", "5.00")
        self.assertEqual(rc, 0, out)
        self.assertIn("WITHIN BUDGET", out)
        self.assertIn("2.50", out)

    def test_over_budget_fails_and_names_the_number(self):
        rc, out = _run(_workspace(_MEASURED), "--max-usd", "1.00")
        self.assertEqual(rc, 1)
        self.assertIn("2.50", out, "the breaching cost was not named")
        self.assertIn("1.00", out, "the ceiling it breached was not named")
        self.assertIn("1.50", out, "the amount of the breach was not named")

    def test_a_measured_zero_passes(self):
        """Zero is falsy. A falsy guard would call this unmeasured."""
        rc, out = _run(_workspace(_MEASURED_FREE), "--max-usd", "5.00")
        self.assertEqual(
            rc, 0, "a genuinely measured $0.00 was refused, which blanks a "
                   "real observation: %s" % out)
        self.assertIn("0.0000", out)

    def test_exactly_at_the_ceiling_passes(self):
        """Binary floats sum $0.10+$0.20 to just OVER $0.30.

        Compared raw, a run exactly at its budget fails and the message reads
        "$0.3000 exceeds the ceiling $0.3000 by $0.0000" -- a verdict its own
        output contradicts.
        """
        a = dict(_MEASURED, cost_usd=0.1)
        b = dict(_MEASURED, cost_usd=0.2)
        rc, out = _run(_workspace(a, b), "--max-usd", "0.30")
        self.assertEqual(rc, 0, "a run exactly at its ceiling was failed: %s"
                                % out)

    def test_one_cent_over_the_ceiling_still_fails(self):
        """The rounding above is a LOOSENING; this pins how far it goes.

        Without this, round(actual - max_usd, 0) -- a whole-dollar tolerance --
        passes every other test in this file.
        """
        rc, out = _run(_workspace(dict(_MEASURED, cost_usd=1.01)),
                       "--max-usd", "1.00")
        self.assertEqual(rc, 1, "a cent over budget was tolerated: %s" % out)

    def test_summed_across_iterations(self):
        rc, out = _run(_workspace(_MEASURED, _MEASURED), "--max-usd", "4.00",
                       "--json")
        self.assertEqual(rc, 1, "per-iteration costs were not summed")
        self.assertAlmostEqual(json.loads(out)["actual_usd"], 5.00, places=4)


class PercentageIncreaseMath(unittest.TestCase):

    def _pct(self, actual_usd, baseline_usd, allowed):
        rec = dict(_MEASURED, cost_usd=actual_usd)
        return _run(_workspace(rec), "--baseline", _baseline(baseline_usd),
                    "--max-increase-pct", allowed, "--json")

    def test_increase_inside_the_allowance_passes(self):
        # 1.00 -> 1.05 is +5%, allowance 10%.
        rc, out = self._pct(1.05, 1.00, "10")
        self.assertEqual(rc, 0, out)
        d = json.loads(out)
        self.assertAlmostEqual(d["baseline_usd"], 1.00, places=4)
        self.assertAlmostEqual(d["actual_usd"], 1.05, places=4)

    def test_increase_past_the_allowance_fails_with_the_percentage(self):
        # 2.00 -> 2.50 is exactly +25%, allowance 10%.
        rc, out = self._pct(2.50, 2.00, "10")
        self.assertEqual(rc, 1)
        self.assertIn("25.0%", out, "the computed increase was wrong or unnamed")
        self.assertIn("0.5000", out, "the absolute rise was not named")

    def test_a_tenth_of_a_percent_over_still_fails(self):
        """Pins the pct tolerance too: 1.00 -> 1.102 is +10.2%, allowed 10%."""
        rc, out = self._pct(1.102, 1.00, "10")
        self.assertEqual(rc, 1, "a real overage was rounded away: %s" % out)

    def test_a_decrease_passes(self):
        rc, out = self._pct(0.50, 2.00, "10")
        self.assertEqual(rc, 0, out)

    def test_boundary_equal_to_the_allowance_passes(self):
        """Exactly at the allowance is not 'beyond' it."""
        rc, out = self._pct(1.10, 1.00, "10")
        self.assertEqual(rc, 0, out)

    def test_rise_from_a_measured_zero_baseline_is_a_breach_not_a_crash(self):
        """Percent of zero is undefined, but both sides ARE measured."""
        rc, out = self._pct(0.75, 0.0, "10")
        self.assertEqual(rc, 1, "a rise off a zero baseline was not caught")
        self.assertIn("0.7500", out, "the absolute rise was not named")
        self.assertNotIn("Traceback", out, "ZeroDivisionError, not a verdict")

    def test_both_policies_apply_together(self):
        """Under the ceiling but a big regression still fails."""
        rec = dict(_MEASURED, cost_usd=2.00)
        rc, out = _run(_workspace(rec), "--max-usd", "10.00", "--baseline",
                       _baseline(1.00), "--max-increase-pct", "10")
        self.assertEqual(rc, 1)
        self.assertIn("100.0%", out)


if __name__ == "__main__":
    unittest.main()
