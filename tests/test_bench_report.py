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


def _arm_row(tool, task, accepted_flags, cost=1.0, dur=100.0, files=1, partial=False,
             outcome="VERIFIED", exit_status="completed"):
    trials = []
    for ok in accepted_flags:
        ad = {"tool": tool, "exit_status": exit_status, "files_changed": files, "tool_version": "v-" + tool}
        prov = {}
        if tool.startswith("loki"):
            prov["run_outcome"] = outcome
        if partial:
            prov["cost_partial"] = True
        ad["provenance"] = prov
        trials.append({"success": ok, "cost_usd": cost, "duration_s": dur, "measured": True, "adapter": ad})
    return {"tool": tool, "task_id": task, "trials": trials}


class TestArmComparison(unittest.TestCase):
    def _rows(self):
        # raw solves a 3/3, b 2/3, c 0/3, d 1/3; lean solves a 1/3 (solid loss), b 3/3, c 0/3, d 3/3.
        return [
            _arm_row("claude_code", "a", [True] * 3, cost=1.0, dur=100.0),
            _arm_row("claude_code", "b", [True, True, False], cost=1.0, dur=100.0),
            _arm_row("claude_code", "c", [False] * 3, cost=1.0, dur=100.0),
            _arm_row("claude_code", "d", [True, False, False], cost=1.0, dur=100.0),
            _arm_row("loki-lean", "d", [True] * 3, cost=0.4, dur=40.0),
            _arm_row("loki-lean", "a", [True, False, False], cost=0.4, dur=40.0),
            _arm_row("loki-lean", "b", [True] * 3, cost=0.4, dur=40.0),
            _arm_row("loki-lean", "c", [False] * 3, cost=0.4, dur=40.0),
        ]

    def test_paired_worse_better_counts(self):
        pair = report.pair_arms(self._rows())
        self.assertEqual((pair["worse"], pair["better"], pair["same"]), (1, 2, 1))
        self.assertEqual(pair["solid_losses"], ["a"])
        out = {t["task_id"]: t["outcome"] for t in pair["tasks"]}
        self.assertEqual(out, {"a": "worse", "b": "better", "c": "same", "d": "better"})

    def test_markdown_reports_the_counts_and_the_pass_rule(self):
        md = report.render_markdown(report.build_report({"rows": self._rows()}))
        self.assertIn("loki-lean did worse than claude_code on 1 tasks, better on 2, the same on 1.", md)
        self.assertIn("| a | 1/3 | 3/3 | worse (solid loss) |", md)
        self.assertIn("Accuracy", md)
        self.assertIn("FAIL", md)

    def test_per_arm_totals_and_false_green(self):
        cmp = report.arm_comparison(self._rows())
        lean, raw = cmp["arms"]
        self.assertEqual((lean["accepted"], raw["accepted"]), (7, 6))
        # every trial exits clean with a diff and a VERIFIED outcome, so every trial is a claim and PR-ready.
        self.assertEqual((lean["claimed"], lean["false_green"], lean["pr_ready"]), (12, 5, 12))
        self.assertEqual((raw["claimed"], raw["false_green"]), (12, 6))
        self.assertEqual(lean["tool_version"], "v-loki-lean")
        self.assertAlmostEqual(cmp["cost_ratio"], 0.4)
        self.assertAlmostEqual(cmp["time_ratio"], 0.4)

    def test_cost_partial_rows_never_enter_a_cost_claim(self):
        rows = self._rows()
        i = [n for n, r in enumerate(rows) if (r["tool"], r["task_id"]) == ("loki-lean", "a")][0]
        rows[i] = _arm_row("loki-lean", "a", [True, False, False], cost=0.01, dur=40.0, partial=True)
        cmp = report.arm_comparison(rows)
        lean = cmp["arms"][0]
        self.assertEqual(lean["cost_partial_n"], 3)
        self.assertEqual(lean["cost_complete_n"], 9)
        task_a = [t for t in cmp["paired"]["tasks"] if t["task_id"] == "a"][0]
        self.assertIsNone(task_a["candidate_cost"])

    def test_zero_accepted_arm_asks_for_a_positive_control(self):
        rows = [_arm_row("claude_code", "a", [False] * 3), _arm_row("loki-lean", "a", [False] * 3)]
        md = report.render_markdown(report.build_report({"rows": rows}))
        self.assertIn("needs a positive control", md)

    def test_partial_with_a_diff_is_pr_ready_for_loki_but_not_raw_errors(self):
        rows = [_arm_row("claude_code", "a", [False] * 3, exit_status="error_rc_1"),
                _arm_row("loki-lean", "a", [False] * 3, outcome="PARTIAL", exit_status="error_rc_6")]
        lean, raw = report.arm_comparison(rows)["arms"]
        self.assertEqual((lean["pr_ready"], raw["pr_ready"]), (3, 0))

    def test_loki_failed_or_empty_diff_is_not_pr_ready(self):
        rows = [_arm_row("claude_code", "a", [True] * 3),
                _arm_row("loki-lean", "a", [False] * 2, outcome="FAILED", exit_status="error_rc_1"),
                _arm_row("loki-lean", "b", [True], outcome="VERIFIED", files=0),
                _arm_row("claude_code", "b", [True])]
        self.assertEqual(report.arm_comparison(rows)["arms"][0]["pr_ready"], 0)

    def test_false_green_compares_counts_not_rates(self):
        # lean: 2 false-green of 6 claims (33%); raw: 1 of 2 claims (50%). Rate is lower, count is higher.
        rows = [_arm_row("claude_code", "a", [True, False]), _arm_row("claude_code", "b", [True, True]),
                _arm_row("loki-lean", "a", [True, False, False]), _arm_row("loki-lean", "b", [True, True, True])]
        rows[1]["trials"] = [dict(t, adapter=dict(t["adapter"], exit_status="error_rc_1")) for t in rows[1]["trials"]]
        cmp = report.arm_comparison(rows)
        self.assertLess(cmp["false_green_rate"]["loki-lean"], cmp["false_green_rate"]["claude_code"])
        self.assertGreater(cmp["arms"][0]["false_green"], cmp["arms"][1]["false_green"])
        self.assertIs(cmp["checks"]["accuracy"], False)

    def _good(self):
        # Every criterion passes: lean accepts as much, costs and takes 0.4x, PR-ready 100%.
        return [_arm_row("claude_code", "a", [True] * 3), _arm_row("loki-lean", "a", [True] * 3, cost=0.4, dur=40.0)]

    def test_good_fixture_passes(self):
        cmp = report.arm_comparison(self._good())
        self.assertIs(cmp["pass"], True)

    def _assert_unknown(self, rows, check):
        cmp = report.arm_comparison(rows)
        self.assertIsNone(cmp["checks"][check])
        self.assertIsNone(cmp["pass"])
        self.assertIn("unknown", report.render_arm_comparison(cmp))

    def test_missing_cost_is_unknown(self):
        rows = self._good()
        for r in rows:
            for t in r["trials"]:
                t["cost_usd"] = None
        self._assert_unknown(rows, "cost_le_half")

    def test_missing_time_is_unknown(self):
        rows = self._good()
        for r in rows:
            for t in r["trials"]:
                t["duration_s"] = None
        self._assert_unknown(rows, "time_le_half")

    def test_no_paired_tasks_is_unknown(self):
        rows = [_arm_row("claude_code", "a", [True] * 3), _arm_row("loki-lean", "b", [True] * 3, cost=0.4, dur=40.0)]
        self._assert_unknown(rows, "accuracy")

    def test_no_raw_claims_is_unknown(self):
        rows = self._good()
        for t in rows[0]["trials"]:
            t["adapter"]["exit_status"] = "error_rc_1"
        self._assert_unknown(rows, "accuracy")

    def test_no_comparison_without_both_arms(self):
        self.assertIsNone(report.build_report({"rows": [_arm_row("claude_code", "a", [True])]}).get("arm_comparison"))


if __name__ == "__main__":
    unittest.main()
