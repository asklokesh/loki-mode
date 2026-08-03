"""A gate going BLIND must not read as a gate getting BETTER.

WHAT THIS PINS. tools/gate-trend.py answers a directional question over the
gate-log: improving, worsening, or going blind. The defect it exists to prevent
is one line of arithmetic that reads as reasonable:

    passes = total - failures

Fold UNEVALUABLE into PASS and a gate that has gone completely blind reports a
100% pass rate and an IMPROVING trend, and it looks healthier the longer the
blindness lasts, because an axis that cannot be evaluated can never fail. The
sharpest test here builds exactly that history -- failures replaced by blind
runs -- and asserts the tool says GOING BLIND and exits non-zero.

BOTH DIRECTIONS ARE ASSERTED, because an over-strict fix is its own dishonesty.
A tool that shouted GOING BLIND at every log, or that refused to report a trend
whenever one unevaluable record existed, would make the real signal unreadable
and would be indistinguishable from a broken tool. So: genuine improvement is
still reported as improvement, a genuine regression is still reported as
worsening, a MEASURED zero survives as 0 rather than becoming UNKNOWN, and a
clean two-record log still exits 0.

Every fixture is written into tempfile.mkdtemp() and the tool is resolved
relative to this file, so the suite passes wherever the two files are dropped.
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_CORRUPT = "corrupt"  # the bucket a damaged line becomes

_TOOL = pathlib.Path(__file__).resolve().parents[1] / "tools" / "gate-trend.py"

PASSED, FAILED, COULD_NOT_CHECK, NOTHING, USAGE, MISSING = 0, 1, 2, 3, 64, 66


def _row(state):
    """One gate-log.py line. `category` and `verdict` agree, as a real one does."""
    bucket = {"PASS": "pass", "FAIL": "fail", "UNEVALUABLE": "unevaluable"}
    return json.dumps({
        "recorded_at": "2026-08-02T00:00:00+00:00",
        "category": bucket[state],
        "failing_policies": ["cost"] if state == "FAIL" else [],
        "verdict": {"state": state, "policies": []},
    })


def _log(*lines):
    """Write a JSONL log into a fresh temp dir. Returns its path."""
    path = os.path.join(tempfile.mkdtemp(), "gate-log.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        for line in lines:
            fh.write(line + "\n")
    return path


def _states(*states):
    return _log(*[_row(s) for s in states])


def _run(*args):
    return subprocess.run([sys.executable, str(_TOOL), *args],
                          capture_output=True, text=True, timeout=120)


def _json(*args):
    r = _run("--json", *args)
    return json.loads(r.stdout), r


class BlindnessIsNeverImprovement(unittest.TestCase):
    """The defect direction: the one that ships a confident green.

    History: the older half genuinely failed, the newer half cannot evaluate at
    all. Fold unevaluable into pass and the failure rate drops 100% -> 0%, which
    renders as a perfect recovery. It is the opposite: the gate stopped being
    able to see.
    """

    def setUp(self):
        self.path = _states("FAIL", "FAIL", "UNEVALUABLE", "UNEVALUABLE")

    def test_the_verdict_is_going_blind_not_improving(self):
        summary, r = _json("--file", self.path)
        self.assertEqual(
            summary["direction"], "going_blind",
            "failures replaced by blind runs reported %r; a gate that cannot "
            "evaluate has not passed" % summary["direction"])
        self.assertIn("GOING BLIND", _run("--file", self.path).stdout)

    def test_unevaluable_is_counted_as_neither_pass_nor_fail(self):
        summary, _ = _json("--file", self.path)
        self.assertEqual(summary["counts"]["unevaluable"], 2)
        self.assertEqual(
            summary["counts"]["pass"], 0,
            "an unevaluable record was counted as a pass, which is how a blind "
            "gate reports a healthy pass rate")

    def test_a_blind_gate_never_exits_zero(self):
        """gate-trend is named gate-*, so exiting 0 here tells CI to merge."""
        self.assertEqual(_run("--file", self.path).returncode, COULD_NOT_CHECK)

    def test_a_wholly_blind_log_is_not_a_perfect_record(self):
        """Every record unevaluable: the pass rate must be a measured 0%."""
        path = _states("UNEVALUABLE", "UNEVALUABLE", "UNEVALUABLE")
        summary, r = _json("--file", path)
        self.assertEqual(r.returncode, COULD_NOT_CHECK)
        self.assertEqual(summary["counts"]["pass"], 0)
        self.assertEqual(summary["newer"]["pass"], 0.0)
        self.assertEqual(summary["newer"]["unevaluable"], 1.0)

    def test_blindness_outranks_a_rising_failure_rate(self):
        """Both rise at once. The more urgent finding must be the one reported.

        An operator told only WORSENING fixes the failures, re-runs, sees the
        failure rate fall, and is still blind on the dead axis.
        """
        path = _states("PASS", "PASS", "PASS", "PASS",
                       "FAIL", "UNEVALUABLE", "FAIL", "UNEVALUABLE")
        summary, _ = _json("--file", path)
        self.assertGreater(summary["newer"]["fail"], summary["older"]["fail"],
                           "fixture is wrong: the failure rate did not rise")
        self.assertEqual(
            summary["direction"], "going_blind",
            "the failure rate and the blind rate both rose and the tool "
            "reported %r; blindness is the more urgent finding"
            % summary["direction"])

    def test_a_still_blind_gate_does_not_report_improvement(self):
        """Blindness FALLING but not to zero is still blindness.

        The other tests here cover blindness RISING. This is the case that
        wears a recovery story: 100% blind then 75% blind is "fewer blind runs
        than before", and reporting IMPROVING off it tells an operator the gate
        is recovering while three quarters of its runs still check nothing. The
        exit code is honest either way, which is exactly why this needs its own
        assertion: the human reads the WORD, not the exit code.
        """
        path = _states(*(["UNEVALUABLE"] * 7 + ["PASS"]))
        summary, r = _json("--file", path)
        self.assertLess(summary["blind_rate_newer"],
                        summary["blind_rate_older"],
                        "fixture is wrong: the blind rate did not fall")
        self.assertNotEqual(
            summary["direction"], "improving",
            "a gate still blind on %d of %d records reported IMPROVING"
            % (summary["counts"]["unevaluable"], summary["records"]))
        self.assertEqual(summary["direction"], "still_blind")
        self.assertNotIn("IMPROVING", _run("--file", path).stdout)
        self.assertEqual(r.returncode, COULD_NOT_CHECK)

    def test_an_unknown_state_word_is_blind_not_a_pass(self):
        """Vocabulary drift must never default to green."""
        path = _log(json.dumps({"verdict": {"state": "MAYBE"}}),
                    json.dumps({"verdict": {"state": "MAYBE"}}))
        summary, r = _json("--file", path)
        self.assertEqual(summary["counts"]["unevaluable"], 2)
        self.assertEqual(summary["counts"]["pass"], 0)
        self.assertNotEqual(r.returncode, PASSED)


class GenuineDataIsStillReported(unittest.TestCase):
    """The over-strict direction: a tool that cries blind is also useless."""

    def test_real_improvement_is_reported_as_improvement(self):
        path = _states("FAIL", "FAIL", "PASS", "PASS")
        summary, r = _json("--file", path)
        self.assertEqual(summary["direction"], "improving")
        self.assertEqual(r.returncode, PASSED,
                         "a clean improving history was not allowed to pass")

    def test_real_regression_is_reported_as_worsening(self):
        path = _states("PASS", "PASS", "FAIL", "FAIL")
        summary, r = _json("--file", path)
        self.assertEqual(summary["direction"], "worsening")
        self.assertEqual(r.returncode, FAILED)
        self.assertIn("WORSENING", _run("--file", path).stdout)

    def test_a_steady_clean_history_exits_zero(self):
        path = _states("PASS", "PASS", "PASS", "PASS")
        summary, r = _json("--file", path)
        self.assertEqual(summary["direction"], "steady")
        self.assertEqual(r.returncode, PASSED)

    def test_a_measured_zero_survives_as_zero(self):
        """fail: 0 over 4 readable records is a finding, not an UNKNOWN."""
        summary, _ = _json("--file", _states("PASS", "PASS", "PASS", "PASS"))
        self.assertEqual(summary["counts"]["fail"], 0)
        self.assertEqual(summary["counts"]["unevaluable"], 0)
        self.assertEqual(summary["newer"]["fail"], 0.0)
        self.assertIsNotNone(summary["direction"])

    def test_blindness_that_fully_cleared_is_a_real_improvement(self):
        """The over-strict trap: STILL BLIND must not swallow a real recovery.

        Blind in the older half, entirely readable in the newer half, is the
        one shape that genuinely earns "improving". A tool that reported
        STILL BLIND here would make recovery unobservable and would train
        operators to ignore the blind verdict altogether.
        """
        path = _states("UNEVALUABLE", "UNEVALUABLE", "PASS", "PASS")
        summary, _ = _json("--file", path)
        self.assertEqual(summary["blind_rate_newer"], 0.0)
        self.assertEqual(
            summary["direction"], "improving",
            "blindness cleared completely and the tool still refused to call "
            "it an improvement")

    def test_one_stale_blind_record_does_not_erase_the_trend(self):
        """Blindness in the PAST is not blindness now; the trend still reports."""
        path = _states("UNEVALUABLE", "FAIL", "PASS", "PASS")
        summary, _ = _json("--file", path)
        self.assertEqual(
            summary["direction"], "improving",
            "a single historical blind record suppressed a real improvement")
        self.assertEqual(summary["counts"]["unevaluable"], 1)


class FewerThanTwoIsInsufficientNotFlat(unittest.TestCase):
    """Flat is a claim about change over time. One point cannot make it."""

    def test_one_record_says_insufficient_data(self):
        r = _run("--file", _states("PASS"))
        self.assertIn("INSUFFICIENT DATA", r.stdout)
        self.assertNotIn("STEADY", r.stdout)

    def test_one_record_direction_is_unknown_never_steady(self):
        summary, _ = _json("--file", _states("PASS"))
        self.assertIsNone(summary["direction"])

    def test_one_record_never_exits_zero(self):
        """A gate saying it could not establish a trend has not checked it."""
        self.assertEqual(_run("--file", _states("PASS")).returncode,
                         COULD_NOT_CHECK)

    def test_two_records_are_enough(self):
        summary, r = _json("--file", _states("PASS", "PASS"))
        self.assertIsNotNone(summary["direction"])
        self.assertEqual(r.returncode, PASSED)


class CorruptLinesAreCountedNeverSkipped(unittest.TestCase):
    """A skipped line is a verdict the reader deleted from the record."""

    def setUp(self):
        self.path = _log(_row("PASS"), "{not json at all",
                         _row("PASS"), "[1, 2, 3]")

    def test_corrupt_lines_appear_in_the_count(self):
        summary, _ = _json("--file", self.path)
        self.assertEqual(summary["counts"][_CORRUPT], 2)
        self.assertEqual(
            summary["records"], 4,
            "corrupt lines were dropped, so the report describes a history "
            "that never happened")

    def test_corrupt_lines_force_the_blind_exit(self):
        self.assertEqual(_run("--file", self.path).returncode,
                         COULD_NOT_CHECK)

    def test_the_report_names_them(self):
        self.assertIn("corrupt", _run("--file", self.path).stdout)

    def test_a_trailing_newline_is_not_a_damaged_record(self):
        path = _log(_row("PASS"), _row("PASS"), "")
        summary, r = _json("--file", path)
        self.assertEqual(summary["counts"][_CORRUPT], 0)
        self.assertEqual(summary["records"], 2)
        self.assertEqual(r.returncode, PASSED)


class EmptyAndMissingLogs(unittest.TestCase):
    def test_an_empty_log_exits_three_never_zero(self):
        path = _log()
        r = _run("--file", path)
        self.assertEqual(r.returncode, NOTHING,
                         "an empty log must never read as 'never blocked'")
        self.assertNotEqual(r.returncode, PASSED)

    def test_a_missing_log_exits_66(self):
        r = _run("--file", "/nonexistent/definitely/not/here.jsonl")
        self.assertEqual(r.returncode, MISSING)


class TheExitContract(unittest.TestCase):
    def test_help_exits_zero_and_emits_no_verdict(self):
        r = _run("--help")
        self.assertEqual(r.returncode, PASSED)
        for word in ("GOING BLIND", "WORSENING", "INSUFFICIENT DATA"):
            self.assertNotIn(word, r.stdout + r.stderr,
                             "--help emitted a verdict nobody asked for")

    def test_an_unknown_flag_is_a_usage_error_not_a_path(self):
        self.assertEqual(_run("--bogus").returncode, USAGE)

    def test_a_stray_positional_is_never_read_as_a_log(self):
        """receipt-attest once read `--help` as a proof path and judged it."""
        r = _run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, USAGE)
        self.assertNotEqual(r.returncode, PASSED)

    def test_a_window_below_two_is_a_usage_error(self):
        for bad in ("0", "1"):
            with self.subTest(window=bad):
                self.assertEqual(
                    _run("--file", _states("PASS", "PASS"),
                         "--window", bad).returncode,
                    USAGE, "--window %s cannot establish a trend" % bad)


class TheWindow(unittest.TestCase):
    def test_the_window_takes_the_most_recent_records(self):
        path = _states("FAIL", "FAIL", "FAIL", "FAIL", "PASS", "PASS")
        summary, _ = _json("--file", path, "--window", "4")
        self.assertEqual(summary["records"], 4)
        self.assertEqual(summary["counts"]["pass"], 2)
        self.assertEqual(summary["direction"], "improving")

    def test_a_window_cannot_launder_a_corrupt_line(self):
        """Corrupt lines are inside the window like any other record."""
        path = _log(_row("PASS"), _row("PASS"), "{broken", _row("PASS"))
        summary, r = _json("--file", path, "--window", "2")
        self.assertEqual(summary["counts"][_CORRUPT], 1)
        self.assertEqual(r.returncode, COULD_NOT_CHECK)

    def test_a_window_larger_than_the_log_uses_every_record(self):
        summary, _ = _json("--file", _states("PASS", "FAIL"),
                           "--window", "500")
        self.assertEqual(summary["records"], 2)


if __name__ == "__main__":
    unittest.main()
