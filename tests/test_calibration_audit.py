"""The calibration audit reports honestly, including about what it cannot see.

WHY THESE TESTS AND NOT OTHERS. A calibration tool has one failure mode that
matters more than a wrong decimal: reporting a confident number over a sample
that does not support it, or filling an absent measurement with a plausible
zero. Both look exactly like a working tool. So the assertions here are weighted
toward:

  the arithmetic, checked against a HAND-DERIVED answer rather than against
    whatever the code happened to produce (a test that asserts the current
    output only pins the current output),
  empty bins printing UNKNOWN and never 0.0,
  the headline being REFUSED below the support floor,
  and the tool staying at exit 0 when calibration is terrible, because it is a
    reporter and a reporter that fails CI gets disabled.

THE VACUITY GUARD, which every other assertion depends on. A scan that matches
no files reports perfect calibration over zero samples and passes any test that
only checks a number. So the fixtures assert that transcripts were FOUND and
that at least one voter was PARSED before any calibration claim is trusted.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "calibration-audit.py"


def _run(*args):
    return subprocess.run(
        [sys.executable, str(_TOOL), *args],
        capture_output=True, text=True, timeout=120)


def _transcript(path, iteration, outcome, voters):
    payload = {
        "iteration_id": "iter-%d-X" % iteration,
        "iteration": iteration,
        "timestamp": "2026-01-01T00:00:0%dZ" % (iteration % 10),
        "task_or_prd": "fixture",
        "prd_path": "fixture.md",
        "voters": voters,
        "outcome": outcome,
        "contrarian_triggered": False,
        "contrarian_flipped": False,
        "approve_count": sum(1 for v in voters if v["verdict"] == "APPROVE"),
        "reject_count": sum(1 for v in voters if v["verdict"] != "APPROVE"),
        "threshold": 2,
        "total_members": len(voters),
    }
    with open(path, "w") as handle:
        json.dump(payload, handle)


def _voter(name="reviewer_a", role_index=1, verdict="APPROVE",
           contrarian=False):
    return {
        "name": name,
        "role_index": role_index,
        "verdict": verdict,
        "reasoning": "fixture",
        "issues": [],
        "is_contrarian": contrarian,
    }


class _Workspace(unittest.TestCase):
    """Fixtures live in a temp dir, so no test can write into the worktree."""

    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.dir = os.path.join(self.ws, ".loki", "council", "transcripts")
        os.makedirs(self.dir)
        self.addCleanup(shutil.rmtree, self.ws, ignore_errors=True)

    def report(self, *args):
        r = _run(self.ws, "--json", *args)
        return r, json.loads(r.stdout)


class TheScanIsNotVacuous(_Workspace):
    """Nothing below this class is meaningful if the scan matched nothing.

    A calibration tool over an empty set reports a perfect, meaningless
    number. This asserts the substrate was actually read before any other
    test's arithmetic is trusted.
    """

    def test_transcripts_are_found_and_voters_are_parsed(self):
        for i in range(3):
            _transcript(os.path.join(self.dir, "iter-%d-X.json" % i), i,
                        "APPROVED", [_voter()])
        _, report = self.report()
        miss = report["missingness"]
        self.assertEqual(miss["files_found"], 3,
                         "scan found no transcripts; every calibration number "
                         "below would be computed over zero samples")
        self.assertEqual(miss["transcripts_used"], 3)
        self.assertGreater(miss["voters_seen"], 0,
                           "no voter was parsed, so a perfect score here "
                           "would mean nothing was measured")
        self.assertEqual(report["total_predictions"], 3)


class TheArithmeticMatchesAHandDerivedAnswer(_Workspace):
    """Checked against a number worked out by hand, not against the code.

    Fixture: one voter APPROVES 40 times; the council APPROVED on exactly 20
    of them. Every prediction is 1.0, half the labels are 1.

      Brier = mean((1 - label)^2) = (20*0 + 20*1)/40 = 0.5 exactly
      ECE   = all 40 predictions land in the top bin, where predicted rate is
              1.0 and observed rate is 0.5, so the support-weighted gap is
              (40/40) * |1.0 - 0.5| = 0.5 exactly
    """

    def _build(self, approvals=20, total=40):
        for i in range(total):
            outcome = "APPROVED" if i < approvals else "REJECTED"
            _transcript(os.path.join(self.dir, "iter-%03d-X.json" % i), i,
                        outcome, [_voter()])

    def test_brier_is_exactly_one_half(self):
        self._build()
        _, report = self.report()
        self.assertEqual(report["total_predictions"], 40)
        self.assertTrue(report["sufficient_support"])
        self.assertAlmostEqual(report["brier"], 0.5, places=9)

    def test_ece_is_exactly_one_half(self):
        self._build()
        _, report = self.report()
        self.assertAlmostEqual(report["ece"], 0.5, places=9)

    def test_a_perfectly_calibrated_voter_scores_zero(self):
        """The other end of the scale, so 0.5 is not just an arithmetic fluke.

        A voter who approves 40 times and the council approves all 40 has
        Brier 0 and ECE 0 by hand.
        """
        self._build(approvals=40, total=40)
        _, report = self.report()
        self.assertAlmostEqual(report["brier"], 0.0, places=9)
        self.assertAlmostEqual(report["ece"], 0.0, places=9)

    def test_the_worst_possible_voter_scores_one(self):
        self._build(approvals=0, total=40)
        _, report = self.report()
        self.assertAlmostEqual(report["brier"], 1.0, places=9)
        self.assertAlmostEqual(report["ece"], 1.0, places=9)


class AnEmptyBinIsUnknownAndNeverZero(_Workspace):
    """The single most dangerous imputation available to this tool.

    Predictions are binary, so with 10 bins eight are empty ALWAYS. Printing
    those as an observed rate of 0.0 would draw a large, perfectly-wrong
    region of the reliability curve out of the absence of any data, and the
    curve would look measured.
    """

    def setUp(self):
        super().setUp()
        for i in range(40):
            _transcript(os.path.join(self.dir, "iter-%03d-X.json" % i), i,
                        "APPROVED" if i < 20 else "REJECTED", [_voter()])

    def test_bins_with_no_support_report_unknown(self):
        _, report = self.report()
        empty = [row for row in report["reliability"] if row["support"] == 0]
        self.assertTrue(empty, "fixture produced no empty bin, so this test "
                               "cannot detect an imputed zero")
        for row in empty:
            self.assertEqual(row["observed_rate"], "UNKNOWN",
                             "bin %d has no support but reports an observed "
                             "rate; that is invented data" % row["bin"])
            self.assertEqual(row["predicted_rate"], "UNKNOWN")

    def test_every_bin_is_printed_with_its_support(self):
        """A bin with n=2 must not be presentable as a bin with n=200."""
        _, report = self.report()
        self.assertEqual(len(report["reliability"]), 10)
        for row in report["reliability"]:
            self.assertIn("support", row)
        occupied = [r for r in report["reliability"] if r["support"] > 0]
        self.assertEqual(len(occupied), 1, "all predictions were APPROVE, so "
                                           "exactly one bin should be occupied")
        self.assertEqual(occupied[0]["support"], 40)

    def test_the_rendered_table_shows_unknown_not_zero(self):
        r = _run(self.ws)
        self.assertEqual(r.returncode, 0)
        self.assertIn("UNKNOWN", r.stdout)
        self.assertIn("empty bins are UNKNOWN, not 0", r.stdout)


class TheHeadlineIsRefusedOnThinEvidence(_Workspace):
    def test_four_samples_get_no_headline_number(self):
        for i in range(4):
            _transcript(os.path.join(self.dir, "iter-%d-X.json" % i), i,
                        "APPROVED", [_voter()])
        r, report = self.report()
        self.assertEqual(report["total_predictions"], 4)
        self.assertFalse(report["sufficient_support"])
        self.assertEqual(report["brier"], "UNKNOWN",
                         "a Brier score over 4 samples is noise wearing a "
                         "decimal point and must not be presented")
        self.assertEqual(report["ece"], "UNKNOWN")

    def test_insufficient_support_is_stated_prominently(self):
        for i in range(4):
            _transcript(os.path.join(self.dir, "iter-%d-X.json" % i), i,
                        "APPROVED", [_voter()])
        r = _run(self.ws)
        self.assertIn("INSUFFICIENT SUPPORT", r.stdout)
        self.assertEqual(r.returncode, 0, "thin evidence is a reporting "
                                          "outcome, not a tool failure")

    def test_the_refusal_states_the_actual_numbers_not_a_slogan(self):
        """A template that interpolates any n into "noise wearing a decimal
        point" asserts something FALSE once n is large but the floor is
        higher. Understatement by template is the same defect as
        overstatement, mirrored."""
        for i in range(40):
            _transcript(os.path.join(self.dir, "iter-%03d-X.json" % i), i,
                        "APPROVED", [_voter()])
        r = _run(self.ws, "--min-support", "200")
        self.assertIn("INSUFFICIENT SUPPORT", r.stdout)
        self.assertIn("below the stated floor (200)", r.stdout)
        self.assertNotIn("40 sample(s) is noise", r.stdout)

    def test_the_floor_is_a_stated_knob(self):
        for i in range(4):
            _transcript(os.path.join(self.dir, "iter-%d-X.json" % i), i,
                        "APPROVED", [_voter()])
        _, report = self.report("--min-support", "2")
        self.assertTrue(report["sufficient_support"])
        self.assertNotEqual(report["brier"], "UNKNOWN")


class ClusteringIsDisclosedNextToTheCount(_Workspace):
    """The pooled vote count overstates independent support.

    Three voters per transcript are all scored against the SAME label, so 120
    votes from 40 transcripts are nowhere near 120 independent observations.
    Printing only the vote count would inflate apparent support by roughly the
    council size -- in a tool built to refuse overstatement, that is the defect
    it exists to prevent, arriving through the front door.
    """

    def setUp(self):
        super().setUp()
        for i in range(40):
            _transcript(
                os.path.join(self.dir, "iter-%03d-X.json" % i), i,
                "APPROVED" if i < 20 else "REJECTED",
                [_voter(name="a", role_index=1),
                 _voter(name="b", role_index=2, verdict="REJECT"),
                 _voter(name="c", role_index=3)])

    def test_the_transcript_count_is_printed_beside_the_prediction_count(self):
        r = _run(self.ws)
        self.assertIn("usable predictions: 120   from 40 transcript(s)",
                      r.stdout)

    def test_the_clustering_caveat_is_stated(self):
        r = _run(self.ws)
        self.assertIn("CLUSTERED", r.stdout)
        self.assertIn("effective sample", r.stdout)

    def test_both_counts_are_recoverable_from_json(self):
        _, report = self.report()
        self.assertEqual(report["total_predictions"], 120)
        self.assertEqual(report["missingness"]["transcripts_used"], 40)


class TheBinCountIsPrintedBecauseEceDependsOnIt(_Workspace):
    def setUp(self):
        super().setUp()
        for i in range(40):
            _transcript(os.path.join(self.dir, "iter-%03d-X.json" % i), i,
                        "APPROVED" if i < 20 else "REJECTED", [_voter()])

    def test_the_bin_count_appears_next_to_the_ece(self):
        r = _run(self.ws)
        self.assertRegex(r.stdout, r"ECE:\s+[\d.]+\s+at 10 bins")
        self.assertIn("changing --bins changes this number", r.stdout)

    def test_the_bin_count_is_recorded_in_json(self):
        _, report = self.report("--bins", "4")
        self.assertEqual(report["bins"], 4)
        self.assertEqual(len(report["reliability"]), 4)


class MissingnessIsItsOwnResult(_Workspace):
    def test_cannot_validate_is_excluded_and_counted(self):
        for i in range(10):
            _transcript(os.path.join(self.dir, "iter-%d-X.json" % i), i,
                        "APPROVED",
                        [_voter(), _voter(name="b", role_index=2,
                                          verdict="CANNOT_VALIDATE")])
        _, report = self.report()
        self.assertEqual(report["missingness"]["votes_cannot_validate"], 10)
        self.assertEqual(report["total_predictions"], 10,
                         "CANNOT_VALIDATE must not enter the sample: "
                         "declining to assert is not a wrong assertion")

    def test_unparseable_files_are_counted_not_silently_dropped(self):
        _transcript(os.path.join(self.dir, "good.json"), 1, "APPROVED",
                    [_voter()])
        with open(os.path.join(self.dir, "bad.json"), "w") as handle:
            handle.write("{not json")
        _, report = self.report()
        self.assertEqual(report["missingness"]["files_found"], 2)
        self.assertEqual(report["missingness"]["files_unparseable"], 1)
        self.assertEqual(report["missingness"]["transcripts_used"], 1)

    def test_absent_fields_are_counted(self):
        no_voters = os.path.join(self.dir, "a.json")
        _transcript(no_voters, 1, "APPROVED", [])
        with open(os.path.join(self.dir, "b.json"), "w") as handle:
            json.dump({"iteration": 2, "voters": [_voter()]}, handle)
        _, report = self.report()
        miss = report["missingness"]
        self.assertEqual(miss["files_missing_voters"], 1)
        self.assertEqual(miss["files_missing_outcome"], 1)

    def test_blocked_by_gate_is_counted_separately(self):
        """Labelled 0 under the stated convention, and visible so a reader
        who reads it differently can re-derive without re-running."""
        for i in range(5):
            _transcript(os.path.join(self.dir, "iter-%d-X.json" % i), i,
                        "BLOCKED_BY_GATE", [_voter()])
        _, report = self.report()
        self.assertEqual(report["missingness"]["outcome_blocked_by_gate"], 5)


class TheBreakdownsCoverTheRecordedDimensions(_Workspace):
    def setUp(self):
        super().setUp()
        for i in range(30):
            _transcript(
                os.path.join(self.dir, "iter-%03d-X.json" % i), i,
                "APPROVED" if i < 15 else "REJECTED",
                [_voter(name="reviewer_a", role_index=1),
                 _voter(name="reviewer_b", role_index=2, verdict="REJECT"),
                 _voter(name="devils_advocate", role_index=3,
                        contrarian=True)])

    def test_by_name_by_role_index_and_by_contrarian_all_have_support(self):
        _, report = self.report()
        for key, expected in (("by_name", 3), ("by_role_index", 3),
                              ("by_is_contrarian", 2)):
            self.assertEqual(len(report[key]), expected, key)
            for row in report[key]:
                self.assertGreater(row["support"], 0)

    def test_a_contrarian_split_is_actually_computed(self):
        _, report = self.report()
        values = {row["value"] for row in report["by_is_contrarian"]}
        self.assertEqual(values, {"True", "False"})


class DimensionsTheArtifactsCannotSupportAreRefusedByName(_Workspace):
    """Gate, model and task were asked for and are not recorded.

    Each has a tempting nearby field, and naming the refusal in the output is
    what stops a future reader from wiring one of them up as a proxy.
    """

    def setUp(self):
        super().setUp()
        _transcript(os.path.join(self.dir, "a.json"), 1, "APPROVED",
                    [_voter()])

    def test_each_missing_dimension_is_reported_with_a_reason(self):
        _, report = self.report()
        dims = {d["dimension"]: d["reason"] for d in report["not_available"]}
        self.assertEqual(set(dims), {"gate", "model", "task"})
        for dimension, reason in dims.items():
            self.assertTrue(len(reason) > 40,
                            "%s is refused without a reason a reader can "
                            "check" % dimension)

    def test_no_breakdown_by_an_unrecorded_dimension_exists(self):
        """The refusal must be structural, not just prose in the header."""
        _, report = self.report()
        for forbidden in ("by_gate", "by_model", "by_task"):
            self.assertNotIn(forbidden, report,
                             "%s exists, so some field was pressed into "
                             "service as a proxy" % forbidden)

    def test_the_rendered_output_names_the_refusals(self):
        r = _run(self.ws)
        self.assertIn("NOT AVAILABLE", r.stdout)
        for dimension in ("by gate:", "by model:", "by task:"):
            self.assertIn(dimension, r.stdout)


class TheLabellingConventionIsStatedInTheOutput(_Workspace):
    """A reader must be able to disagree without reading the source."""

    def setUp(self):
        super().setUp()
        _transcript(os.path.join(self.dir, "a.json"), 1, "APPROVED",
                    [_voter()])

    def test_the_convention_and_its_circularity_are_printed(self):
        r = _run(self.ws)
        self.assertIn("LABELLING CONVENTION", r.stdout)
        self.assertIn("CIRCULARITY", r.stdout)
        self.assertIn("AGREEMENT", r.stdout)


class ThisIsAReporterNotAGate(_Workspace):
    def test_terrible_calibration_still_exits_zero(self):
        """The rule that keeps this tool installed.

        Every voter is maximally wrong: Brier 1.0, the worst score available.
        A gate would block. A reporter reports and exits 0, because a reporter
        that fails CI is a reporter someone deletes.
        """
        for i in range(40):
            _transcript(os.path.join(self.dir, "iter-%03d-X.json" % i), i,
                        "REJECTED", [_voter(verdict="APPROVE")])
        r, report = self.report()
        self.assertAlmostEqual(report["brier"], 1.0, places=9)
        self.assertEqual(r.returncode, 0,
                         "the worst possible calibration must still exit 0; "
                         "this is a reporter, not a gate")


class TheExitCodesFollowTheToolConvention(_Workspace):
    def test_reported_is_zero(self):
        _transcript(os.path.join(self.dir, "a.json"), 1, "APPROVED",
                    [_voter()])
        self.assertEqual(_run(self.ws).returncode, 0)

    def test_no_transcripts_is_three(self):
        r = _run(self.ws)
        self.assertEqual(r.returncode, 3)
        self.assertIn("NOTHING TO REPORT", r.stdout)

    def test_files_found_but_none_parseable_is_two_not_three(self):
        """The vacuity distinction this repo has paid for repeatedly.

        A directory of corrupt transcripts is a FAILED scan, not an empty
        one. Collapsing it into 3 would let total corruption read as
        "nothing to report" and pass unnoticed.
        """
        for name in ("a.json", "b.json"):
            with open(os.path.join(self.dir, name), "w") as handle:
                handle.write("{not json")
        r = _run(self.ws)
        self.assertEqual(r.returncode, 2)
        self.assertIn("CANNOT CHECK", r.stdout)

    def test_an_unknown_flag_is_sixty_four(self):
        """argparse defaults to 2, which here means 'could not check' -- a
        verdict about the history rather than about the command line."""
        self.assertEqual(_run(self.ws, "--bogus").returncode, 64)

    def test_a_missing_path_is_sixty_six(self):
        r = _run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66)
        self.assertIn("INPUT MISSING", r.stdout)

    def test_help_exits_zero_without_a_verdict(self):
        r = _run("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("NOTHING TO REPORT", r.stdout)
        self.assertNotIn("Brier score:", r.stdout)

    def test_a_nonsense_bin_count_is_a_usage_error(self):
        self.assertEqual(_run(self.ws, "--bins", "0").returncode, 64)


class ItSpendsNothingAndStartsNothing(unittest.TestCase):
    def test_the_source_invokes_no_provider_and_no_network(self):
        """Cheap structural check that the promise in the docstring holds."""
        source = _TOOL.read_text()
        for forbidden in ("subprocess", "urllib", "requests", "socket",
                          "http.client"):
            self.assertNotIn(forbidden, source,
                             "%s appears; this tool must read the filesystem "
                             "and nothing else" % forbidden)


if __name__ == "__main__":
    unittest.main()
