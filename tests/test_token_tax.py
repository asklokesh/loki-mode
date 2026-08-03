"""tools/token-tax.py: an unmeasured run reads UNKNOWN, never 0.

THE PROPERTY THIS FILE EXISTS FOR. A run whose token counts were never
recorded must be counted SEPARATELY and excluded from every average. If it is
averaged in as zero, the mean slides toward "verification is free" -- the
conclusion a person arguing to delete the gates would want, reached by
arithmetic instead of by evidence. That is not a rounding error; it is a
fabricated finding, and every other assertion here is secondary to it.

VACUITY, which is how a test like this goes false-green. A scan that finds
nothing reports "0 tokens of overhead" and passes every downstream assertion
about honesty, because there is nothing to be dishonest about. So the fixture
scan is asserted FIRST: the tool must have found the records before any
aggregate it printed is trusted.
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
_TOOL = _ROOT / "tools" / "token-tax.py"

MEASURED = {
    "input_tokens": 1000, "output_tokens": 500,
    "cache_read_tokens": 4000, "cache_creation_tokens": 100,
    "cost_usd": 0.12,
}
# The exact shape codex wrote before v8.51.0: a real cost, and every token
# field zero. Tokens were NOT measured for this iteration, and a tool that
# feeds cost_usd into the measured-ness predicate reports it as "0 tokens".
COST_ONLY = {
    "input_tokens": 0, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "cost_usd": 0.44,
}
ALL_ZERO = {f: 0 for f in ("input_tokens", "output_tokens",
                           "cache_read_tokens", "cache_creation_tokens")}


def run(*args):
    return subprocess.run([sys.executable, str(_TOOL), *args],
                          capture_output=True, text=True, timeout=60)


def workspace(iterations=None, events=None):
    """Build a throwaway workspace. iterations: {n: record or None}."""
    ws = tempfile.mkdtemp(prefix="tokentax-")
    eff = os.path.join(ws, ".loki", "metrics", "efficiency")
    os.makedirs(eff)
    for n, rec in (iterations or {}).items():
        path = os.path.join(eff, "iteration-%d.json" % n)
        with open(path, "w") as fh:
            if rec is None:
                fh.write("{ this is not json")
            else:
                json.dump(rec, fh)
    if events is not None:
        with open(os.path.join(ws, ".loki", "events.jsonl"), "w") as fh:
            fh.write(events)
    return ws


def stage_line(stage, iteration=1, duration=3.0):
    return json.dumps({
        "type": "stage_complete",
        "data": {"stage": stage, "status": "pass",
                 "duration_s": duration, "iteration": iteration},
    }) + "\n"


class UnmeasuredIsNeverZero(unittest.TestCase):
    """The rule. Two measured runs and one unmeasured must average over TWO."""

    def setUp(self):
        # 1200 + 1200 measured, one unmeasured. Mean over the measured pair is
        # 1200. Mean over all three, counting the absent one as zero, is 800.
        rec = {"input_tokens": 600, "output_tokens": 600,
               "cache_read_tokens": 0, "cache_creation_tokens": 0}
        self.ws = workspace(
            iterations={1: rec, 2: dict(rec), 3: dict(ALL_ZERO)},
            events=stage_line("code_review") + stage_line("agent"))
        self.r = run(self.ws, "--json")
        self.rep = json.loads(self.r.stdout)

    def test_the_scan_found_records_before_any_aggregate_is_trusted(self):
        """VACUITY GUARD. An empty scan reports 0 overhead and looks honest."""
        self.assertEqual(self.r.returncode, 0, self.r.stderr)
        self.assertEqual(self.rep["iterations"], 3,
                         "the fixture scan found %d iterations, not 3 -- every "
                         "assertion below would be about an empty report"
                         % self.rep["iterations"])
        self.assertEqual(self.rep["measured_iterations"], 2)
        self.assertGreater(self.rep["total_tokens"], 0,
                           "a total of 0 makes the mean assertions vacuous")
        self.assertTrue(self.rep["verification_stages"],
                        "no stage records were read, so the stage axis is "
                        "vacuous")

    def test_the_unmeasured_run_is_counted_separately(self):
        self.assertEqual(self.rep["unmeasured_iterations"], 1)
        self.assertEqual(self.rep["measured_iterations"], 2)
        self.assertEqual(
            self.rep["measured_iterations"] + self.rep["unmeasured_iterations"],
            self.rep["iterations"],
            "every iteration must land in exactly one bucket")

    def test_the_mean_excludes_it_rather_than_averaging_it_as_zero(self):
        """THE LOAD-BEARING ASSERTION.

        1200 is the mean over the two measured runs. 800 is the mean an
        implementation gets by counting the unmeasured run as zero tokens --
        a 33% understatement of what the work cost, pointing at "cheap".
        """
        self.assertEqual(self.rep["mean_tokens_per_measured_iteration"], 1200.0)
        self.assertNotEqual(
            self.rep["mean_tokens_per_measured_iteration"], 800.0,
            "the unmeasured iteration was averaged in as zero tokens, which "
            "manufactures the conclusion that verification is cheap")

    def test_the_total_excludes_it_too(self):
        self.assertEqual(self.rep["total_tokens"], 2400)

    def test_that_iteration_reads_unknown_not_zero(self):
        by_n = {r["iteration"]: r["tokens"] for r in self.rep["per_iteration"]}
        self.assertIsNone(by_n[3],
                          "an unmeasured iteration reported a number; None is "
                          "the only honest value")
        self.assertEqual(by_n[1], 1200)

    def test_the_text_report_says_excluded_and_not_zero(self):
        r = run(self.ws)
        self.assertIn("UNKNOWN", r.stdout)
        self.assertIn("EXCLUDED", r.stdout)
        self.assertIn("NOT", r.stdout)


class CostWithoutTokensIsUnmeasured(unittest.TestCase):
    """A real cost_usd and zero tokens is a run whose TOKENS were not measured.

    token-guard.py documents this as verified rather than theoretical. Feeding
    cost_usd into record_is_measured() makes this record read as measured, and
    the tool then reports a confident "0 tokens" for a run nobody counted.
    """

    def test_a_cost_only_record_does_not_count_as_measured_tokens(self):
        ws = workspace(iterations={1: dict(COST_ONLY)})
        rep = json.loads(run(ws, "--json").stdout)
        self.assertEqual(rep["iterations"], 1, "vacuity: no record was read")
        self.assertEqual(rep["measured_iterations"], 0)
        self.assertEqual(rep["unmeasured_iterations"], 1)
        self.assertIsNone(rep["total_tokens"])
        self.assertIsNone(rep["mean_tokens_per_measured_iteration"])

    def test_nothing_measured_still_exits_zero_and_says_unknown(self):
        """Records present but none measured is a real answer: UNKNOWN.

        Distinct from exit 3 (nothing there at all). Collapsing them hides
        precisely the case this tool exists to surface.
        """
        ws = workspace(iterations={1: dict(COST_ONLY)})
        r = run(ws)
        self.assertEqual(r.returncode, 0)
        self.assertIn("UNKNOWN", r.stdout)
        self.assertNotIn("total tokens       0", r.stdout)


class CorruptRecordsAreCountedNotDropped(unittest.TestCase):
    def test_an_unreadable_iteration_file_is_an_unmeasured_iteration(self):
        ws = workspace(iterations={1: dict(MEASURED), 2: None})
        rep = json.loads(run(ws, "--json").stdout)
        self.assertEqual(rep["iterations"], 2,
                         "the corrupt record was dropped, so the report claims "
                         "a run shorter than the one that happened")
        self.assertEqual(rep["unmeasured_iterations"], 1)

    def test_corrupt_event_lines_are_counted(self):
        ws = workspace(iterations={1: dict(MEASURED)},
                       events=stage_line("test_suite") + "{not json\n" + "7\n")
        rep = json.loads(run(ws, "--json").stdout)
        self.assertEqual(rep["corrupt_lines"], 2)


class TheSplitIsRefusedRatherThanInvented(unittest.TestCase):
    """No artifact attributes a token to a stage, so no share is reported."""

    def setUp(self):
        self.ws = workspace(
            iterations={1: dict(MEASURED)},
            events=(stage_line("agent") + stage_line("code_review")
                    + stage_line("test_suite") + stage_line("static_analysis")))
        self.rep = json.loads(run(self.ws, "--json").stdout)

    def test_the_stage_scan_is_not_vacuous(self):
        self.assertEqual(self.rep["build_stage_executions"], 1)
        self.assertEqual(self.rep["verification_stage_executions"], 3)

    def test_no_share_is_reported_and_the_refusal_is_explained(self):
        for key in ("verification_tokens", "build_tokens",
                    "verification_token_share"):
            self.assertIsNone(self.rep[key],
                              "%s carries a number, but nothing this repo "
                              "writes records it" % key)
        self.assertIn("REFUSED", self.rep["verification_token_share_why"])
        self.assertIn("wall clock",
                      self.rep["verification_token_share_why"].lower())

    def test_the_upper_bound_is_labelled_as_one(self):
        # 5600 measured tokens over 3 verification executions.
        self.assertAlmostEqual(
            self.rep["tokens_per_verification_execution_upper_bound"],
            5600 / 3, places=1)
        self.assertIn("UPPER BOUND ONLY", run(self.ws).stdout)

    def test_the_agent_stage_is_classified_as_build_not_verification(self):
        self.assertIn("agent", self.rep["build_stages"])
        self.assertNotIn("agent", self.rep["verification_stages"])


class ItIsAReporterNotAGate(unittest.TestCase):
    """A BLOCKED tree still exits 0. The question asked was "what did it cost"."""

    def test_a_blocked_workspace_still_exits_zero(self):
        blocked = json.dumps({
            "type": "stage_complete",
            "data": {"stage": "code_review", "status": "BLOCKED",
                     "duration_s": 9.0, "iteration": 1},
        }) + "\n"
        ws = workspace(iterations={1: dict(MEASURED)}, events=blocked)
        os.makedirs(os.path.join(ws, ".loki", "signals"), exist_ok=True)
        with open(os.path.join(ws, ".loki", "verdict.json"), "w") as fh:
            json.dump({"verdict": "BLOCKED"}, fh)
        r = run(ws)
        self.assertEqual(
            r.returncode, 0,
            "a reporter that fails on a BLOCKED tree is a gate, and CI would "
            "start branching on a number that is not a verdict")
        self.assertIn("code_review", r.stdout)


class ExitCodes(unittest.TestCase):
    def test_usage_error_is_64(self):
        self.assertEqual(run("--zzz-not-a-flag").returncode, 64)

    def test_missing_input_path_is_66(self):
        self.assertEqual(run("/nonexistent/definitely/not/here").returncode, 66)

    def test_help_is_zero_and_carries_no_verdict(self):
        r = run("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("TOKEN TAX", r.stdout)
        self.assertNotIn("UNKNOWN", r.stdout)

    def test_empty_input_is_3(self):
        ws = tempfile.mkdtemp(prefix="tokentax-empty-")
        os.makedirs(os.path.join(ws, ".loki"))
        self.assertEqual(run(ws).returncode, 3)

    def test_a_path_that_exists_but_has_no_loki_is_3(self):
        ws = tempfile.mkdtemp(prefix="tokentax-bare-")
        self.assertEqual(run(ws).returncode, 3)


if __name__ == "__main__":
    unittest.main()
