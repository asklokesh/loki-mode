"""A cost report must not invent the number it cannot measure.

WHAT THIS PINS. tools/cost-attribute.py answers "where did the run's money and
time go", and the artifacts can only half answer it: stage_complete records
DURATION per stage, efficiency records price a whole ITERATION, and nothing
attributes a dollar to a stage. So the tool has two ways to lie and this file
closes both.

THE FIRST LIE is the one this repo has paid for fifteen times over: an
UNMEASURED iteration summed as $0.00. It is invisible in the common case --
0.05 + 0 is still 0.05 -- and it surfaces exactly when instrumentation broke,
which is when the number matters most. A run whose iterations were all
unmeasured must total UNKNOWN, not $0.00, and it must say 0 of N were
measured rather than N of N.

THE SECOND LIE is a manufactured per-stage split. Dividing an iteration's cost
by each stage's share of wall clock produces a plausible table that no
artifact supports. This asserts the tool REFUSES, in words, and never prints a
dollar figure inside its per-stage section.

BOTH DIRECTIONS ARE ASSERTED, which is the point of the second class below. A
guard so strict it blanked genuine data would be its own dishonesty: a fully
measured run must still show its real dollars, and a fast gate that genuinely
took 0 seconds must survive as 0 rather than being reported as never recorded.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "cost-attribute.py"

_spec = importlib.util.spec_from_file_location("cost_attribute", _TOOL)
_ca = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ca)


def _measured(iteration, usd):
    return {
        "iteration": iteration, "input_tokens": 9412, "output_tokens": 23,
        "cache_read_tokens": 11008, "cache_creation_tokens": 0,
        "cost_usd": usd, "model": "gpt-5.6-sol",
        "duration_ms": 90000, "status": "completed",
    }


# The exact shape a real run produced when the provider wrote no usage:
# records present, every field zero.
def _unmeasured(iteration):
    return {
        "iteration": iteration, "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_creation_tokens": 0,
        "cost_usd": 0, "model": "high",
        "duration_ms": 90000, "status": "completed",
    }


def _workspace(stages=(), records=(), extra_lines=()):
    """Build a throwaway workspace.

    stages:  (stage, duration_s, iteration) tuples, written in the exact shape
             emit_stage_complete produces.
    records: efficiency dicts, filed by their "iteration" key.
    """
    ws = pathlib.Path(tempfile.mkdtemp())
    loki = ws / ".loki"
    loki.mkdir(parents=True, exist_ok=True)
    lines = []
    for stage, secs, it in stages:
        lines.append(json.dumps({
            "timestamp": "2026-08-02T10:00:00Z",
            "type": "stage_complete",
            "data": {"stage": stage, "status": "pass",
                     "duration_s": secs, "iteration": it},
        }))
    lines.extend(extra_lines)
    (loki / "events.jsonl").write_text(
        "".join(line + "\n" for line in lines), encoding="utf-8")
    if records:
        eff = loki / "metrics" / "efficiency"
        eff.mkdir(parents=True, exist_ok=True)
        for rec in records:
            (eff / ("iteration-%d.json" % rec["iteration"])).write_text(
                json.dumps(rec), encoding="utf-8")
    return str(ws)


def _run(*args):
    return subprocess.run(
        [sys.executable, str(_TOOL), *args],
        capture_output=True, text=True, timeout=120)


class UnmeasuredCostIsNeverZero(unittest.TestCase):
    """The direction that ships a false bill.

    Every iteration here has an efficiency record and every record is all
    zeros, which is what a provider writing no usage leaves behind. Summing
    those as 0.0 produces a confident "$0.00 total, 2 of 2 measured" -- the
    run certified as free at the exact moment measurement failed.
    """

    def setUp(self):
        self.ws = _workspace(
            stages=[("agent", 120, 1), ("code_review", 30, 1),
                    ("agent", 90, 2)],
            records=[_unmeasured(1), _unmeasured(2)])

    def test_the_total_is_unknown_not_zero(self):
        rep, code = _ca.attribute(self.ws)
        self.assertEqual(code, 0)
        self.assertIsNone(
            rep["total_measured_usd"],
            "the report totals an entirely unmeasured run as a dollar figure; "
            "unmeasured and free are different claims")

    def test_unmeasured_iterations_are_excluded_not_counted(self):
        """The count is what makes the exclusion visible to a reader."""
        rep, _ = _ca.attribute(self.ws)
        self.assertEqual(
            rep["measured_iterations"], 0,
            "an unmeasured iteration was counted as measured, so the report "
            "claims coverage it does not have")
        self.assertEqual(rep["total_iterations"], 2)
        self.assertTrue(all(it["usd"] is None
                            for it in rep["per_iteration_cost"]))

    def test_no_dollar_figure_reaches_the_reader(self):
        r = _run(self.ws)
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("$0.00", r.stdout,
                         "the report tells the operator the run was free")
        self.assertIn("UNKNOWN", r.stdout)

    def test_a_partly_measured_run_says_so_and_says_it_is_a_floor(self):
        """0.05 + 0 == 0.05, so this case hides the defect unless counted."""
        ws = _workspace(
            stages=[("agent", 10, 1), ("agent", 10, 2)],
            records=[_measured(1, 0.05), _unmeasured(2)])
        rep, _ = _ca.attribute(ws)
        self.assertAlmostEqual(rep["total_measured_usd"], 0.05, places=6)
        self.assertEqual(rep["measured_iterations"], 1)
        self.assertEqual(rep["total_iterations"], 2)
        out = _run(ws).stdout
        self.assertIn("1 of 2 iterations measured", out)
        self.assertIn("HIGHER", out,
                      "a subset total was presented as the whole bill")


class TheSplitIsRefusedNotInvented(unittest.TestCase):
    """No artifact attributes a dollar to a stage, so none may be printed."""

    def setUp(self):
        # One iteration, one measured cost, two stages of unequal duration --
        # the exact shape that tempts a duration-weighted split.
        self.ws = _workspace(
            stages=[("agent", 90, 1), ("code_review", 10, 1)],
            records=[_measured(1, 1.0)])

    def test_cost_per_stage_is_null_and_the_refusal_is_stated(self):
        rep, _ = _ca.attribute(self.ws)
        self.assertIsNone(rep["cost_per_stage"])
        self.assertIn("REFUSED", rep["cost_per_stage_why"])

    def test_no_per_stage_dollar_figure_is_rendered(self):
        """A duration-weighted split of $1.00 would print $0.90 and $0.10."""
        out = _run(self.ws).stdout
        section = out.split("COST PER STAGE")[1].split("=" * 60)[0]
        self.assertNotIn("$", section,
                         "a per-stage dollar figure appeared; no artifact "
                         "supports one")
        for invented in ("$0.90", "$0.10"):
            self.assertNotIn(invented, out)


class MeasuredDataIsStillReported(unittest.TestCase):
    """The opposite error: an over-strict guard blanks the whole surface."""

    def setUp(self):
        self.ws = _workspace(
            stages=[("agent", 120.0, 1), ("code_review", 30.0, 1),
                    ("agent", 60.0, 2)],
            records=[_measured(1, 0.25), _measured(2, 0.75)])

    def test_real_dollars_survive(self):
        rep, code = _ca.attribute(self.ws)
        self.assertEqual(code, 0)
        self.assertAlmostEqual(rep["total_measured_usd"], 1.0, places=6)
        self.assertEqual(rep["measured_iterations"], 2)
        self.assertEqual(rep["largest_cost_iteration"]["iteration"], 2)

    def test_real_seconds_survive_and_sum_across_iterations(self):
        rep, _ = _ca.attribute(self.ws)
        by_stage = {s["stage"]: s for s in rep["stages"]}
        self.assertAlmostEqual(by_stage["agent"]["total_s"], 180.0, places=1)
        self.assertEqual(by_stage["agent"]["iterations_recorded"], 2)
        self.assertEqual(rep["slowest_stage"]["stage"], "agent")

    def test_a_genuine_zero_second_stage_is_not_reported_as_missing(self):
        """0s from a fast gate is REAL data. Filtering on falsy loses it."""
        ws = _workspace(stages=[("lsp_diagnostics", 0, 1)],
                        records=[_measured(1, 0.01)])
        rep, _ = _ca.attribute(ws)
        names = [s["stage"] for s in rep["stages"]]
        self.assertIn("lsp_diagnostics", names,
                      "a measured 0s stage was dropped as if never recorded")
        self.assertEqual(rep["stages"][0]["total_s"], 0.0)

    def test_a_measured_zero_cost_survives_as_zero_not_unknown(self):
        """The rule cuts both ways: a real $0.00 is data, not a missing value.

        An iteration with genuine token counts and a priced cost of exactly
        zero (a cached-only turn) IS measured. A falsy check anywhere on the
        total or the contributor would report it as never recorded, which is
        the same class of lie as reporting unmeasured as free, inverted.
        """
        rec = _measured(1, 0.0)
        ws = _workspace(stages=[("agent", 5, 1)], records=[rec])
        rep, _ = _ca.attribute(ws)
        self.assertIsNotNone(
            rep["total_measured_usd"],
            "a measured zero was reported as never recorded")
        self.assertEqual(rep["total_measured_usd"], 0.0)
        self.assertEqual(rep["measured_iterations"], 1)
        self.assertIsNotNone(
            rep["largest_cost_iteration"],
            "a measured zero-cost run lost its largest contributor")
        self.assertNotIn("UNKNOWN", _run(ws).stdout)

    def test_a_stage_that_never_ran_is_absent_rather_than_zero(self):
        """Not-recorded and 0s are different claims; 0s means instant."""
        rep, _ = _ca.attribute(self.ws)
        self.assertNotIn("doc_generation",
                         [s["stage"] for s in rep["stages"]])
        out = _run(self.ws).stdout
        self.assertNotIn("doc_generation", out)


class CorruptLinesAreCountedNotSkipped(unittest.TestCase):
    def test_bad_lines_are_reported(self):
        ws = _workspace(
            stages=[("agent", 10, 1)],
            records=[_measured(1, 0.01)],
            extra_lines=['{"type": "stage_comp', "42", "not json at all"])
        rep, _ = _ca.attribute(ws)
        self.assertEqual(
            rep["corrupt_lines"], 3,
            "corrupt lines were dropped on the floor, so the report looks "
            "like a whole recording when it is not")
        self.assertIn("CORRUPT LINES: 3", _run(ws).stdout)

    def test_a_clean_recording_says_zero_corrupt(self):
        ws = _workspace(stages=[("agent", 10, 1)])
        self.assertEqual(_ca.attribute(ws)[0]["corrupt_lines"], 0)


class NoDataNeverLooksLikeSuccess(unittest.TestCase):
    def test_missing_workspace_exits_66(self):
        r = _run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66)

    def test_events_present_but_unusable_exits_3(self):
        ws = _workspace(extra_lines=["garbage", "{"])
        r = _run(ws)
        self.assertEqual(r.returncode, 3)
        self.assertIn("NOTHING TO ATTRIBUTE", r.stderr)

    def test_surviving_efficiency_records_do_not_rescue_a_dead_events_file(self):
        """The subtle one: cost survives, the stage axis does not.

        Efficiency records are a second witness to which iterations existed,
        so keying the no-data guard on the UNION of both sources lets a
        workspace with an entirely corrupt events.jsonl print a confident
        cost table headed "cost attribution" while the thing being attributed
        TO was never read. Exit 0 there would tell a CI job the attribution
        succeeded on a run whose stage axis is missing outright.
        """
        ws = _workspace(extra_lines=["garbage", "{"],
                        records=[_measured(1, 0.5)])
        r = _run(ws)
        self.assertEqual(
            r.returncode, 3,
            "a report was produced from cost records alone, with no stage "
            "axis to attribute to")
        self.assertNotIn("$0.5000", r.stdout + r.stderr)

    def test_the_failure_path_still_emits_json_when_asked(self):
        r = _run("/nonexistent/definitely/not/here", "--json")
        payload = json.loads(r.stdout)
        self.assertEqual(payload["status"], "no_events")


class TheExitConventionIsObeyed(unittest.TestCase):
    """tests/test_tool_exit_contract.py globs tools/*.py and adopts this."""

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = _run("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("NO DATA", r.stdout)
        self.assertNotIn("COST ATTRIBUTION", r.stdout)

    def test_an_unknown_flag_is_a_usage_error_not_a_path(self):
        """argparse defaults to 2, which here means 'could not check'."""
        r = _run("--not-a-flag")
        self.assertEqual(
            r.returncode, 64,
            "a typo exited %d; 2 means the instrument is blind, which is a "
            "different fact from a mistyped flag" % r.returncode)


if __name__ == "__main__":
    unittest.main()
