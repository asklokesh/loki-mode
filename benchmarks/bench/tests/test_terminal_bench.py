"""Terminal-Bench adapter: record format, dry run with a stub provider only.
Run: python3 -m pytest benchmarks/bench/tests -k terminal_bench"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from adapters import terminal_bench as tb  # noqa: E402
from adapters import loki  # noqa: E402

TASKS = [{"id": "local-a", "instruction": "make a"},
         {"id": "local-b", "instruction": "make b"}]


def stub_runner(cost):
    """Stub provider: no CLI, no model call. Writes the efficiency record the
    real run would, then reports a clean exit."""
    def runner(cmd, cwd=None, **kw):
        if "version" in cmd:
            return subprocess.CompletedProcess(
                cmd, 0, "Loki Mode v%s\n" % loki.repo_version(), "")
        eff = os.path.join(cwd, ".loki", "metrics", "efficiency")
        os.makedirs(eff, exist_ok=True)
        if cost is not None:
            with open(os.path.join(eff, "iteration-1.json"), "w") as fh:
                json.dump({"cost_usd": cost, "input_tokens": 100,
                           "output_tokens": 50, "model": "stub-model"}, fh)
        return subprocess.CompletedProcess(cmd, 0, "ok", "")
    return runner


class TerminalBenchTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="loki-tb-test-")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _run(self, cost, cap=10.0, trials=2):
        agent = tb.LokiHarborAgent(model="stub-model", cost_cap_usd=cap,
                                   runner=stub_runner(cost))
        out = os.path.join(self.d, "trials.jsonl")
        return tb.run_trials(agent, TASKS, trials, self.d, out), out

    def test_record_format_and_counts(self):
        recs, out = self._run(0.5)
        self.assertEqual(len(recs), 4)  # 2 tasks x 2 trials
        for r in recs:
            self.assertEqual(sorted(r), sorted(tb.RECORD_KEYS))
            self.assertEqual(r["schema"], tb.RECORD_SCHEMA)
            self.assertEqual(r["agent"], "loki")
            self.assertEqual(r["agent_version"], loki.repo_version())
            self.assertEqual(r["model"], "stub-model")
            self.assertAlmostEqual(r["cost_usd"], 0.5)
            self.assertFalse(r["cap_exceeded"])
        self.assertEqual(sorted({(r["task_id"], r["trial"]) for r in recs}),
                         [("local-a", 1), ("local-a", 2),
                          ("local-b", 1), ("local-b", 2)])
        with open(out) as fh:
            self.assertEqual(len(fh.read().splitlines()), 4)

    def test_no_success_field(self):
        recs, _ = self._run(0.5, trials=1)
        for k in ("success", "passed", "score", "verdict", "quality"):
            self.assertNotIn(k, recs[0])

    def test_unmeasured_cost_is_null_not_zero(self):
        recs, _ = self._run(None, trials=1)
        self.assertIsNone(recs[0]["cost_usd"])
        self.assertFalse(recs[0]["cap_exceeded"])

    def test_cap_exceeded_flag(self):
        recs, _ = self._run(12.0, cap=10.0, trials=1)
        self.assertTrue(recs[0]["cap_exceeded"])

    def test_paid_run_refused_without_approval(self):
        old = os.environ.pop("LOKI_BENCH_SPEND_APPROVED", None)
        try:
            with self.assertRaises(tb.SpendNotApproved):
                tb.LokiHarborAgent().run("x", self.d, task_id="t")
        finally:
            if old is not None:
                os.environ["LOKI_BENCH_SPEND_APPROVED"] = old

    def test_forecast(self):
        f = tb.forecast(89, 5, expected_usd=3.0, cap_usd=10.0)
        self.assertEqual(f["n_trials"], 445)
        self.assertEqual(f["ceiling_usd"], 4450.0)
        self.assertEqual(f["expected_usd"], 1335.0)
        self.assertIsNone(tb.forecast(2, 5)["expected_usd"])


if __name__ == "__main__":
    unittest.main()
