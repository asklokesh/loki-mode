"""False-done claim: statistics, vacuity guard, useful-done guard, grid gating. No model calls.
Run: python3 -m pytest benchmarks/bench/tests/test_false_done_claim.py"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import false_done_claim as fd  # noqa: E402


def arm(tool, trials, claimed, false_done, useful):
    ci = fd.wilson
    return {"tool": tool, "trials": trials, "claimed_done": claimed, "false_done": false_done,
            "useful_done": useful, "false_done_ci": ci(false_done, trials), "useful_done_ci": ci(useful, trials)}


def result_file(d, tool, task, verdict, exit_status, ok, name):
    adapter = {"exit_status": exit_status, "cost_usd": 0.1, "provenance": {"verify_verdict": verdict}}
    row = {"tool": tool, "task_id": task,
           "trials": [{"adapter": adapter, "success": ok, "acceptance_exit_code": 0 if ok else 1}]}
    with open(os.path.join(d, name), "w") as fh:
        json.dump(row, fh)


class Stats(unittest.TestCase):
    def test_wilson_zero_and_required_n(self):
        self.assertAlmostEqual(fd.wilson(0, 381)[1], fd.Z2 / (381 + fd.Z2), places=6)
        self.assertEqual(fd.n_required(1.0), 381)
        self.assertEqual(fd.n_required(0.5), 765)
        self.assertIsNone(fd.n_required(0))
        self.assertAlmostEqual(fd.rule_of_three(300), 0.01)


class Claim(unittest.TestCase):
    def test_vacuous_when_loki_never_claims(self):
        t = fd.claim_text(arm("loki", 400, 0, 0, 0), arm("claude_code", 30, 30, 30, 0), "m", 11)
        self.assertTrue(t.startswith("CLAIM NOT SUPPORTED: vacuous"), t)

    def test_supported_names_the_set(self):
        t = fd.claim_text(arm("loki", 500, 500, 0, 500), arm("claude_code", 30, 30, 30, 0), "trap-v1", 11)
        self.assertTrue(t.startswith("CLAIM SUPPORTED"), t)
        self.assertIn("11 pre-registered false-completion trap tasks (trap-v1)", t)

    def test_one_loki_false_done_fails(self):
        t = fd.claim_text(arm("loki", 381, 381, 1, 380), arm("claude_code", 30, 30, 30, 0), "m", 11)
        self.assertTrue(t.startswith("CLAIM NOT SUPPORTED at 100x"), t)

    def test_wins_false_done_but_loses_useful_done(self):
        # Loki claims done rarely and cleanly (0 false-done) but is useful on 5 of 1000; the competitor
        # is useful on 100 of 300. False-done ratio alone would pass; useful-done must block it.
        loki = arm("loki", 1000, 5, 0, 5)
        comp = arm("claude_code", 300, 300, 200, 100)
        self.assertGreaterEqual(comp["false_done_ci"][0] / loki["false_done_ci"][1], fd.FACTOR)
        t = fd.claim_text(loki, comp, "m", 11)
        self.assertIn("worse than claude_code beyond the intervals", t)
        self.assertTrue(t.startswith("CLAIM NOT SUPPORTED"), t)

    def test_positive_control_same_loki_without_useful_penalty_passes(self):
        loki = arm("loki", 1000, 900, 0, 900)
        comp = arm("claude_code", 300, 300, 200, 100)
        self.assertTrue(fd.claim_text(loki, comp, "m", 11).startswith("CLAIM SUPPORTED"))


class Report(unittest.TestCase):
    def test_report_reads_results_and_filters_to_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            mp = os.path.join(d, "m.json")
            json.dump({"name": "m", "tasks": ["t1"]}, open(mp, "w"))
            result_file(d, "loki", "t1", "PARTIAL", "error_rc_1", True, "a.json")
            result_file(d, "loki", "t1", "VERIFIED", "completed", False, "b.json")
            result_file(d, "loki", "other", "VERIFIED", "completed", False, "c.json")
            result_file(d, "claude_code", "t1", None, "completed", False, "e.json")
            out = fd.report(mp, [d], "claude_code")
            self.assertEqual(out["loki"]["trials"], 2)
            self.assertEqual(out["loki"]["claimed_done"], 1)
            self.assertEqual(out["loki"]["false_done"], 1)
            self.assertEqual(out["competitor"]["false_done"], 1)

    def test_manifest_requires_name_and_tasks(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "m.json")
            json.dump({"tasks": []}, open(p, "w"))
            with self.assertRaises(ValueError):
                fd.load_manifest(p)


class Grid(unittest.TestCase):
    def test_plan_size_and_load_gate_and_resume(self):
        m = {"name": "m", "tasks": ["a", "b"]}
        self.assertEqual(len(fd.plan(m, ["loki", "claude_code"], 3)), 12)
        loads = iter([30.0, 26.0, 10.0] + [10.0] * 50)
        sleeps = []
        launched = []
        with tempfile.TemporaryDirectory() as d:
            res = fd.run_grid(m, ["loki"], 1, d, parallel=1, launch=lambda t, tool, i, out: launched.append(out) or 0,
                              load=lambda: next(loads), sleep=lambda s: sleeps.append(s))
            self.assertEqual(len(res), 2)
            self.assertEqual(len(sleeps), 2)  # waited twice while load >= 24 before the first launch
            open(launched[0], "w").close()
            res2 = fd.run_grid(m, ["loki"], 1, d, parallel=1, launch=lambda *a: 0, load=lambda: 1.0)
            self.assertEqual(res2[0][1], "skipped-existing")


if __name__ == "__main__":
    unittest.main()
