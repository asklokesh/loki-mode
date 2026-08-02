"""An unmeasured iteration must not be summed as zero.

WHY THIS EXISTS. cost-summary.py is the FIFTH surface to read
.loki/metrics/efficiency/iteration-N.json. The previous four each turned "we
did not measure" into "it was free" (v8.51.0 dispatch, v8.52.0 receipt,
v8.53.0 prompt, v8.54.0 verifier), and each was fixed in isolation.
tests/test_cost_honesty_end_to_end.py locks the property across those four.
This locks it on the new one, plus the failure mode only a PER-ITERATION
surface can have.

THE TRAP THIS TEST IS BUILT AROUND. On a partially measured run, excluding an
unmeasured iteration and adding it as zero produce the IDENTICAL total:
$0.05 + nothing and $0.05 + $0.00 are both $0.05. A test asserting only on the
total therefore cannot tell the honest implementation from the dishonest one,
and would pass a mutation that removed the exclusion entirely.

Two assertions discriminate, and they are the ones that matter:
  - the measured-vs-exists COUNT ("2 of 3"), which the summing version gets
    wrong by claiming three
  - the FULLY unmeasured run, where excluding yields UNKNOWN and summing
    yields $0.00 -- the exact string that shipped to a user

Both directions are asserted. A guard so strict it suppressed genuine data
would blank the cost surface permanently, which is its own dishonesty.
"""

import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"
_TOOL = _LIB / "cost-summary.py"

# Hyphen in the filename, so it is not importable as a module. Same loader the
# analogue uses for proof-verify.py.
_spec = importlib.util.spec_from_file_location("cost_summary", _TOOL)
_cs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_cs)


def _rec(iteration, cost, inp, out, cache_read, cache_create=0):
    return {
        "iteration": iteration, "input_tokens": inp, "output_tokens": out,
        "cache_read_tokens": cache_read, "cache_creation_tokens": cache_create,
        "cost_usd": cost, "model": "gpt-5.6-sol", "duration_ms": 90000,
        "status": "completed",
    }


# The exact shape a real FireLater run produced: record present, every field
# zero, because codex wrote no usage before v8.51.0.
def _unmeasured(iteration):
    return _rec(iteration, 0, 0, 0, 0)


def _value_lines(rendered):
    """Rendered output minus the note lines.

    The notes deliberately contain the literal string "not $0.00" to name the
    bug they guard against, so a blanket search for "$0.00" over the whole
    output matches the WARNING rather than a fabricated value. Scope the
    assertion to the lines that report numbers.
    """
    return "\n".join(
        ln for ln in rendered.splitlines() if not ln.startswith("note: "))


def _workspace(records):
    d = pathlib.Path(tempfile.mkdtemp(prefix="cost-summary-test-"))
    eff = d / ".loki" / "metrics" / "efficiency"
    eff.mkdir(parents=True)
    for r in records:
        (eff / ("iteration-%s.json" % r["iteration"])).write_text(
            json.dumps(r), encoding="utf-8")
    return d


class FullyMeasuredRun(unittest.TestCase):
    """The opposite error: an over-strict guard blanks real data."""

    def setUp(self):
        self.ws = _workspace([
            _rec(1, 0.02, 1000, 100, 3000),
            _rec(2, 0.04, 2000, 200, 6000),
        ])
        self.s = _cs.summarize(str(self.ws))

    def test_totals_are_correct(self):
        self.assertEqual(self.s["total_cost_usd"], 0.06)
        self.assertEqual(self.s["total_input_tokens"], 3000)
        self.assertEqual(self.s["total_output_tokens"], 300)
        self.assertEqual(self.s["total_cache_read_tokens"], 9000)

    def test_reports_itself_as_complete(self):
        self.assertEqual(self.s["iterations_found"], 2)
        self.assertEqual(self.s["iterations_measured"], 2)
        self.assertTrue(self.s["fully_measured"])

    def test_average_is_over_measured_iterations(self):
        self.assertEqual(self.s["avg_cost_per_iteration"], 0.03)


class PartiallyMeasuredRun(unittest.TestCase):
    """Measured iterations total correctly; unmeasured are EXCLUDED, not zeroed."""

    def setUp(self):
        self.ws = _workspace([
            _rec(1, 0.02, 1000, 100, 3000),
            _unmeasured(2),
            _rec(3, 0.04, 2000, 200, 6000),
        ])
        self.s = _cs.summarize(str(self.ws))

    def test_measured_iterations_total_correctly(self):
        self.assertEqual(self.s["total_cost_usd"], 0.06)
        self.assertEqual(self.s["total_input_tokens"], 3000)

    def test_the_partial_measurement_is_stated(self):
        """The assertion the summing bug CANNOT pass.

        Adding the unmeasured iteration as zero yields the same $0.06 total, so
        only this count distinguishes the two. A total presented without it
        silently claims to cover the whole run.
        """
        self.assertEqual(self.s["iterations_found"], 3)
        self.assertEqual(self.s["iterations_measured"], 2)
        self.assertFalse(self.s["fully_measured"])
        self.assertTrue(
            any("PARTIAL" in n for n in self.s["notes"]),
            "a partial measurement is presented as if it were complete")

    def test_the_unmeasured_iteration_reads_unknown(self):
        row = [r for r in self.s["iterations"] if r["iteration"] == 2][0]
        self.assertFalse(row["measured"])
        self.assertIsNone(row["cost_usd"], "an unmeasured iteration claims $0.00")
        self.assertIsNone(row["input_tokens"])

    def test_the_average_does_not_divide_by_the_unmeasured_iteration(self):
        """0.06/2 measured, not 0.06/3 -- the latter understates by a third."""
        self.assertEqual(self.s["cost_iterations_counted"], 2)
        self.assertEqual(self.s["avg_cost_per_iteration"], 0.03)

    def test_rendered_output_shows_unknown_not_a_dollar_figure(self):
        out = _cs.render(self.s)
        self.assertIn("iter 2: UNKNOWN", out)
        self.assertNotIn("$0.00", _value_lines(out))


class FullyUnmeasuredRun(unittest.TestCase):
    """The direction that shipped a false claim to a user."""

    def setUp(self):
        self.ws = _workspace([_unmeasured(1), _unmeasured(2)])
        self.s = _cs.summarize(str(self.ws))

    def test_total_is_unknown_never_zero(self):
        self.assertIsNone(
            self.s["total_cost_usd"],
            "the summary claims the run was free; free and unmeasured are "
            "different claims and only one of them is honest")
        self.assertIsNone(self.s["avg_cost_per_iteration"])
        self.assertIsNone(self.s["total_input_tokens"])

    def test_rendered_output_never_prints_a_zero_dollar_total(self):
        out = _cs.render(self.s)
        values = _value_lines(out)
        self.assertNotIn("$0.00", values)
        self.assertNotIn("$0.0000", values)
        self.assertIn("Total cost:  UNKNOWN", values)
        self.assertTrue(any("not $0.00" in n for n in self.s["notes"]))

    def test_iterations_still_counted_as_existing(self):
        """Unmeasured does not mean absent: the work happened."""
        self.assertEqual(self.s["iterations_found"], 2)
        self.assertEqual(self.s["iterations_measured"], 0)


class UnpricedModel(unittest.TestCase):
    """Tokens recorded, cost not: unpriced is not free either.

    THE CASE THE OTHER FIXTURES CANNOT REACH. _unmeasured() zeroes tokens AND
    cost, so record_is_measured short-circuits on the tokens and this branch
    never runs. But record_is_measured is field-agnostic: a record with real
    tokens and cost_usd 0 counts as measured on the strength of its tokens, and
    the cost slot then renders $0.0000 -- the headline rule inverted.

    Not hypothetical. test_cost_honesty_end_to_end.py asserts a shipped codex
    tier can be unpriced ("records tokens with cost unknown"), and the real
    FireLater records wrote an explicit "cost_usd": 0 rather than omitting it.
    """

    def setUp(self):
        self.ws = _workspace([_rec(1, 0, 5000, 100, 0)])
        self.s = _cs.summarize(str(self.ws))

    def test_cost_reads_unknown_not_zero(self):
        self.assertIsNone(
            self.s["total_cost_usd"],
            "an unpriced model rendered as a free run")
        self.assertIsNone(self.s["avg_cost_per_iteration"])
        self.assertNotIn("$0.00", _value_lines(_cs.render(self.s)))

    def test_the_tokens_are_still_reported(self):
        """The opposite error: blanking data we DID measure."""
        self.assertEqual(self.s["total_input_tokens"], 5000)
        self.assertEqual(self.s["total_output_tokens"], 100)
        self.assertEqual(self.s["iterations_measured"], 1)

    def test_the_unpriced_state_is_explained(self):
        self.assertTrue(
            any("unpriced" in n for n in self.s["notes"]),
            "cost vanished with no explanation of why")

    def test_a_mixed_run_excludes_only_the_unpriced_iteration(self):
        ws = _workspace([
            _rec(1, 0.02, 1000, 100, 3000),
            _rec(2, 0, 5000, 100, 0),
        ])
        s = _cs.summarize(str(ws))
        self.assertEqual(s["total_cost_usd"], 0.02)
        self.assertEqual(s["cost_iterations_counted"], 1)
        # tokens from BOTH iterations still count
        self.assertEqual(s["total_input_tokens"], 6000)


class CacheRatioMath(unittest.TestCase):
    def test_ratio_is_cache_read_over_everything_read_in(self):
        ws = _workspace([_rec(1, 0.02, 1000, 100, 3000)])
        s = _cs.summarize(str(ws))
        # 3000 / (1000 + 3000) == 0.75
        self.assertEqual(s["cache_hit_ratio"], 0.75)
        self.assertEqual(s["iterations"][0]["cache_hit_ratio"], 0.75)

    def test_ratio_aggregates_across_iterations(self):
        ws = _workspace([
            _rec(1, 0.02, 1000, 100, 3000),
            _rec(2, 0.04, 1000, 100, 5000),
        ])
        s = _cs.summarize(str(ws))
        # 8000 / (2000 + 8000) == 0.8
        self.assertEqual(s["cache_hit_ratio"], 0.8)

    def test_a_cold_cache_is_zero_not_unknown(self):
        """A real cold cache is expensive and must stay visible."""
        ws = _workspace([_rec(1, 0.02, 4000, 100, 0)])
        s = _cs.summarize(str(ws))
        self.assertEqual(s["cache_hit_ratio"], 0.0)

    def test_no_tokens_read_is_unknown_not_zero_percent(self):
        """0% claims a cold cache we never observed."""
        ws = _workspace([_rec(1, 0.02, 0, 100, 0)])
        s = _cs.summarize(str(ws))
        self.assertIsNone(
            s["cache_hit_ratio"],
            "reported a 0% cache ratio from a zero denominator, sending "
            "someone to hunt a caching problem that was never measured")


class CostTrend(unittest.TestCase):
    def test_climbing_is_detected(self):
        ws = _workspace([
            _rec(1, 0.01, 1000, 100, 3000),
            _rec(2, 0.09, 1000, 100, 3000),
        ])
        self.assertEqual(
            _cs.summarize(str(ws))["cost_trend"]["direction"], "climbing")

    def test_falling_is_detected(self):
        ws = _workspace([
            _rec(1, 0.09, 1000, 100, 3000),
            _rec(2, 0.01, 1000, 100, 3000),
        ])
        self.assertEqual(
            _cs.summarize(str(ws))["cost_trend"]["direction"], "falling")

    def test_one_point_cannot_have_a_trend(self):
        """'Flat' from a single point is fabrication of the same family."""
        ws = _workspace([_rec(1, 0.02, 1000, 100, 3000), _unmeasured(2)])
        t = _cs.summarize(str(ws))["cost_trend"]
        self.assertEqual(t["direction"], "unknown")
        self.assertEqual(t["points"], 1)


class MalformedRecords(unittest.TestCase):
    def test_a_corrupt_record_counts_as_existing_but_not_measured(self):
        """Otherwise a corrupt dir shrinks the denominator and a partial run
        renders as complete."""
        ws = _workspace([_rec(1, 0.02, 1000, 100, 3000)])
        eff = ws / ".loki" / "metrics" / "efficiency"
        (eff / "iteration-2.json").write_text("not json", encoding="utf-8")
        s = _cs.summarize(str(ws))
        self.assertEqual(s["iterations_found"], 2)
        self.assertEqual(s["iterations_measured"], 1)
        self.assertFalse(s["fully_measured"])


class EmptyWorkspace(unittest.TestCase):
    def test_no_metrics_dir_reads_unknown(self):
        d = tempfile.mkdtemp(prefix="cost-summary-empty-")
        s = _cs.summarize(d)
        self.assertEqual(s["iterations_found"], 0)
        self.assertIsNone(s["total_cost_usd"])
        self.assertNotIn("$0.00", _value_lines(_cs.render(s)))


class CommandLine(unittest.TestCase):
    """The tool has to actually run, not just import."""

    def test_json_flag_emits_parseable_json_with_a_null_total(self):
        ws = _workspace([_unmeasured(1)])
        r = subprocess.run(
            [sys.executable, str(_TOOL), str(ws), "--json"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        self.assertIsNone(data["total_cost_usd"])
        self.assertEqual(data["iterations_found"], 1)

    def test_text_output_runs_and_shows_the_measured_total(self):
        ws = _workspace([_rec(1, 0.02, 1000, 100, 3000)])
        r = subprocess.run(
            [sys.executable, str(_TOOL), str(ws)],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("$0.0200", r.stdout)
        self.assertIn("75.0%", r.stdout)


class SharedPredicate(unittest.TestCase):
    """One definition of 'measured', not a second copy that can drift."""

    def test_the_tool_imports_the_shared_predicate(self):
        src = _TOOL.read_text(encoding="utf-8")
        self.assertIn(
            "from efficiency_cost import record_is_measured", src,
            "cost-summary.py restates the measured/unmeasured rule instead of "
            "importing it; a second copy is how the rule drifts")


if __name__ == "__main__":
    unittest.main()
