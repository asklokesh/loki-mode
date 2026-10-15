"""Attribution benchmark: metrics math, dry-run, and task-set integrity.
No model call is made anywhere in this file.
Run: python3 benchmarks/bench/tests/test_attribution.py"""
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import attribution as A  # noqa: E402


def row(arm="loki", accepted=False, reported=False, status="completed",
        cost=None, elapsed=10.0, klass="bugfix"):
    return {"task": "t", "class": klass, "arm": arm, "repeat": 1,
            "accepted": accepted, "reported_success": reported,
            "status": status, "cost_usd": cost, "elapsed_s": elapsed}


class MetricsTest(unittest.TestCase):
    def test_rates_keep_failures_in_denominator(self):
        rows = [row(accepted=True, reported=True, cost=1.0),
                row(accepted=False, reported=True, cost=1.0),
                row(accepted=False, reported=False, status="timeout", cost=1.0),
                row(accepted=False, reported=False, status="error_rc_1", cost=1.0)]
        m = A.compute_metrics(rows)
        self.assertEqual(m["assigned"], 4)
        self.assertEqual(m["acceptance_rate"], 0.25)
        self.assertEqual(m["false_completion_rate"], 0.5)
        self.assertEqual(m["completion_rate"], 0.5)
        self.assertEqual((m["timeouts"], m["errors"]), (1, 1))

    def test_cost_counts_all_attempts(self):
        rows = [row(accepted=True, reported=True, cost=1.0),
                row(accepted=False, reported=True, cost=3.0)]
        m = A.compute_metrics(rows)
        self.assertEqual(m["cost_status"], "measured")
        self.assertEqual(m["cost_per_accepted_usd"], 4.0)

    def test_cost_undefined_when_none_accepted(self):
        m = A.compute_metrics([row(cost=2.0), row(cost=2.0)])
        self.assertEqual(m["cost_status"], "undefined_no_accepted")
        self.assertIsNone(m["cost_per_accepted_usd"])
        self.assertIsNone(m["cost_per_accepted_lower_bound_usd"])

    def test_unmeasured_cost_is_not_zero(self):
        m = A.compute_metrics([row(accepted=True, reported=True, cost=None)])
        self.assertEqual(m["cost_status"], "unmeasured")
        self.assertIsNone(m["cost_per_accepted_usd"])
        self.assertIsNone(m["spend_measured_usd"])

    def test_partial_cost_is_lower_bound_only(self):
        m = A.compute_metrics([row(accepted=True, reported=True, cost=2.0),
                               row(accepted=True, reported=True, cost=None)])
        self.assertEqual(m["cost_status"], "partial_lower_bound")
        self.assertIsNone(m["cost_per_accepted_usd"])
        self.assertEqual(m["cost_per_accepted_lower_bound_usd"], 1.0)
        self.assertEqual(m["runs_with_unmeasured_cost"], 1)

    def test_false_completion_undefined_without_reported_success(self):
        m = A.compute_metrics([row(), row()])
        self.assertIsNone(m["false_completion_rate"])

    def test_elapsed_median_over_accepted_only(self):
        rows = [row(accepted=True, reported=True, elapsed=10.0),
                row(accepted=True, reported=True, elapsed=30.0),
                row(accepted=False, status="timeout", elapsed=900.0)]
        m = A.compute_metrics(rows)
        self.assertEqual(m["elapsed_median_accepted_s"], 20.0)
        self.assertEqual(m["elapsed_median_all_s"], 30.0)

    def test_empty(self):
        m = A.compute_metrics([])
        self.assertIsNone(m["acceptance_rate"])
        self.assertEqual(m["cost_status"], "no_runs")

    def test_wilson(self):
        lo, hi = A.wilson_interval(5, 10)
        self.assertTrue(0.23 < lo < 0.25 and 0.75 < hi < 0.77, (lo, hi))
        self.assertIsNone(A.wilson_interval(0, 0))

    def test_summarize_and_markdown(self):
        rows = [row(arm="raw_claude", accepted=True, reported=True, cost=1.0),
                row(arm="loki", accepted=False, reported=True, cost=None)]
        s = A.summarize(rows)
        self.assertEqual(s["by_arm"]["raw_claude"]["acceptance_rate"], 1.0)
        self.assertEqual(s["by_arm"]["loki"]["false_completion_rate"], 1.0)
        plan = A.build_plan([], 1, "m", 1.0, 5)
        md = A.render_markdown({"generated_utc": "x", "plan": plan,
                                "environment": {}, "rows": rows, "summary": s})
        self.assertIn("unmeasured", md)
        self.assertIn("Task-level results", md)


class PlanTest(unittest.TestCase):
    def test_arm_order_alternates(self):
        self.assertEqual(A.arm_order(0, 0), ["raw_claude", "loki"])
        self.assertEqual(A.arm_order(1, 0), ["loki", "raw_claude"])
        self.assertEqual(A.arm_order(0, 1), ["loki", "raw_claude"])

    def test_dry_run_no_model_call(self):
        def boom(*a, **k):
            raise AssertionError("model-backed call during dry run")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = A.main(["--dry-run", "--repeats", "2"], runner=boom)
        text = out.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("DRY RUN", text)
        self.assertIn("24 model-backed runs", text)
        self.assertIn("not probed", text)

    def test_default_without_execute_is_plan_only(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = A.main([], runner=lambda *a, **k: 1 / 0)
        self.assertEqual(rc, 0)
        self.assertIn("--execute", out.getvalue())

    def test_dry_run_rejects_bad_task_set(self):
        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            os.makedirs(os.path.join(d, "x"))
            with open(os.path.join(d, "x", "task.json"), "w") as fh:
                fh.write('{"id": "x"}')
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                rc = A.main(["--dry-run", "--tasks-dir", d])
            self.assertEqual(rc, 2)
            self.assertIn("missing field", err.getvalue())
        finally:
            shutil.rmtree(d, ignore_errors=True)


class LokiModelPinTest(unittest.TestCase):
    def test_loki_arm_sees_pinned_model_despite_parent_env(self):
        seen = {}

        def fake(cmd, **kw):
            seen["env"] = dict(kw.get("env") or os.environ)
            seen["parent"] = os.environ.get("LOKI_SESSION_MODEL")
            return subprocess.CompletedProcess(cmd, 0, "", "")

        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        old = os.environ.get("LOKI_SESSION_MODEL")
        os.environ["LOKI_SESSION_MODEL"] = "haiku"
        try:
            pf = os.path.join(d, "p.md")
            open(pf, "w").write("x")
            try:
                A.run_loki(d, pf, model="claude-sonnet-5", budget_usd=1.0,
                           timeout_s=5, runner=fake)
            except Exception:
                pass
            self.assertEqual(seen["env"].get("LOKI_SESSION_MODEL"), "claude-sonnet-5")
            self.assertEqual(os.environ.get("LOKI_SESSION_MODEL"), "haiku")
        finally:
            if old is None:
                os.environ.pop("LOKI_SESSION_MODEL", None)
            else:
                os.environ["LOKI_SESSION_MODEL"] = old
            shutil.rmtree(d, ignore_errors=True)

    def test_pinned_environment_records_effective_model(self):
        env = A.pin_environment(False, model="claude-sonnet-5")
        self.assertEqual(env["loki_session_model_effective"], "claude-sonnet-5")


class TaskSetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tasks, cls.errors, cls.warnings = A.load_tasks(A.DEFAULT_TASKS_DIR)

    def test_pilot_set_valid_and_mixed(self):
        self.assertEqual(self.errors, [])
        self.assertEqual(self.warnings, [])
        mix = {}
        for t in self.tasks:
            mix[t["class"]] = mix.get(t["class"], 0) + 1
        self.assertEqual(mix, A.PILOT_MIX)

    def _accept(self, task, overlay_dir):
        wd = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            shutil.copytree(task["seed_dir"], wd, dirs_exist_ok=True)
            if overlay_dir:
                shutil.copytree(overlay_dir, wd, dirs_exist_ok=True)
            return A.grade(task, wd)["passed"]
        finally:
            shutil.rmtree(wd, ignore_errors=True)

    def test_acceptance_fails_on_seed_passes_on_reference(self):
        for t in self.tasks:
            self.assertFalse(self._accept(t, None), "%s passes unmodified seed" % t["id"])
            self.assertTrue(self._accept(t, t["reference_dir"]),
                            "%s fails reference solution" % t["id"])

    def test_acceptance_not_visible_before_grading(self):
        for t in self.tasks:
            wd = tempfile.mkdtemp(prefix="loki-attr-test-")
            try:
                A.materialize_seed(t, wd)
                self.assertFalse(os.path.exists(os.path.join(wd, "acceptance_test.py")))
                head = subprocess.run(["git", "-C", wd, "log", "--oneline"],
                                      capture_output=True, text=True).stdout
                self.assertIn("seed", head)
            finally:
                shutil.rmtree(wd, ignore_errors=True)

    def test_grader_overwrites_tampered_acceptance_support_file(self):
        t = [x for x in self.tasks if x["id"] == "integration-1-retry-client"][0]
        wd = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            shutil.copytree(t["seed_dir"], wd, dirs_exist_ok=True)
            shutil.copytree(t["reference_dir"], wd, dirs_exist_ok=True)
            with open(os.path.join(wd, "service.py"), "w") as fh:
                fh.write("raise SystemExit(0)\n")
            self.assertTrue(A.grade(t, wd)["passed"])
        finally:
            shutil.rmtree(wd, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
