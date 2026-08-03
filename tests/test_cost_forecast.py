"""A forecast from no measurement must be no forecast, never $0.00.

WHY THIS FILE. A projection is arithmetic over a sample, and arithmetic runs
happily on an empty one: `sum([])` is 0 and `0 * N` is 0. So the naive forecast
answers "$0.00" for a project with no recorded history -- the most confident
claim the tool can make, produced at the moment it knows least. An earlier
attempt at this tool shipped exactly that, projecting $0.00 from zero measured
runs and crashing (`TypeError: must be real number, not NoneType`) on the
absence path it did not have.

This is the same defect class the repo already paid four surfaces for
(v8.51.0-v8.54.0): an unmeasured cost rendered as free. It is worse in a
forecast, because a forecast is consumed as a budget decision.

BOTH DIRECTIONS ARE ASSERTED, and the second half is the one a careless fix
breaks. A guard strict enough to suppress every zero would also suppress a
genuinely measured $0.0000 run -- a real cached or free-tier run -- and drop it
from the sample, biasing every forecast upward and invisibly. So:

    an UNMEASURED run is excluded and no number is printed,
    a MEASURED ZERO stays in the sample as 0.0,

and only `is None` can tell those apart. A truthiness test collapses them.

The four assertions at the top of ZeroMeasuredHistoryNeverForecasts are the
four failures that rejected the previous attempt, restated as tests.
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
_TOOL = _ROOT / "tools" / "cost-forecast.py"

OK, CANNOT, NOTHING_TO_CHECK, USAGE, NO_INPUT = 0, 2, 3, 64, 66


def _run(*args):
    return subprocess.run(
        [sys.executable, str(_TOOL), *args],
        capture_output=True, text=True, timeout=120)


def _history(*rows):
    """Write a history file. A str row is written verbatim (corrupt lines)."""
    d = tempfile.mkdtemp()
    path = os.path.join(d, "cost-history.jsonl")
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(row if isinstance(row, str)
                         else json.dumps(row, sort_keys=True))
            handle.write("\n")
    return path


def _measured(usd):
    return {"ts": 1.0, "workspace": "/w", "usd": usd, "measured": True,
            "model": "m"}


def _unmeasured():
    """Exactly what cost-history.py appends when a run was not measured."""
    return {"ts": 1.0, "workspace": "/w", "usd": None, "measured": False,
            "model": None}


class ZeroMeasuredHistoryNeverForecasts(unittest.TestCase):
    """The direction that shipped a false number. No sample, no claim."""

    def test_empty_file_emits_no_projection(self):
        """`AssertionError: 0.0 is not None : zero recorded runs produced a
        forecast` -- the first failure that rejected the previous attempt."""
        r = _run("--runs", "10", "--file", _history(), "--json")
        d = json.loads(r.stdout)
        self.assertIsNone(
            d["projected_usd"],
            "zero recorded runs produced a forecast; an empty sample supports "
            "no claim about future spend")
        self.assertIsNone(d["mean_usd"])
        self.assertEqual(d["measured"], 0)

    def test_all_unmeasured_rows_are_not_averaged_as_zero(self):
        """`AssertionError: 0.0 is not None : three unmeasured runs were
        averaged as 0` -- the second failure. Null is absent, not free."""
        path = _history(_unmeasured(), _unmeasured(), _unmeasured())
        r = _run("--runs", "5", "--file", path, "--json")
        d = json.loads(r.stdout)
        self.assertIsNone(
            d["projected_usd"],
            "three unmeasured runs were averaged as 0; recording null exists "
            "precisely so the gap stays countable rather than becoming a zero")
        self.assertEqual(d["recorded"], 3, "the rows themselves were lost")
        self.assertEqual(
            d["excluded_unmeasured"], 3,
            "the measurement gap must be reported, not inferred from a short "
            "sample")

    def test_absence_path_renders_without_crashing(self):
        """`TypeError: must be real number, not NoneType` -- the third failure.

        The text renderer must branch on the absence BEFORE any %.4f, not
        format a None. A crash here is not a safe failure: it is an exit code
        nobody can interpret.
        """
        r = _run("--runs", "3", "--file", _history(_unmeasured()))
        self.assertNotIn("Traceback", r.stderr, "the renderer crashed on None")
        self.assertNotIn("TypeError", r.stderr)
        self.assertIn("NO FORECAST", r.stdout)

    def test_nothing_to_check_is_exit_three_not_two(self):
        """`AssertionError: 1 != 3` -- the fourth failure.

        3 means "nothing to check", 2 means "could NOT check". An empty
        history is the first: the instrument works fine and has nothing to
        report. Reporting it as 2 sends an operator hunting for broken
        instrumentation that is not broken.
        """
        r = _run("--runs", "10", "--file", _history())
        self.assertEqual(
            r.returncode, NOTHING_TO_CHECK,
            "an empty history is 'nothing to check' (3), not 'could not "
            "check' (2) and not a pass")

    def test_no_dollar_figure_reaches_the_output_at_all(self):
        """The sharpest assertion in the file: catches $0.00 and every other
        number at once, in both renderings, on every absence path."""
        for label, path in (("empty", _history()),
                            ("all-null", _history(_unmeasured(),
                                                  _unmeasured())),
                            ("only-corrupt", _history("{not json"))):
            for flag in ([], ["--json"]):
                with self.subTest(history=label, json=bool(flag)):
                    r = _run("--runs", "10", "--file", path, *flag)
                    self.assertNotIn(
                        "$", r.stdout,
                        "a dollar figure was printed from %s history; absent "
                        "is not zero" % label)
                    self.assertEqual(r.returncode, NOTHING_TO_CHECK)

    def test_json_stays_valid_json_on_the_absence_path(self):
        """--json emitted non-JSON on the failure path once already (9b879986).

        A consumer that parses the happy path and crashes on the absence path
        is a consumer that treats absence as an outage.
        """
        r = _run("--runs", "10", "--file", _history(), "--json")
        d = json.loads(r.stdout)  # raises if the failure path emits prose
        self.assertIsNone(d["projected_usd"])

    def test_missing_file_is_input_missing_not_a_pass(self):
        r = _run("--runs", "10", "--file", "/nonexistent/nope.jsonl", "--json")
        self.assertEqual(
            r.returncode, NO_INPUT,
            "a path that does not exist is missing input (66), distinct from "
            "a present-but-barren history (3)")
        self.assertIsNone(json.loads(r.stdout)["projected_usd"])


class MeasuredDataIsStillForecast(unittest.TestCase):
    """The opposite error: an over-strict guard blanks real data permanently.

    Suppressing genuine measurements is its own dishonesty. It would make spend
    unforecastable and push the operator back to guessing, which is the state
    this tool exists to end.
    """

    def test_a_real_mean_is_projected(self):
        path = _history(_measured(1.0), _measured(2.0), _measured(3.0))
        r = _run("--runs", "10", "--file", path, "--json")
        d = json.loads(r.stdout)
        self.assertEqual(r.returncode, OK)
        self.assertAlmostEqual(d["mean_usd"], 2.0, places=6)
        self.assertAlmostEqual(
            d["projected_usd"], 20.0, places=6,
            msg="a genuine three-run sample was suppressed or mis-projected")

    def test_a_measured_zero_survives_as_zero(self):
        """THE ASSERTION AN OVER-STRICT FIX BREAKS.

        A cached or free-tier run really did cost $0.0000. `if usd:` drops it,
        which raises the mean from 1.0 to 2.0 here -- a 2x forecast error, in
        the expensive direction, with nothing on screen to reveal it. Only
        `is None` distinguishes a measured zero from an absent measurement.
        """
        path = _history(_measured(0.0), _measured(1.0), _measured(2.0))
        d = json.loads(_run("--runs", "1", "--file", path, "--json").stdout)
        self.assertEqual(
            d["measured"], 3,
            "a measured $0.0000 run was discarded as if it were unmeasured")
        self.assertEqual(d["excluded_unmeasured"], 0)
        self.assertAlmostEqual(
            d["mean_usd"], 1.0, places=6,
            msg="dropping the measured zero biased the mean upward")

    def test_a_legacy_row_without_the_measured_flag_keeps_its_zero(self):
        """The same fact must not get two answers depending on the writer.

        A row from before cost-history.py wrote a `measured` flag has to be
        judged by its usd alone. The tempting reading -- hand it to
        record_is_measured() -- silently drops a measured $0.0000, because that
        predicate is a TRUTHINESS test over token fields. It is right for its
        own question and wrong for this one, so `usd is None` has to be tested
        first.

        Caught in review: this branch had no coverage and was live-verified
        biasing the mean from 1.0 to 2.0 on exactly this input.
        """
        path = _history({"ts": 1, "usd": 0.0}, {"ts": 2, "usd": 2.0})
        d = json.loads(_run("--runs", "1", "--file", path, "--json").stdout)
        self.assertEqual(
            d["measured"], 2,
            "a flag-less row measured at $0.0000 was dropped, while the same "
            "row carrying measured=true is kept")
        self.assertEqual(d["excluded_unmeasured"], 0)
        self.assertAlmostEqual(
            d["mean_usd"], 1.0, places=6,
            msg="dropping the flag-less measured zero biased the mean upward")

    def test_a_legacy_row_with_no_usd_is_still_excluded(self):
        """The other direction: relaxing the legacy branch must not start
        counting genuinely absent measurements as data."""
        path = _history({"ts": 1, "usd": None}, {"ts": 2, "usd": 4.0})
        d = json.loads(_run("--runs", "1", "--file", path, "--json").stdout)
        self.assertEqual(d["measured"], 1)
        self.assertEqual(
            d["excluded_unmeasured"], 1,
            "a flag-less row with no usd is an absent measurement, not data")
        self.assertAlmostEqual(d["mean_usd"], 4.0, places=6)

    def test_measured_rows_survive_alongside_unmeasured_ones(self):
        """A mixed history forecasts from the measured part and says so."""
        path = _history(_measured(2.0), _unmeasured(), _measured(4.0))
        r = _run("--runs", "10", "--file", path, "--json")
        d = json.loads(r.stdout)
        self.assertEqual(r.returncode, OK)
        self.assertAlmostEqual(
            d["projected_usd"], 30.0, places=6,
            msg="the null row was averaged in as 0, dragging the forecast down")
        self.assertEqual(d["measured"], 2)
        self.assertEqual(d["excluded_unmeasured"], 1)

    def test_single_observation_still_forecasts_and_is_labelled(self):
        """One point is not a trend, but it IS data. Refusing to project from
        it throws away a real measurement; projecting from it silently is the
        mirror lie. Both the number and the caveat are required."""
        path = _history(_measured(3.0))
        r = _run("--runs", "4", "--file", path, "--json")
        d = json.loads(r.stdout)
        self.assertEqual(r.returncode, OK)
        self.assertAlmostEqual(
            d["projected_usd"], 12.0, places=6,
            msg="a single real observation was discarded rather than labelled")
        self.assertEqual(d["confidence"], "SINGLE OBSERVATION")
        self.assertIn("flat rate", d["assumption"].lower())
        self.assertIn("single observation", d["assumption"].lower())

    def test_two_observations_are_not_labelled_single(self):
        """The caveat must be earned, not stamped on everything. A caveat that
        never varies carries no information."""
        path = _history(_measured(1.0), _measured(3.0))
        d = json.loads(_run("--runs", "2", "--file", path, "--json").stdout)
        self.assertEqual(d["confidence"], "MULTI OBSERVATION")


class TheBasisIsAlwaysStated(unittest.TestCase):
    """$4.20 from 40 measured runs and $4.20 from 1 of 39 are different facts,
    and the number alone cannot tell them apart."""

    def test_basis_names_measured_of_recorded(self):
        path = _history(_measured(1.0), _unmeasured(), _measured(3.0),
                        _unmeasured())
        r = _run("--runs", "10", "--file", path)
        self.assertIn(
            "2 measured of 4 recorded", r.stdout,
            "the projection did not state how much of the history it rests on")

    def test_basis_is_in_the_text_output_not_only_json(self):
        """A basis behind --json is a basis the human reader never sees."""
        path = _history(_measured(1.0), _measured(3.0))
        r = _run("--runs", "10", "--file", path)
        self.assertIn("basis:", r.stdout)
        self.assertIn("confidence:", r.stdout)

    def test_excluded_unmeasured_count_is_reported_in_text(self):
        path = _history(_measured(1.0), _unmeasured(), _measured(3.0))
        r = _run("--runs", "10", "--file", path)
        self.assertIn("1 unmeasured run(s) EXCLUDED", r.stdout)
        self.assertIn("never", r.stdout.lower())


class CorruptLinesAreCountedNotSwallowed(unittest.TestCase):
    """A history that quietly drops rows forecasts from a tidier sample than
    reality, and drops them most often when something upstream just broke."""

    def test_corrupt_line_is_counted_and_named(self):
        path = _history(_measured(1.0), "{ not json at all",
                        _measured(3.0))
        r = _run("--runs", "10", "--file", path, "--json")
        d = json.loads(r.stdout)
        self.assertEqual(
            d["corrupt_lines"], 1,
            "a corrupt line was silently skipped instead of counted")
        self.assertEqual(d["measured"], 2)

    def test_corrupt_line_is_visible_in_the_text_output(self):
        path = _history(_measured(1.0), "{ not json at all", _measured(3.0))
        r = _run("--runs", "10", "--file", path)
        self.assertIn("1 CORRUPT line(s)", r.stdout)

    def test_a_history_of_only_corrupt_lines_forecasts_nothing(self):
        path = _history("{ nope", "also nope")
        r = _run("--runs", "10", "--file", path, "--json")
        self.assertEqual(r.returncode, NOTHING_TO_CHECK)
        self.assertIsNone(json.loads(r.stdout)["projected_usd"])


class ItNeverCrashes(unittest.TestCase):
    """Requirement 6: an empty file, a missing file, an all-null history."""

    def test_no_traceback_on_any_degenerate_history(self):
        cases = {
            "empty": _history(),
            "blank lines": _history("", "  ", ""),
            "all null": _history(_unmeasured(), _unmeasured()),
            "corrupt only": _history("x"),
            "missing": "/nonexistent/definitely/not/here.jsonl",
            "a directory, not a file": tempfile.mkdtemp(),
        }
        for label, path in cases.items():
            for flag in ([], ["--json"]):
                with self.subTest(case=label, json=bool(flag)):
                    r = _run("--runs", "7", "--file", path, *flag)
                    self.assertNotIn("Traceback", r.stderr,
                                     "%s crashed the tool" % label)
                    self.assertNotEqual(
                        r.returncode, OK,
                        "%s reported a successful forecast" % label)

    def test_rows_of_the_wrong_shape_do_not_crash(self):
        path = _history({"usd": "not a number", "measured": True},
                        {"usd": True, "measured": True},
                        _measured(2.0))
        r = _run("--runs", "1", "--file", path, "--json")
        d = json.loads(r.stdout)
        self.assertEqual(
            d["measured"], 1,
            "a string or bool usd was treated as a number")
        self.assertAlmostEqual(d["projected_usd"], 2.0, places=6)


class ExitContract(unittest.TestCase):
    """The convention tests/test_tool_exit_contract.py enforces repo-wide."""

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = _run("--help")
        self.assertEqual(r.returncode, OK, "a help request is not a failure")
        self.assertNotIn("NO FORECAST", r.stdout)
        self.assertNotIn("projected", r.stdout.lower())

    def test_an_unknown_flag_is_a_usage_error_not_a_blind_gate(self):
        """64, never argparse's default 2. Here 2 means 'could not check', so a
        typo would masquerade as broken instrumentation."""
        r = _run("--runs", "5", "--no-such-flag")
        self.assertEqual(r.returncode, USAGE)

    def test_a_stray_positional_is_never_read_as_a_path(self):
        """receipt-attest once read `--help` as a proof path and judged it."""
        r = _run("--runs", "5", "/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, USAGE)

    def test_a_nonsense_runs_value_is_a_usage_error(self):
        for bad in ("0", "-3", "abc"):
            with self.subTest(runs=bad):
                r = _run("--runs", bad, "--file", _history(_measured(1.0)))
                self.assertEqual(
                    r.returncode, USAGE,
                    "--runs %s should be refused, not answered with a number"
                    % bad)
                self.assertNotIn("$", r.stdout)

    def test_missing_required_runs_is_non_zero(self):
        """The contract test runs this tool with a bare nonexistent path and
        requires non-zero. Pinned here so it cannot regress silently."""
        r = _run("/nonexistent/definitely/not/here")
        self.assertNotEqual(r.returncode, OK)


if __name__ == "__main__":
    unittest.main()
