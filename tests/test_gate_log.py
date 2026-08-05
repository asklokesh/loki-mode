"""An aggregator is where "could not check" quietly becomes "passed".

WHAT THIS PINS. tools/gate-log.py accumulates ci-gate verdicts and reports the
pattern. Every honesty rule ci-gate.py holds for ONE run has a cheaper way to
die once you are counting MANY runs, and the cheap way is arithmetic:

    passes = total - failures

One line, entirely reasonable-looking, and it folds every UNEVALUABLE record
into the pass column. The failure mode it produces is the worst one available:
a gate that has been BLIND on an axis for weeks reports a rising pass rate,
because a blind axis never fails. The longer the instrumentation stays broken
the healthier the number looks.

So the sharpest test here is a mutation test. `_CATEGORY` maps the gate's three
verdict words to three buckets, and changing one word --

    "UNEVALUABLE": "unevaluable"   ->   "UNEVALUABLE": "pass"

-- is the whole defect, expressible as a single edit. UnevaluableIsNeverAPass
.test_unevaluable_is_counted_in_its_own_bucket is the assertion that must fail
when that edit is applied, and it fails on the unevaluable count rather than on
a KeyError, because every bucket is pre-seeded to 0.

BOTH DIRECTIONS ARE ASSERTED, because an over-strict fix is its own dishonesty:

  - a verdict carrying a state word we do not recognise is RECORDED as
    unevaluable, not refused. The gate ran and reported something; refusing the
    record would delete the evidence that our vocabulary drifted.
  - a log with three good lines and one corrupt line still reports all three
    good verdicts. "Counted, never skipped" cuts both ways: the corrupt line
    must not vanish, and it must not take the readable ones with it.
  - a measured zero survives as 0. "fail: 0" over many records is a finding,
    and it is a different fact from the UNKNOWN an empty log returns.

The CLI is exercised via subprocess, the same way tests/test_tool_exit_contract
.py does it, so what is asserted is the real tool a CI job runs.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

# Before any loader call: a stale .pyc makes a mutation probe report a FALSE
# failure against source that was never executed.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "gate-log.py"
_CI_GATE = _ROOT / "tools" / "ci-gate.py"

_spec = importlib.util.spec_from_file_location("gate_log", _TOOL)
_gl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gl)

# The exact shapes tools/ci-gate.py emits, captured from live runs.
_PASS = {"exit_code": 0, "state": "PASS",
         "policies": [{"policy": "cost", "state": "PASS", "exit_code": 0,
                       "reason": "within_budget"}],
         "reason": "1 of 1 policies passed"}

_FAIL = {"exit_code": 1, "state": "FAIL",
         "policies": [{"policy": "cost", "state": "FAIL", "exit_code": 1,
                       "reason": "cost $0.0100 exceeds the ceiling $0.0010"}],
         "reason": "0 of 1 policies passed"}

_UNEVALUABLE = {
    "exit_code": 2, "state": "UNEVALUABLE", "policies": [],
    "reason": "no policy configured: pass --max-usd and/or --require-receipt."}


def _run(*args, **kw):
    return subprocess.run([sys.executable, str(_TOOL), *args],
                          capture_output=True, text=True, timeout=120, **kw)


class _Log(unittest.TestCase):
    """A temp log path plus helpers to fill it."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, ".loki", "gate-log.jsonl")

    def record(self, verdict):
        r = _run("record", "--file", self.path,
                 input=json.dumps(verdict))
        return r

    def fill(self, *verdicts):
        for v in verdicts:
            self.assertEqual(self.record(v).returncode, 0)

    def report_json(self):
        r = _run("report", "--file", self.path, "--json")
        return r, json.loads(r.stdout) if r.stdout.strip() else None


class UnevaluableIsNeverAPass(_Log):
    """The defect this whole tool exists to prevent, asserted directly."""

    def test_unevaluable_is_counted_in_its_own_bucket(self):
        """THE mutation target: _CATEGORY["UNEVALUABLE"] -> "pass".

        Folding blindness into the pass column is the one edit that makes a
        gate look healthiest exactly when it has stopped checking.
        """
        self.fill(_PASS, _UNEVALUABLE, _UNEVALUABLE)
        _, summary = self.report_json()
        counts = summary["counts"]
        self.assertEqual(
            counts["unevaluable"], 2,
            "two blind runs did not land in the unevaluable bucket; counted "
            "as %r pass / %r fail instead, which is a gate reporting health "
            "while it was not checking" % (counts["pass"], counts["fail"]))
        self.assertEqual(
            counts["pass"], 1,
            "the pass column absorbed a run that could not be evaluated")

    def test_classify_never_defaults_to_pass(self):
        for shape in ({}, {"state": None}, {"state": "GREEN"},
                      {"state": 0}, [], "PASS", None):
            with self.subTest(shape=shape):
                self.assertEqual(
                    _gl.classify(shape), "unevaluable",
                    "an unrecognised shape was laundered into a verdict")

    def test_a_blind_history_never_exits_zero(self):
        """CI branches on this. Zero here means merge on an unchecked axis."""
        self.fill(_PASS, _UNEVALUABLE)
        r, _ = self.report_json()
        self.assertEqual(
            r.returncode, 2,
            "a history containing an unevaluable run exited %d" % r.returncode)

    def test_blind_outranks_failed(self):
        """Same precedence ci-gate uses: fix the cost and you are still blind."""
        self.fill(_FAIL, _UNEVALUABLE)
        r, _ = self.report_json()
        self.assertEqual(r.returncode, 2)

    def test_the_summary_carries_no_headline_pass_rate(self):
        """A single "94% passing" number is where blindness gets laundered.

        Four separate counts force a reader to see the blind column. One
        derived percentage lets them not to, and a blind axis never fails, so
        the percentage climbs as the instrumentation rots.
        """
        self.fill(_PASS, _UNEVALUABLE, _UNEVALUABLE)
        _, summary = self.report_json()
        self.assertEqual(sorted(summary["counts"]),
                         ["corrupt", "fail", "pass", "unevaluable"],
                         "the bucket set changed; blindness may have a home "
                         "other than its own column")
        for key in summary:
            self.assertNotIn(
                "rate", key,
                "%r reads as a headline health number over blind runs" % key)
        text = _run("report", "--file", self.path).stdout
        self.assertIn("unevaluable (NOT a pass)", text,
                      "the text report does not name blindness as non-passing")


class ACorruptLineIsCountedNeverSkipped(_Log):
    def _write_lines(self, *lines):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("".join(line + "\n" for line in lines))

    def _append(self, line):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")

    def test_corrupt_lines_are_reported_as_their_own_category(self):
        self.fill(_PASS)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write("{not json at all\n")
        r, summary = self.report_json()
        self.assertEqual(summary["counts"][_gl._CORRUPT], 1,
                         "a damaged verdict silently left the record")
        self.assertEqual(summary["records"], 2,
                         "the record total hid the unreadable line")
        self.assertEqual(r.returncode, 2,
                         "a half-eaten log reported a clean history")

    def test_readable_records_survive_alongside_a_corrupt_one(self):
        """Direction B: the corrupt line must not take the good ones with it."""
        self.fill(_PASS, _FAIL, _PASS)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write("}}garbage\n")
        _, summary = self.report_json()
        self.assertEqual(summary["counts"]["pass"], 2,
                         "one bad line suppressed the genuine passes")
        self.assertEqual(summary["counts"]["fail"], 1)
        self.assertEqual(summary["counts"][_gl._CORRUPT], 1)
        self.assertEqual(summary["readable"], 3)

    def test_an_all_corrupt_log_reports_unknown_not_a_measured_none(self):
        """The third state, and the one that reads most like a clean run.

        With every line unreadable there is no measurement of failures at all.
        "none -- no FAIL in any readable record" would be asserting a finding
        drawn from zero evidence, which is the unmeasured-reads-as-zero
        inversion this repo has paid for on more than a dozen surfaces.
        """
        self._write_lines("{broken", "also broken")
        r = _run("report", "--file", self.path)
        self.assertIn("most failing policy: UNKNOWN", r.stdout)
        self.assertNotIn("most failing policy: none", r.stdout)
        self.assertEqual(r.returncode, 2)
        _, summary = self.report_json()
        self.assertEqual(summary["readable"], 0)
        self.assertIsNone(summary["top_failing_policy"])

    def test_the_buckets_always_sum_to_the_record_total(self):
        """A stored category can never inflate the count of unreadable lines.

        "corrupt" is what THIS reader failed to parse, not a verdict a gate
        emits. Honouring it from an entry's own field would double-count and
        the totals would stop reconciling.
        """
        self.fill(_PASS)
        self._append('{"category": "corrupt", "verdict": {"state": "PASS"}}')
        _, summary = self.report_json()
        self.assertEqual(sum(summary["counts"].values()), summary["records"],
                         "the buckets no longer reconcile with the total")
        self.assertEqual(summary["counts"][_gl._CORRUPT], 0,
                         "a readable line was counted as unreadable")

    def test_a_blank_trailing_line_is_not_corruption(self):
        """Over-strictness would report damage on every normally-closed file."""
        self.fill(_PASS)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write("\n")
        _, summary = self.report_json()
        self.assertEqual(summary["counts"][_gl._CORRUPT], 0)
        self.assertEqual(summary["counts"]["pass"], 1)


class AnEmptyLogIsUnknownNotClean(_Log):
    def test_missing_log_exits_non_zero(self):
        r = _run("report", "--file", self.path)
        self.assertEqual(r.returncode, 66,
                         "a log that was never written read as a clean gate")
        self.assertIn("UNKNOWN", r.stderr)

    def test_present_but_empty_log_exits_non_zero(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        open(self.path, "w", encoding="utf-8").close()
        r = _run("report", "--file", self.path)
        self.assertEqual(r.returncode, 3)
        self.assertIn("UNKNOWN", r.stderr)
        self.assertNotIn("never blocked", r.stdout)

    def test_a_measured_zero_survives_as_zero(self):
        """Direction B. "fail: 0" over real records is a finding, not UNKNOWN."""
        self.fill(_PASS, _PASS)
        r, summary = self.report_json()
        self.assertEqual(summary["counts"]["fail"], 0)
        self.assertEqual(summary["counts"]["unevaluable"], 0)
        self.assertIsNotNone(summary["counts"]["fail"],
                             "a measured zero was blanked to unknown")
        self.assertEqual(r.returncode, 0,
                         "a genuinely clean history was not reported clean")


class MalformedStdinIsAnErrorNeverAPass(_Log):
    def _log_bytes(self):
        if not os.path.exists(self.path):
            return None
        with open(self.path, "rb") as fh:
            return fh.read()

    def test_unparseable_stdin_writes_nothing(self):
        r = _run("record", "--file", self.path, input="{oops")
        self.assertEqual(r.returncode, 66)
        self.assertIsNone(self._log_bytes(),
                          "a malformed verdict still produced a log row")

    def test_empty_stdin_writes_nothing(self):
        r = _run("record", "--file", self.path, input="")
        self.assertEqual(r.returncode, 66)
        self.assertIsNone(self._log_bytes())

    def test_a_json_array_is_refused(self):
        r = _run("record", "--file", self.path, input="[]")
        self.assertEqual(r.returncode, 66)
        self.assertIsNone(self._log_bytes())

    def test_a_failed_record_leaves_an_existing_log_byte_identical(self):
        self.fill(_PASS)
        before = self._log_bytes()
        self.assertEqual(_run("record", "--file", self.path,
                              input="nonsense").returncode, 66)
        self.assertEqual(self._log_bytes(), before,
                         "a refused record still mutated the log")

    def test_an_unrecognised_state_word_is_recorded_as_unevaluable(self):
        """Direction B: over-strictness would delete real evidence.

        The gate ran and reported something we cannot read. That IS what
        unevaluable means; refusing the row would hide that our own vocabulary
        drifted away from the gate's.
        """
        self.fill({"exit_code": 0, "state": "GREENISH", "policies": []})
        r, summary = self.report_json()
        self.assertEqual(summary["counts"]["unevaluable"], 1,
                         "a well-formed verdict with an unknown state word "
                         "was dropped instead of recorded as blind")
        self.assertEqual(summary["counts"]["pass"], 0)
        self.assertEqual(r.returncode, 2)


class RecordIsAppendOnlySingleWrite(_Log):
    def test_each_record_appends_exactly_one_line(self):
        self.fill(_PASS, _FAIL, _UNEVALUABLE)
        with open(self.path, "r", encoding="utf-8") as fh:
            lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        self.assertEqual(len(lines), 3)
        for line in lines:
            json.loads(line)  # every line stands alone

    def test_recording_never_edits_an_earlier_line(self):
        self.fill(_FAIL)
        with open(self.path, "r", encoding="utf-8") as fh:
            first = fh.readline()
        self.fill(_PASS)
        with open(self.path, "r", encoding="utf-8") as fh:
            self.assertEqual(fh.readline(), first,
                             "a later verdict rewrote an earlier one")

    def test_the_raw_verdict_is_kept_verbatim(self):
        self.fill(_FAIL)
        with open(self.path, "r", encoding="utf-8") as fh:
            entry = json.loads(fh.readline())
        self.assertEqual(entry["verdict"], _FAIL,
                         "summarising at write time loses evidence forever")


class ReportsThePattern(_Log):
    def test_most_frequently_failing_policy(self):
        cost = _FAIL
        receipt = {"exit_code": 1, "state": "FAIL",
                   "policies": [{"policy": "receipt", "state": "FAIL",
                                 "exit_code": 1, "reason": "no receipt"}],
                   "reason": "0 of 1 policies passed"}
        self.fill(cost, cost, receipt)
        _, summary = self.report_json()
        self.assertEqual(summary["top_failing_policy"],
                         {"policy": "cost", "failures": 2})

    def test_no_failures_reports_a_measured_none_not_unknown(self):
        """Direction B: "no policy failed" is a measurement, not an absence."""
        self.fill(_PASS, _PASS)
        r = _run("report", "--file", self.path)
        self.assertIn("most failing policy: none -- no FAIL in 2 readable",
                      r.stdout)
        self.assertNotIn("UNKNOWN", r.stdout.split("trend:")[0],
                         "a real measurement of zero failures was blanked")

    def test_a_blind_policy_is_not_named_as_a_failing_policy(self):
        """It never fired. Sending an engineer to fix it hides the dead axis."""
        blind = {"exit_code": 2, "state": "UNEVALUABLE",
                 "policies": [{"policy": "receipt", "state": "UNEVALUABLE",
                               "exit_code": 2, "reason": "tool missing"}],
                 "reason": "1 policy could not be evaluated"}
        self.fill(blind, blind)
        _, summary = self.report_json()
        self.assertIsNone(summary["top_failing_policy"])
        self.assertEqual(summary["counts"]["unevaluable"], 2)

    def test_trend_is_unknown_below_two_records(self):
        self.fill(_FAIL)
        r, summary = self.report_json()
        self.assertIsNone(summary["trend"],
                          "a trend was invented from one data point")
        self.assertIn("trend: UNKNOWN", _run(
            "report", "--file", self.path).stdout)

    def test_trend_reports_direction_over_two_halves(self):
        self.fill(_FAIL, _FAIL, _PASS, _PASS)
        _, summary = self.report_json()
        self.assertEqual(summary["trend"]["direction"], "improving")
        self.fill(_FAIL, _FAIL, _FAIL, _FAIL)
        _, summary = self.report_json()
        self.assertEqual(summary["trend"]["direction"], "worsening")

    def test_a_blind_half_is_not_an_improving_half(self):
        """The folding error again, this time inside the trend arithmetic."""
        self.fill(_FAIL, _FAIL, _UNEVALUABLE, _UNEVALUABLE)
        _, summary = self.report_json()
        self.assertEqual(
            summary["trend"]["newer_pass_rate"], 0.0,
            "blind runs were scored as passing runs in the trend")
        self.assertEqual(summary["trend"]["direction"], "steady")


class ObeysTheExitCodeConvention(_Log):
    def test_help_exits_zero_and_emits_no_verdict(self):
        for argv in (["--help"], ["record", "--help"], ["report", "--help"]):
            with self.subTest(argv=argv):
                r = _run(*argv)
                self.assertEqual(r.returncode, 0)
                self.assertNotIn("most failing policy", r.stdout)
                self.assertNotIn("gate-log: recorded", r.stderr)

    def test_a_usage_error_is_64_not_2(self):
        """2 means "could not check". A typo is not a finding about a merge."""
        for argv in (["--bogus"], ["record", "--bogus"],
                     ["report", "--bogus"], ["nosuchcommand"], []):
            with self.subTest(argv=argv):
                self.assertEqual(
                    _run(*argv).returncode, 64,
                    "%r did not exit 64; 2 would read as a blind gate" % argv)

    def test_an_unknown_flag_is_never_treated_as_a_path(self):
        r = _run("report", "--file")
        self.assertEqual(r.returncode, 64)

    def test_an_unreadable_log_is_two_not_one(self):
        """1 claims we checked and it failed. We could not open the file.

        A directory passes os.path.exists, so without a guard the OSError
        escapes and Python exits 1 -- a broken log path would read to CI as a
        real merge-blocking finding.
        """
        d = os.path.join(self.dir, "a-directory.jsonl")
        os.makedirs(d)
        r = _run("report", "--file", d)
        self.assertEqual(r.returncode, 2,
                         "an unreadable log reported a verdict about a merge")
        self.assertNotIn("Traceback", r.stderr)

    def test_a_nonexistent_path_is_never_success(self):
        """tests/test_tool_exit_contract.py globs tools/ and asserts this."""
        self.assertNotEqual(
            _run("/nonexistent/definitely/not/here").returncode, 0)


class AgainstTheRealCiGate(_Log):
    """No fixture drift: pipe the actual gate into the actual log."""

    def test_a_live_ci_gate_verdict_round_trips(self):
        ws = tempfile.mkdtemp()
        eff = pathlib.Path(ws) / ".loki" / "metrics" / "efficiency"
        eff.mkdir(parents=True, exist_ok=True)
        (eff / "iteration-1.json").write_text(json.dumps({
            "iteration": 1, "input_tokens": 100, "output_tokens": 10,
            "cost_usd": 0.01, "model": "x", "duration_ms": 1000,
            "status": "completed"}), encoding="utf-8")

        gate = subprocess.run(
            [sys.executable, str(_CI_GATE), ws, "--max-usd", "5", "--json"],
            capture_output=True, text=True, timeout=120)
        self.assertEqual(gate.returncode, 0, gate.stderr)
        self.assertEqual(_run("record", "--file", self.path,
                              input=gate.stdout).returncode, 0)

        blind = subprocess.run(
            [sys.executable, str(_CI_GATE), ws, "--json"],
            capture_output=True, text=True, timeout=120)
        self.assertEqual(blind.returncode, 2, blind.stderr)
        self.assertEqual(_run("record", "--file", self.path,
                              input=blind.stdout).returncode, 0)

        r, summary = self.report_json()
        self.assertEqual(summary["counts"]["pass"], 1)
        self.assertEqual(
            summary["counts"]["unevaluable"], 1,
            "the real gate's own UNEVALUABLE verdict was not preserved")
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
