"""tests/test_bench_report.py -- R2 benchmark report behavior.

CRITICAL credibility tests:
  - A fixture where Loki LOSES must render the COMPETITOR as winner. This
    proves the report is non-rigged by construction (winner = grader data,
    no Loki-favoring formatting).
  - The methodology + disclaimers section is ALWAYS present.
  - Manual rows are tagged unverified and EXCLUDED from the winner.
  - A null cost renders "not recorded", NEVER "$0.00".

Success in the fixtures comes from trials[].success, which the GRADER sets.
The report only consumes it.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPORT_PATH = os.path.join(_REPO, "benchmarks", "bench", "report.py")

_spec = importlib.util.spec_from_file_location("bench_report", _REPORT_PATH)
report = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(report)


def _trials(success_list, cost=None, dur=10.0):
    return [
        {"success": s, "quality": (0.9 if s else 0.1),
         "cost_usd": cost, "duration_s": dur, "iterations": 3}
        for s in success_list
    ]


class TestWinnerIsDataDriven(unittest.TestCase):
    def test_loki_loses_renders_competitor_winner(self):
        """THE non-rigged proof: aider beats loki on grader success-rate ->
        the report must name aider the winner."""
        result_row = {
            "suite": "swe-bench-verified-subset",
            "rows": [
                {"tool": "loki", "model_used": "claude-opus-4",
                 "provenance": {"kind": "automated", "verified": True},
                 # loki: 1 of 3 success
                 "trials": _trials([True, False, False], cost=0.5)},
                {"tool": "aider", "model_used": "gpt-5",
                 "provenance": {"kind": "automated", "verified": True},
                 # aider: 3 of 3 success -> should WIN
                 "trials": _trials([True, True, True], cost=0.3)},
            ],
        }
        results = report.build_report(result_row)
        self.assertEqual(results["winner"], "aider",
                         "competitor with higher grader success-rate must win")
        md = report.render_markdown(results)
        self.assertIn("Winner: aider", md)
        self.assertNotIn("Winner: loki", md)

    def test_loki_wins_when_data_says_so(self):
        result_row = {
            "suite": "x",
            "rows": [
                {"tool": "loki", "provenance": {"kind": "automated", "verified": True},
                 "trials": _trials([True, True, True])},
                {"tool": "aider", "provenance": {"kind": "automated", "verified": True},
                 "trials": _trials([True, False, False])},
            ],
        }
        results = report.build_report(result_row)
        self.assertEqual(results["winner"], "loki")

    def test_tie_yields_no_winner(self):
        result_row = {
            "suite": "x",
            "rows": [
                {"tool": "loki", "provenance": {"kind": "automated", "verified": True},
                 "trials": _trials([True, True, False])},
                {"tool": "aider", "provenance": {"kind": "automated", "verified": True},
                 "trials": _trials([True, True, False])},
            ],
        }
        results = report.build_report(result_row)
        self.assertIsNone(results["winner"])
        self.assertIn("tie", results["winner_reason"].lower())


class TestManualRowsExcluded(unittest.TestCase):
    def test_manual_unverified_never_wins(self):
        """A manual entry with a perfect record must NOT beat a verified tool."""
        result_row = {
            "suite": "x",
            "rows": [
                {"tool": "loki", "provenance": {"kind": "automated", "verified": True},
                 "trials": _trials([True, False, False])},
                {"tool": "devin",
                 "provenance": {"kind": "manual", "verified": False,
                                "operator": "a", "date": "2026-05-29",
                                "tool_version": "v1", "run_link": "http://x"},
                 "trials": _trials([True, True, True])},
            ],
        }
        results = report.build_report(result_row)
        # devin has higher rate but is manual -> excluded; loki is the only
        # eligible tool, so loki wins (or no winner if none eligible).
        self.assertNotEqual(results["winner"], "devin")
        md = report.render_markdown(results)
        self.assertIn("unverified", md.lower())

    def test_real_runner_shape_manual_does_not_win(self):
        """REAL runner shape: provenance lives under trials[].adapter.provenance,
        NOT at row level. A manual competitor with a HIGHER grader success-rate
        must STILL be excluded (tagged unverified) and must NOT win; the lower-
        scoring but VERIFIED loki is the winner.

        This is the regression that the row-level-only _is_manual() missed: on
        real runner output it returned False, so the unverified row was treated
        as measured and could win the leaderboard."""
        def _real_trials(success_list, prov, cost=0.4):
            # Mirrors runner.run_trial: success/quality at trial level, but
            # provenance nested under adapter (the real per-tool result-row).
            return [
                {"trial": i + 1, "success": s,
                 "quality": {"lint_ok": s, "tests_ok": s},
                 "acceptance_exit_code": 0 if s else 1,
                 "adapter": {"tool": prov.get("_tool", "x"),
                             "tool_version": "1.0",
                             "model_used": "m",
                             "duration_s": 10.0,
                             "iterations": 3,
                             "exit_status": "completed",
                             "provenance": prov},
                 "cost_usd": cost, "duration_s": 10.0}
                for i, s in enumerate(success_list)
            ]

        # Two per-tool runner result-rows merged into one leaderboard (the list
        # input shape `loki bench report a.json b.json` produces). NO row-level
        # provenance anywhere: derivation MUST come from trials[].adapter.
        loki_row = {
            "schema_version": "1.0", "task_id": "t", "tool": "loki",
            "model": "claude-opus-4",
            "trials": _real_trials(
                [True, False, False],
                {"_tool": "loki", "kind": "automated", "verified": True}),
        }
        devin_row = {
            "schema_version": "1.0", "task_id": "t", "tool": "devin",
            "model": "n/a",
            # 3 of 3 success -- HIGHER than loki -- but manual/unverified.
            "trials": _real_trials(
                [True, True, True],
                {"_tool": "devin", "kind": "manual", "verified": False,
                 "operator": "a", "date": "2026-06-03",
                 "tool_version": "v1", "run_link": "http://x"}),
        }
        results = report.build_report([loki_row, devin_row])
        # The high-scoring MANUAL row must NOT win.
        self.assertNotEqual(results["winner"], "devin",
                            "manual row under trials[].adapter must be excluded")
        # The lower-scoring VERIFIED tool wins precisely because the higher one
        # is excluded -- the strongest proof of the invariant.
        self.assertEqual(results["winner"], "loki")
        md = report.render_markdown(results)
        self.assertIn("unverified", md.lower())
        self.assertIn("Winner: loki", md)
        # And the devin row is tagged manual (unverified) in the table.
        devin_summary = next(s for s in results["summaries"]
                             if s["tool"] == "devin")
        self.assertTrue(devin_summary["manual"])
        self.assertEqual(devin_summary["provenance_tag"], "manual (unverified)")

    def test_manual_row_tagged(self):
        result_row = {
            "suite": "x",
            "rows": [
                {"tool": "devin",
                 "provenance": {"kind": "manual", "verified": False,
                                "operator": "a", "date": "d", "tool_version": "v",
                                "run_link": "http://x"},
                 "trials": _trials([True])},
            ],
        }
        results = report.build_report(result_row)
        md = report.render_markdown(results)
        self.assertIn("manual (unverified)", md)


class TestCostFormatting(unittest.TestCase):
    def test_null_cost_renders_not_recorded(self):
        result_row = {
            "suite": "x",
            "rows": [
                {"tool": "loki", "provenance": {"kind": "automated", "verified": True},
                 "trials": _trials([True, True], cost=None)},
            ],
        }
        results = report.build_report(result_row)
        md = report.render_markdown(results)
        # Check the TABLE region (above the methodology section, which itself
        # mentions the literal "$0.00" as the anti-pattern to avoid).
        table = md.split("## Methodology", 1)[0]
        self.assertIn("not recorded", table)
        self.assertNotIn("$0.00", table)

    def test_fmt_usd_helpers(self):
        self.assertEqual(report.fmt_usd(None), "not recorded")
        self.assertEqual(report.fmt_usd(0.0), "$0.00")  # genuine zero is fine
        self.assertEqual(report.fmt_usd(0.5), "$0.50")
        self.assertEqual(report.fmt_usd(1.2345), "$1.2345")


class TestMethodologyAlwaysPresent(unittest.TestCase):
    def test_methodology_section_in_markdown(self):
        result_row = {"suite": "x", "rows": []}
        results = report.build_report(result_row)
        md = report.render_markdown(results)
        self.assertIn("Methodology and disclaimers", md)
        # Key disclaimers must appear (single-line needles; the prose is
        # hard-wrapped so multi-word phrases may straddle a newline).
        low = md.lower()
        for needle in ("read-only", "never grades", "reproduce",
                       "contamination", "held-out"):
            self.assertIn(needle, low)

    def test_generate_writes_both_files(self):
        result_row = {
            "suite": "x",
            "rows": [
                {"tool": "loki", "provenance": {"kind": "automated", "verified": True},
                 "trials": _trials([True])},
            ],
        }
        with tempfile.TemporaryDirectory() as d:
            rp, mp = report.generate(result_row, d)
            self.assertTrue(os.path.isfile(rp))
            self.assertTrue(os.path.isfile(mp))
            with open(mp) as fh:
                self.assertIn("Methodology and disclaimers", fh.read())


if __name__ == "__main__":
    unittest.main()
