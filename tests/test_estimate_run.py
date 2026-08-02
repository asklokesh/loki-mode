"""A forward-looking $0.00 is worse than a backward-looking one.

The v8.51.0-v8.54.0 arc was four surfaces turning "we did not measure" into "it
was free", each after the fact. This estimator points the same records at the
FUTURE, where a fabricated zero does not merely misreport a run -- it invites
someone to start one believing it costs nothing.

So the property asserted here is the same one, in the direction that matters:

    No measured history reads as NO BASIS. Never as $0.00.

Both directions are asserted. A guard so strict it suppressed genuine data
would make the estimator useless, which is its own dishonesty.

Asserted on the RENDERED TEXT as well as the dict, because a formatter is a
place the zero can come back: a correct None projected through "%.2f" prints
0.00 to the operator regardless of how honest the dict was.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "estimate-run.py"

# Hyphenated filename, so it is not importable as a module by name.
_spec = importlib.util.spec_from_file_location("estimate_run", _TOOL)
_er = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_er)


def _figure_lines(rendered):
    """The lines that REPORT a number, excluding the explanatory notes.

    The notes deliberately contain the string "not $0.00" -- that phrasing is
    the point of them. Asserting "0.00" is absent from the whole render would
    therefore be satisfied only by deleting the honesty note, so the check is
    scoped to the reporting lines, where a fabricated zero would actually
    deceive. Note text is asserted separately and positively.
    """
    return "\n".join(
        ln for ln in rendered.splitlines() if not ln.strip().startswith("- "))


def _rec(iteration, cost_usd, model="sonnet", **over):
    rec = {
        "iteration": iteration,
        "input_tokens": 9412,
        "output_tokens": 233,
        "cache_read_tokens": 11008,
        "cache_creation_tokens": 0,
        "cost_usd": cost_usd,
        "model": model,
        "duration_ms": 90000,
        "status": "completed",
    }
    rec.update(over)
    return rec


# The exact shape a real FireLater run produced before v8.51.0: record present,
# every field zero. Present is not measured.
_UNMEASURED = {
    "iteration": 99,
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_tokens": 0,
    "cache_creation_tokens": 0,
    "cost_usd": 0,
    "model": "gpt-5.6-sol",
    "duration_ms": 1000,
    "status": "completed",
}

# Measured on tokens, but carrying no cost -- an unpriced model. Real for token
# accounting, useless as a COST basis, and a fabricated low if averaged in.
_UNPRICED = _rec(98, 0, model="gpt-5.6-sol")


class _Workspace:
    """A throwaway workspace with the given efficiency records written in."""

    def __init__(self, records):
        self.records = records

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self._tmp.name)
        eff = root / ".loki" / "metrics" / "efficiency"
        eff.mkdir(parents=True)
        for i, rec in enumerate(self.records, start=1):
            (eff / ("iteration-%03d.json" % i)).write_text(json.dumps(rec))
        return str(root)

    def __exit__(self, *exc):
        self._tmp.cleanup()


class TestProjectionMath(unittest.TestCase):
    """A known fixture must produce the arithmetic a reader can recompute."""

    def test_median_range_and_projection(self):
        # Deliberately not symmetric, so a mean would give a different answer
        # (mean 0.20) and cannot pass by coincidence.
        with _Workspace([_rec(1, 0.10), _rec(2, 0.20), _rec(3, 0.30),
                         _rec(4, 0.20)]) as ws:
            est = _er.estimate(ws, iterations=10)

        self.assertTrue(est["has_basis"])
        self.assertEqual(est["basis_count"], 4)
        self.assertEqual(est["median_cost_per_iteration_usd"], 0.20)
        self.assertEqual(est["min_cost_per_iteration_usd"], 0.10)
        self.assertEqual(est["max_cost_per_iteration_usd"], 0.30)
        self.assertEqual(est["projected_cost_usd"], 2.0)
        self.assertEqual(est["iterations_projected"], 10)

    def test_odd_count_median_is_the_middle_value(self):
        with _Workspace([_rec(1, 0.01), _rec(2, 0.05), _rec(3, 1.00)]) as ws:
            est = _er.estimate(ws, iterations=3)
        self.assertEqual(est["median_cost_per_iteration_usd"], 0.05)
        self.assertEqual(est["projected_cost_usd"], 0.15)

    def test_render_labels_it_an_estimate_not_a_guarantee(self):
        with _Workspace([_rec(1, 0.10), _rec(2, 0.20)]) as ws:
            out = _er.render(_er.estimate(ws, iterations=5))
        self.assertIn("ESTIMATE", out)
        self.assertIn("not a guarantee", out)


class TestZeroHistoryIsNotFree(unittest.TestCase):
    """THE headline rule. No history must never render as a dollar amount."""

    def test_empty_workspace_has_no_basis_and_no_zero(self):
        with _Workspace([]) as ws:
            est = _er.estimate(ws, iterations=10)
            out = _er.render(est)

        self.assertFalse(est["has_basis"])
        self.assertIsNone(est["median_cost_per_iteration_usd"])
        self.assertIsNone(est["projected_cost_usd"])
        self.assertEqual(est["basis_count"], 0)

        # The rendered surface is where the operator actually reads it. A dict
        # holding None still prints $0.00 if the formatter defaults it.
        figures = _figure_lines(out)
        self.assertNotIn("0.00", figures)
        self.assertNotIn("$0", figures)
        self.assertIn("UNKNOWN", out)
        self.assertIn("NO BASIS", out)
        self.assertTrue(
            any("no history" in n.lower() for n in est["notes"]),
            "must state plainly that there is no history to project from")

    def test_records_present_but_all_unmeasured_is_still_no_basis(self):
        # A present file is not a measurement. This is the shape that shipped.
        with _Workspace([dict(_UNMEASURED, iteration=i) for i in (1, 2, 3)]) as ws:
            est = _er.estimate(ws, iterations=10)
            out = _er.render(est)

        self.assertEqual(est["iterations_found"], 3)
        self.assertEqual(est["iterations_measured"], 0)
        self.assertFalse(est["has_basis"])
        self.assertIsNone(est["projected_cost_usd"])
        self.assertNotIn("0.00", _figure_lines(out))
        self.assertIn("NO BASIS", out)

    def test_measured_but_unpriced_is_not_a_zero_dollar_basis(self):
        # Measured on tokens, cost_usd 0. record_is_measured() says True; a cost
        # basis must still refuse it, or the median is dragged to a fabricated
        # low.
        with _Workspace([_UNPRICED]) as ws:
            est = _er.estimate(ws, iterations=10)
            out = _er.render(est)

        self.assertEqual(est["iterations_measured"], 1)
        self.assertEqual(est["iterations_priced"], 0)
        self.assertFalse(est["has_basis"])
        self.assertIsNone(est["projected_cost_usd"])
        self.assertNotIn("0.00", _figure_lines(out))

    def test_json_mode_never_emits_a_zero_projection_without_basis(self):
        with _Workspace([]) as ws:
            proc = subprocess.run(
                [sys.executable, str(_TOOL), ws, "--iterations", "10", "--json"],
                capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertIsNone(data["projected_cost_usd"])
        self.assertIsNone(data["median_cost_per_iteration_usd"])
        self.assertFalse(data["has_basis"])


class TestPartialMeasurement(unittest.TestCase):
    """Half the iterations measured is half a number, and must say so."""

    def test_basis_count_excludes_unmeasured_and_unpriced(self):
        records = [
            _rec(1, 0.10),
            dict(_UNMEASURED, iteration=2),
            _rec(3, 0.30),
            dict(_UNPRICED, iteration=4),
            _rec(5, 0.20),
            dict(_UNMEASURED, iteration=6),
            _rec(7, 0.20),
        ]
        with _Workspace(records) as ws:
            est = _er.estimate(ws, iterations=10)
            out = _er.render(est)

        self.assertEqual(est["iterations_found"], 7)
        self.assertEqual(est["iterations_measured"], 5)   # 4 priced + 1 unpriced
        self.assertEqual(est["iterations_priced"], 4)
        self.assertEqual(est["basis_count"], 4)

        # The median must come from the 4 priced values ONLY. Including the
        # three excluded records as zeros would give a median of 0.15.
        self.assertEqual(est["median_cost_per_iteration_usd"], 0.20)
        self.assertEqual(est["projected_cost_usd"], 2.0)

        # And the ratio must be visible, or a 4-of-7 basis reads as complete.
        self.assertIn("4", out)
        self.assertIn("7", out)
        self.assertTrue(
            any("4" in n and "7" in n for n in est["notes"]),
            "must state how many records informed the estimate, of how many found")

    def test_partial_is_flagged_as_partial(self):
        with _Workspace([_rec(1, 0.10), dict(_UNMEASURED, iteration=2)]) as ws:
            est = _er.estimate(ws, iterations=4)
        self.assertTrue(any("PARTIAL" in n for n in est["notes"]))


class TestSinglePointBasis(unittest.TestCase):
    """A projection from one point must say the basis is one point."""

    def test_single_point_is_labelled(self):
        with _Workspace([_rec(1, 0.42)]) as ws:
            est = _er.estimate(ws, iterations=10)
            out = _er.render(est)

        self.assertTrue(est["has_basis"])
        self.assertTrue(est["single_point_basis"])
        self.assertEqual(est["basis_count"], 1)
        self.assertEqual(est["median_cost_per_iteration_usd"], 0.42)
        self.assertEqual(est["projected_cost_usd"], 4.2)
        self.assertTrue(
            any("SINGLE data point" in n for n in est["notes"]),
            "a median of one must not be presented as a distribution")
        self.assertIn("SINGLE data point", out)

    def test_multi_point_is_not_labelled_single(self):
        # The negative direction: the label must mean something.
        with _Workspace([_rec(1, 0.10), _rec(2, 0.20)]) as ws:
            est = _er.estimate(ws, iterations=10)
        self.assertFalse(est["single_point_basis"])
        self.assertFalse(any("SINGLE data point" in n for n in est["notes"]))


class TestModelTransfer(unittest.TestCase):
    """Silently assuming the projection transfers is the quiet dishonesty."""

    def setUp(self):
        self._saved = os.environ.get("LOKI_SESSION_MODEL")
        os.environ.pop("LOKI_SESSION_MODEL", None)

    def tearDown(self):
        os.environ.pop("LOKI_SESSION_MODEL", None)
        if self._saved is not None:
            os.environ["LOKI_SESSION_MODEL"] = self._saved

    def test_same_model_transfers(self):
        os.environ["LOKI_SESSION_MODEL"] = "sonnet"
        with _Workspace([_rec(1, 0.10, model="sonnet"),
                         _rec(2, 0.20, model="sonnet")]) as ws:
            est = _er.estimate(ws, iterations=5)
        self.assertEqual(est["model_now"], "sonnet")
        self.assertTrue(est["projection_transfers"])

    def test_different_model_says_may_not_transfer(self):
        os.environ["LOKI_SESSION_MODEL"] = "opus"
        with _Workspace([_rec(1, 0.10, model="haiku"),
                         _rec(2, 0.20, model="haiku")]) as ws:
            est = _er.estimate(ws, iterations=5)
            out = _er.render(est)
        self.assertFalse(est["projection_transfers"])
        self.assertTrue(any("MAY NOT TRANSFER" in n for n in est["notes"]))
        self.assertIn("MAY NOT TRANSFER", out)

    def test_mixed_basis_models_flagged(self):
        os.environ["LOKI_SESSION_MODEL"] = "sonnet"
        with _Workspace([_rec(1, 0.10, model="haiku"),
                         _rec(2, 0.90, model="opus")]) as ws:
            est = _er.estimate(ws, iterations=5)
        self.assertFalse(est["projection_transfers"])
        self.assertTrue(any("MIXES models" in n for n in est["notes"]))

    def test_model_price_is_quoted_from_the_pricing_table(self):
        os.environ["LOKI_SESSION_MODEL"] = "sonnet"
        with _Workspace([_rec(1, 0.10, model="sonnet")]) as ws:
            est = _er.estimate(ws, iterations=5)
            out = _er.render(est)
        rate = est["model_now_price_per_mtok"]
        self.assertIsNotNone(rate, "sonnet must resolve in model-pricing.json")
        self.assertEqual(rate["input"], 3.0)
        self.assertEqual(rate["output"], 15.0)
        self.assertIn("per Mtok", out)

    def test_unknown_model_price_is_stated_not_invented(self):
        os.environ["LOKI_SESSION_MODEL"] = "no-such-model-xyz"
        with _Workspace([_rec(1, 0.10, model="no-such-model-xyz")]) as ws:
            est = _er.estimate(ws, iterations=5)
        self.assertIsNone(est["model_now_price_per_mtok"])
        self.assertTrue(any("no price listed" in n for n in est["notes"]))

    def test_override_file_beats_session_pin(self):
        os.environ["LOKI_SESSION_MODEL"] = "sonnet"
        with _Workspace([_rec(1, 0.10, model="sonnet")]) as ws:
            state = pathlib.Path(ws) / ".loki" / "state"
            state.mkdir(parents=True, exist_ok=True)
            (state / "model-override").write_text("opus\n")
            est = _er.estimate(ws, iterations=5)
        self.assertEqual(est["model_now"], "opus")
        self.assertEqual(est["model_now_source"], "model-override file")


class TestIterationsRequired(unittest.TestCase):
    """No multi-run archive exists, so the horizon must not be invented."""

    def test_no_iterations_flag_yields_no_projection_but_keeps_observed(self):
        with _Workspace([_rec(1, 0.10), _rec(2, 0.20), _rec(3, 0.30)]) as ws:
            est = _er.estimate(ws, iterations=None)
            out = _er.render(est)

        # Observed per-iteration cost is real and still reported.
        self.assertEqual(est["median_cost_per_iteration_usd"], 0.20)
        # The projection is not.
        self.assertIsNone(est["projected_cost_usd"])
        self.assertIn("pass --iterations", out)
        self.assertNotIn("Projected for", out)


class TestCliSmoke(unittest.TestCase):
    def test_human_output_runs_and_states_its_basis(self):
        with _Workspace([_rec(1, 0.10), _rec(2, 0.20)]) as ws:
            proc = subprocess.run(
                [sys.executable, str(_TOOL), ws, "--iterations", "6"],
                capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("ESTIMATE", proc.stdout)
        self.assertIn("Basis:", proc.stdout)


if __name__ == "__main__":
    unittest.main()
