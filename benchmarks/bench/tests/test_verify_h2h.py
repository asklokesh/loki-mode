"""Axis C verify latency head to head: correctness gating, controls, spend gate. No model calls.
Run: python3 -m pytest benchmarks/bench/tests/test_verify_h2h.py"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import false_done_claim as fd  # noqa: E402
import verify_h2h as v  # noqa: E402

IDS = {"SD-0001", "SD-0021"}


def run(arm, inputs, tmp):
    return v.run_arm(arm, inputs, 1, v.seeded_manifest(), "m", None, tmp)


class Corpus(unittest.TestCase):
    def test_manifest_loads_like_pd_claim(self):
        m = v.seeded_manifest()
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "m.json")
            with open(p, "w") as fh:
                json.dump({"name": m["name"], "tasks": m["tasks"]}, fh)
            self.assertEqual(len(fd.load_manifest(p)["tasks"]), 100)

    def test_each_case_has_seeded_and_control_with_distinct_truth(self):
        inputs = v.build_inputs(IDS)
        self.assertEqual(len(inputs), 4)
        with tempfile.TemporaryDirectory() as tmp:
            truth = {}
            for did, variant, _, files in inputs:
                root = os.path.join(tmp, did + variant)
                v.materialize(root, files)
                truth[(did, variant)] = v.grade(root)
        for did in IDS:
            self.assertEqual(truth[(did, "seeded")], "FAIL")
            self.assertEqual(truth[(did, "control")], "PASS")


class Gating(unittest.TestCase):
    def setUp(self):
        self.inputs = v.build_inputs(IDS)

    def test_stub_pass_misses_every_defect(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = v.summarize(run("stub-pass", self.inputs, tmp))
        self.assertEqual((s["caught"], s["false_alarms"]), (0, 0))
        self.assertIsNone(s["median_ms_correct_only"])
        self.assertIn("no headline latency", s["latency_note"])
        self.assertIsNotNone(s["median_ms_all_rows_informational"])

    def test_stub_fail_catches_all_but_false_alarms_every_control(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = v.summarize(run("stub-fail", self.inputs, tmp))
        self.assertEqual((s["caught"], s["false_alarms"]), (2, 2))
        self.assertEqual(s["false_alarm_rate"], 1.0)
        self.assertIsNone(s["median_ms_correct_only"])

    def test_visible_suite_passes_seeded_cases_so_catches_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = run("visible", self.inputs, tmp)
        self.assertEqual(v.summarize(rows)["caught"], 0)
        self.assertTrue(all(r["correct"] == (r["grader_verdict"] == "PASS") for r in rows))

    def test_rows_follow_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = run("stub-pass", self.inputs, tmp)[0]
        for k in ("axis", "tool", "tool_version", "model", "task_id", "task_hash", "trial", "value", "unit",
                  "correct", "grader_verdict", "provenance", "spend_usd", "manifest"):
            self.assertIn(k, r)
        self.assertEqual((r["axis"], r["unit"]), ("C", "ms"))

    def test_latency_uses_correct_rows_only(self):
        rows = [{"tool": "t", "grader_verdict": "FAIL", "correct": True, "value": 10.0, "spend_usd": 0},
                {"tool": "t", "grader_verdict": "FAIL", "correct": False, "value": 1.0, "spend_usd": 0},
                {"tool": "t", "grader_verdict": "PASS", "correct": True, "value": 30.0, "spend_usd": 0}]
        self.assertEqual(v.summarize(rows)["median_ms_correct_only"], 20.0)

    def test_review_parser(self):
        self.assertEqual(v._parse_review("**FAIL**\nbecause"), "FAIL")
        self.assertEqual(v._parse_review("PASS."), "PASS")
        self.assertEqual(v._parse_review("maybe"), "INCONCLUSIVE")


class Cli(unittest.TestCase):
    def test_paid_arm_refused_without_spend_approval(self):
        old = os.environ.pop("LOKI_BENCH_SPEND_APPROVED", None)
        try:
            self.assertEqual(v.main(["--arms", "claude-review", "--out", tempfile.gettempdir()]), 2)
        finally:
            if old is not None:
                os.environ["LOKI_BENCH_SPEND_APPROVED"] = old

    def test_unknown_arm_rejected(self):
        self.assertEqual(v.main(["--arms", "nope", "--out", tempfile.gettempdir()]), 64)

    def test_stratified_sample_is_per_category(self):
        m = v.seeded_manifest()
        self.assertEqual(len(v.stratified_sample(m, 4)), 20)


if __name__ == "__main__":
    unittest.main()
