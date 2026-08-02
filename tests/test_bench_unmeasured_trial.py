"""A benchmark trial that never ran must not publish as a score of zero.

THE DEFECT THIS LOCKS DOWN. The grader sets success = (held-out acceptance exit
== 0) on whatever state it finds in the workdir. When the tool never ran -- not
installed, killed by the timeout, harness error -- that state is the untouched
fixture, so the acceptance command fails and the trial scores success=false.

Measured before the fix, all five exit_status values collapsed to one number:

    exit_status=cli_not_found  -> success_rate=0.0  n_trials=2
    exit_status=timeout        -> success_rate=0.0  n_trials=2
    exit_status=adapter_error  -> success_rate=0.0  n_trials=2
    exit_status=error_rc_1     -> success_rate=0.0  n_trials=2
    exit_status=completed      -> success_rate=0.0  n_trials=2

A competitor that is simply not installed on the box published as a measured
"0/3", tagged "automated (verified)", in the leaderboard table. That is the
worst class of benchmark bug: not a missing number but a confident false one,
in exactly the artifact built to be quoted externally.

This is the repo's standing rule -- an unmeasured value reads UNKNOWN, never 0
-- applied at the trial level. bench_schema.trial_is_measured is the single
definition, mirroring autonomy/lib/efficiency_cost.py::record_is_measured.

BOTH DIRECTIONS ARE ASSERTED. A guard that blanked genuine failures would be
its own dishonesty: it would erase every real zero the benchmark exists to
measure, and quietly inflate our own success rate. The v8.72.0 falsy-check trap
is the specific hazard -- 0 is falsy, so a falsy guard blanks real data. Every
check here is an explicit None check.

The three consumers are covered because fixing one and missing another leaves
the published claim corrupted: summarize_trials (the result-row summary),
report.summarize_row (the leaderboard table), and equivalence_report.cell_axes
(the hero gap and its Wilson interval).
"""

import json
import os
import pathlib
import sys
import tempfile
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_BENCH = _ROOT / "benchmarks" / "bench"
sys.path.insert(0, str(_BENCH))

import bench_schema as schema  # noqa: E402
import equivalence_report as er  # noqa: E402
import report as report_mod  # noqa: E402
import runner  # noqa: E402

# The tool ran and terminated under its own control. A failure is a REAL
# failure; the grader graded what the tool actually left behind.
MEASURED_STATUSES = ("completed", "error_rc_1", "error_rc_137")

# No measurement was taken. cli_not_found means it never ran; adapter_error
# means the harness broke, not the tool; timeout means killed mid-work, which
# matrix.sh already treats as a MISSING cell rather than a zero.
UNMEASURED_STATUSES = ("cli_not_found", "timeout", "adapter_error")


def _trial(success, exit_status, cost_usd=None, duration_s=1.0):
    """One trial record in the real runner shape."""
    return {
        "trial": 1,
        "success": success,
        "quality": {"lint_ok": None, "tests_ok": None},
        "acceptance_exit_code": 0 if success else 1,
        "cost_usd": cost_usd,
        "duration_s": duration_s,
        "adapter": {
            "tool": "faketool", "tool_version": "0", "model_used": "m",
            "duration_s": duration_s, "iterations": 0,
            "tokens_in": None, "tokens_out": None, "cost_usd": cost_usd,
            "exit_status": exit_status,
            "provenance": {"kind": "automated", "verified": True},
        },
    }


def _row(trials, tool="faketool", task_id="t1", task_hash="h1"):
    return {
        "schema_version": schema.SCHEMA_VERSION,
        "task_id": task_id, "task_path": "p", "task_hash": task_hash,
        "tool": tool, "model": "m", "trials": trials,
        "summary": schema.summarize_trials(trials),
    }


class TestPredicate(unittest.TestCase):
    """trial_is_measured: the single definition, and its fail-safe direction."""

    def test_ran_and_terminated_is_measured(self):
        for status in MEASURED_STATUSES:
            with self.subTest(status=status):
                self.assertTrue(schema.trial_is_measured(_trial(False, status)))

    def test_never_produced_a_result_is_unmeasured(self):
        for status in UNMEASURED_STATUSES:
            with self.subTest(status=status):
                self.assertFalse(schema.trial_is_measured(_trial(False, status)))

    def test_absent_exit_status_reads_as_measured(self):
        """Fail-safe: absent/unknown must not silently delete real data.

        Measuredness is derived at READ time from exit_status precisely so old
        rows retro-classify. A row predating this predicate, or one from an
        adapter using a status string we do not know, keeps its k/N exactly.
        """
        self.assertTrue(schema.trial_is_measured({"success": True}))
        self.assertTrue(schema.trial_is_measured(
            {"success": True, "adapter": {}}))
        self.assertTrue(schema.trial_is_measured(
            {"success": True, "adapter": {"exit_status": "some_new_status"}}))

    def test_case_and_whitespace_insensitive(self):
        self.assertFalse(schema.trial_is_measured(
            {"success": False, "adapter": {"exit_status": "  CLI_Not_Found "}}))


class TestRealZeroSurvives(unittest.TestCase):
    """The critical safety direction: a genuine 0 must stay 0, never UNKNOWN."""

    def test_summarize_trials_keeps_a_real_zero(self):
        trials = [_trial(False, "completed") for _ in range(3)]
        s = schema.summarize_trials(trials)
        self.assertIsNotNone(s["success_rate"])
        self.assertEqual(s["success_rate"], 0.0)
        self.assertEqual((s["n_trials"], s["n_success"], s["n_unmeasured"]),
                         (3, 0, 0))

    def test_a_tool_that_ran_and_failed_is_still_scored_zero(self):
        """error_rc_N is a real failure to solve the task, not a lost trial."""
        s = schema.summarize_trials([_trial(False, "error_rc_1") for _ in range(3)])
        self.assertEqual(s["success_rate"], 0.0)
        self.assertEqual(s["n_unmeasured"], 0)

    def test_zero_cost_is_not_blanked(self):
        """0 is falsy. An explicitly recorded $0.00 must survive as 0.0."""
        s = schema.summarize_trials([_trial(True, "completed", cost_usd=0.0)])
        self.assertIsNotNone(s["cost_usd_median"])
        self.assertEqual(s["cost_usd_median"], 0.0)

    def test_complete_run_is_unaffected(self):
        """A fully measured mixed run keeps exactly its pre-fix numbers."""
        trials = [_trial(True, "completed"), _trial(False, "completed"),
                  _trial(True, "completed"), _trial(False, "error_rc_2")]
        s = schema.summarize_trials(trials)
        self.assertEqual(s["success_rate"], 0.5)
        self.assertEqual((s["n_trials"], s["n_success"]), (4, 2))
        self.assertEqual(s["n_unmeasured"], 0)
        self.assertEqual(s["n_attempted"], 4)


class TestUnmeasuredIsDistinguishable(unittest.TestCase):
    """The defect itself: lost trials must not be counted as failures."""

    def test_unmeasured_excluded_from_denominator(self):
        """The denominator is the MEASURED count, never the attempted count."""
        trials = [_trial(True, "completed"), _trial(False, "cli_not_found")]
        s = schema.summarize_trials(trials)
        # Pre-fix this was 1/2 = 0.5. The tool solved every task it was
        # actually run on.
        self.assertEqual(s["success_rate"], 1.0)
        self.assertEqual((s["n_trials"], s["n_attempted"], s["n_unmeasured"]),
                         (1, 2, 1))

    def test_all_unmeasured_is_none_not_zero(self):
        """The headline case: an uninstalled tool has no rate at all."""
        for status in UNMEASURED_STATUSES:
            with self.subTest(status=status):
                s = schema.summarize_trials([_trial(False, status)] * 3)
                self.assertIsNone(
                    s["success_rate"],
                    "%s must publish UNKNOWN, never a score of 0" % status)
                self.assertEqual(s["n_trials"], 0)
                self.assertEqual(s["n_unmeasured"], 3)

    def test_empty_trial_list_has_no_rate(self):
        """Zero trials is zero observations. Pre-fix this published 0.0."""
        self.assertIsNone(schema.summarize_trials([])["success_rate"])

    def test_distinguishable_from_a_real_zero(self):
        """The property the benchmark's credibility rests on."""
        real_zero = schema.summarize_trials([_trial(False, "completed")] * 3)
        never_ran = schema.summarize_trials([_trial(False, "cli_not_found")] * 3)
        self.assertNotEqual(real_zero["success_rate"], never_ran["success_rate"])
        self.assertEqual(real_zero["success_rate"], 0.0)
        self.assertIsNone(never_ran["success_rate"])


class TestLeaderboard(unittest.TestCase):
    """report.py: the table that actually gets quoted."""

    def test_uninstalled_tool_does_not_render_as_zero(self):
        rows = [_row([_trial(False, "completed")] * 3, tool="loki"),
                _row([_trial(False, "cli_not_found")] * 3, tool="aider")]
        md = report_mod.render_markdown(report_mod.build_report(rows))
        self.assertIn("not measured", md)
        # The uninstalled row must not carry a k/N score.
        aider_line = [l for l in md.splitlines() if l.startswith("| aider ")][0]
        self.assertNotIn("0/3", aider_line)
        # The tool that really ran keeps its real zero.
        loki_line = [l for l in md.splitlines() if l.startswith("| loki ")][0]
        self.assertIn("0/3", loki_line)

    def test_unmeasured_tool_cannot_win(self):
        """A tool with no measurement must never be handed the leaderboard."""
        rows = [_row([_trial(False, "completed")] * 3, tool="loki"),
                _row([_trial(False, "cli_not_found")] * 3, tool="aider")]
        results = report_mod.build_report(rows)
        self.assertNotEqual(results["winner"], "aider")

    def test_summarize_row_counts_only_measured(self):
        s = report_mod.summarize_row(
            _row([_trial(True, "completed"), _trial(False, "timeout")]))
        self.assertEqual((s["k"], s["n"]), (1, 1))
        self.assertEqual(s["success_rate"], 1.0)
        self.assertEqual(s["n_unmeasured"], 1)

    def test_measured_leaderboard_is_unaffected(self):
        s = report_mod.summarize_row(
            _row([_trial(True, "completed"), _trial(False, "completed")]))
        self.assertEqual((s["k"], s["n"], s["success_rate"], s["n_unmeasured"]),
                         (1, 2, 0.5, 0))


class TestEquivalenceCell(unittest.TestCase):
    """equivalence_report.cell_axes: feeds the hero gap and the Wilson CI."""

    def test_lost_trials_do_not_deflate_the_cell(self):
        cx = er.cell_axes([_row([_trial(True, "completed"),
                                 _trial(False, "timeout")])])
        self.assertEqual(cx["n_trials"], 1)
        self.assertEqual(cx["n_unmeasured"], 1)
        self.assertEqual(cx["correctness"]["success_rate"], 1.0)
        # The Wilson interval must be built from the observed trial only.
        self.assertEqual(cx["obs"], [1])

    def test_all_unmeasured_cell_reads_not_run(self):
        cx = er.cell_axes([_row([_trial(False, "cli_not_found")] * 3)])
        self.assertIsNone(cx["correctness"]["success_rate"])
        self.assertEqual(cx["n_trials"], 0)
        self.assertIn("not_run", er._fmt_rate(cx))

    def test_real_zero_cell_still_reports_zero(self):
        cx = er.cell_axes([_row([_trial(False, "completed")] * 3)])
        self.assertIsNotNone(cx["correctness"]["success_rate"])
        self.assertEqual(cx["correctness"]["success_rate"], 0.0)
        self.assertEqual(cx["obs"], [0, 0, 0])
        self.assertNotIn("not_run", er._fmt_rate(cx))

    def test_cost_per_verified_not_polluted_by_lost_trials(self):
        """A lost trial's cost must not be divided over real successes."""
        cx = er.cell_axes([_row([_trial(True, "completed", cost_usd=1.0),
                                 _trial(False, "timeout", cost_usd=5.0)])])
        self.assertEqual(cx["cost_usd_per_verified"], 1.0)


class TestEndToEndThroughRunner(unittest.TestCase):
    """The real run_task path with a mocked adapter -- no network, no keys."""

    def _task(self, tmp):
        fixture = os.path.join(tmp, "fixture")
        os.makedirs(fixture, exist_ok=True)
        spec = {
            "schema_version": "1.0", "id": "t1", "source": "synthetic",
            "fixture": "fixture", "prompt": "do it", "default_model": "m",
            "acceptance": {"cmd": "test -f DONE", "timeout_s": 10},
        }
        path = os.path.join(tmp, "t1.json")
        with open(path, "w") as fh:
            json.dump(spec, fh)
        return path

    def _adapter(self, status):
        def run(workdir, prompt_path, **kwargs):
            return {
                "tool": "faketool", "tool_version": "0", "model_used": "m",
                "duration_s": 0.1, "iterations": 0,
                "tokens_in": None, "tokens_out": None, "cost_usd": None,
                "exit_status": status,
                "provenance": {"kind": "automated", "verified": True},
            }
        return run

    def test_uninstalled_tool_produces_no_score(self):
        with tempfile.TemporaryDirectory() as tmp:
            row = runner.run_task(self._task(tmp), "faketool", trials=3,
                                  adapter=self._adapter("cli_not_found"))
            self.assertIsNone(row["summary"]["success_rate"])
            self.assertEqual(row["summary"]["n_unmeasured"], 3)

    def test_genuine_failure_still_scores_zero(self):
        """Same fixture, same failing acceptance -- but the tool really ran."""
        with tempfile.TemporaryDirectory() as tmp:
            row = runner.run_task(self._task(tmp), "faketool", trials=3,
                                  adapter=self._adapter("completed"))
            self.assertIsNotNone(row["summary"]["success_rate"])
            self.assertEqual(row["summary"]["success_rate"], 0.0)

    def test_row_still_validates(self):
        """success stays a bool: the schema forbids None and run_task raises."""
        with tempfile.TemporaryDirectory() as tmp:
            row = runner.run_task(self._task(tmp), "faketool", trials=2,
                                  adapter=self._adapter("timeout"))
            self.assertEqual(schema.validate_result_row(row), [])
            for t in row["trials"]:
                self.assertIsInstance(t["success"], bool)


if __name__ == "__main__":
    unittest.main()
