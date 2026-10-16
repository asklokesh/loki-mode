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
        lo, hi = A._wilson_ci95(5, 10)
        self.assertTrue(0.23 < lo < 0.25 and 0.75 < hi < 0.77, (lo, hi))
        self.assertIsNone(A._wilson_ci95(0, 0))

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
        # Shared metric definitions: the report points at the one doc section
        # that also governs `loki trust`, and that section exists.
        self.assertIn("Outcome analytics", md)
        self.assertIn("docs/EVALUATING.md", md)
        doc = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "..", "..", "..", "docs", "EVALUATING.md")
        with open(doc, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("## Outcome analytics", text)
        for term in ("accepted outcome", "misleading completion", "cost per accepted",
                     "waited", "active minutes"):
            self.assertIn(term, text)


class PlanTest(unittest.TestCase):
    def test_arm_order_alternates(self):
        two = ("raw_claude", "loki")
        self.assertEqual(A.arm_order(0, 0, two), ["raw_claude", "loki"])
        self.assertEqual(A.arm_order(1, 0, two), ["loki", "raw_claude"])
        self.assertEqual(A.arm_order(0, 1, two), ["loki", "raw_claude"])
        self.assertEqual(A.arm_order(1, 0), ["loki", "droid", "raw_claude"])

    def test_dry_run_no_model_call(self):
        def boom(*a, **k):
            raise AssertionError("model-backed call during dry run")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = A.main(["--dry-run", "--repeats", "2"], runner=boom)
        text = out.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("DRY RUN", text)
        self.assertIn("32 model-backed runs", text)
        self.assertIn("not probed", text)
        self.assertIn("droid arm: 16 cells", text)
        for tid in ("coord-1-api-web", "longspec-1-three-units"):
            self.assertIn(tid, text)
        for arm in A.ARMS:
            self.assertIn(arm, text)

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


def _fresh_task(tid):
    tasks, _e, _w = A.load_tasks(A.DEFAULT_TASKS_DIR, [tid])
    return tasks[0]


class DroidArmTest(unittest.TestCase):
    def test_unavailable_droid_is_unmeasured_and_never_run(self):
        def boom(*a, **k):
            raise AssertionError("droid ran although unavailable")
        scratch = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            r = A.run_cell(_fresh_task("coord-1-api-web"), "droid", 1, model="m",
                           budget_usd=1.0, timeout_s=5, scratch=scratch, runner=boom,
                           droid_probe={"available": False, "reason": "droid CLI not found on PATH"})
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        self.assertEqual(r["status"], "unmeasured")
        self.assertIsNone(r["cost_usd"])
        self.assertFalse(r["accepted"])
        self.assertIn("not found", r["unmeasured_reason"])

    def test_unprobed_droid_is_unmeasured(self):
        r = A.run_cell(_fresh_task("coord-1-api-web"), "droid", 1, model="m",
                       budget_usd=1.0, timeout_s=5, scratch="/nonexistent",
                       runner=lambda *a, **k: 1 / 0)
        self.assertEqual(r["status"], "unmeasured")

    def test_probe_reports_absent_and_failing(self):
        def missing(cmd, **kw):
            raise FileNotFoundError("droid")

        def failing(cmd, **kw):
            return subprocess.CompletedProcess(cmd, 3, "", "")

        def ok(cmd, **kw):
            self.assertEqual(cmd, ["droid", "exec", "--help"])
            return subprocess.CompletedProcess(cmd, 0, "usage", "")
        self.assertFalse(A.probe_droid(runner=missing)["available"])
        self.assertIn("not found", A.probe_droid(runner=missing)["reason"])
        self.assertIn("exited 3", A.probe_droid(runner=failing)["reason"])
        self.assertTrue(A.probe_droid(runner=ok)["available"])

    def test_unmeasured_arm_has_no_rate_but_stays_in_assigned(self):
        rows = [row(arm="droid", status="unmeasured", cost=None, elapsed=None)
                for _ in range(3)]
        m = A.compute_metrics(rows)
        self.assertEqual(m["assigned"], 3)
        self.assertEqual(m["unmeasured_runs"], 3)
        self.assertIsNone(m["acceptance_rate"])
        self.assertIsNone(m["acceptance_rate_ci95"])
        self.assertEqual(m["errors"], 0)
        self.assertEqual(m["cost_status"], "unmeasured")

    def test_mixed_unmeasured_never_yields_a_rate(self):
        rows = [row(arm="droid", accepted=True, reported=True, cost=None),
                row(arm="droid", status="unmeasured", cost=None, elapsed=None)]
        self.assertIsNone(A.compute_metrics(rows)["acceptance_rate"])

    def test_report_marks_droid_unmeasured(self):
        rows = [row(arm="raw_claude", accepted=True, reported=True, cost=1.0),
                dict(row(arm="droid", status="unmeasured", cost=None, elapsed=None),
                     unmeasured_reason="droid CLI not found on PATH")]
        plan = A.build_plan([], 1, "m", 1.0, 5)
        md = A.render_markdown({"generated_utc": "x", "plan": plan, "environment": {},
                                "rows": rows, "summary": A.summarize(rows)})
        self.assertIn("UNMEASURED (1 of 1 runs not measured)", md)
        self.assertIn("droid CLI not found on PATH", md)

    def test_unmeasured_never_printed_as_zero_or_failure(self):
        rows = [dict(row(arm="raw_claude", accepted=True, reported=True, cost=1.0)),
                dict(row(arm="droid", status="unmeasured", cost=None, elapsed=None),
                     unmeasured_reason="droid CLI not found on PATH")]
        plan = A.build_plan([], 1, "m", 1.0, 5)
        md = A.render_markdown({"generated_utc": "x", "plan": plan, "environment": {},
                                "rows": rows, "summary": A.summarize(rows)})
        droid_lines = [l for l in md.splitlines() if l.startswith("| ") and " droid " in l]
        self.assertTrue(droid_lines)
        for l in droid_lines:
            cells = [c.strip() for c in l.strip("|").split("|")]
            self.assertNotIn("0", cells, l)
            self.assertNotIn("no", cells, l)
        self.assertTrue(any("UNMEASURED | UNMEASURED | UNMEASURED" in l for l in droid_lines))
        self.assertTrue(any("| unmeasured | - | - |" in l for l in droid_lines))

    def test_arms_flag_validation(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = A.main(["--dry-run", "--arms", "raw_claude,nope"])
        self.assertEqual(rc, 2)


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


class LokiLedgerRowTest(unittest.TestCase):
    """S1: the loki row carries true (ledger-summed) cost, phase split, engine and honesty."""

    def _run(self, populate):
        import json as _json

        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        pf = os.path.join(d, "p.md")
        open(pf, "w").write("x")

        def fake(cmd, **kw):
            if cmd[:2] == ["loki", "start"]:
                populate(os.path.join(d, ".loki"), _json)
            return subprocess.CompletedProcess(cmd, 0, "", "")

        try:
            return A.run_loki(d, pf, model="claude-sonnet-5", budget_usd=1.0,
                              timeout_s=5, runner=fake)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    @staticmethod
    def _main(loki, js, usd=0.25):
        eff = os.path.join(loki, "metrics", "efficiency")
        os.makedirs(eff, exist_ok=True)
        with open(os.path.join(eff, "iteration-1.json"), "w") as f:
            js.dump({"iteration": 1, "input_tokens": 10, "output_tokens": 5,
                     "cache_read_tokens": 0, "cache_creation_tokens": 0,
                     "cost_usd": usd, "model": "sonnet"}, f)

    def test_row_cost_is_main_plus_ledger_with_phase_map(self):
        def pop(loki, js):
            self._main(loki, js)
            with open(os.path.join(loki, "metrics", "child-sessions.jsonl"), "w") as f:
                for ph, u in (("reviewer", 0.1), ("grill", 0.05), ("docs", 0.2)):
                    f.write(js.dumps({"phase": ph, "model": "sonnet", "usd": u,
                                      "input_tokens": 1, "output_tokens": 1,
                                      "cache_creation_tokens": 1,
                                      "cache_read_tokens": 1, "source": "t"}) + "\n")
        res = self._run(pop)
        self.assertAlmostEqual(res["cost_usd"], 0.6, places=4)
        self.assertEqual(res["ledger"], "present")
        self.assertAlmostEqual(res["cost_by_phase"]["implement"], 0.25, places=4)
        self.assertAlmostEqual(res["cost_by_phase"]["docs"], 0.2, places=4)

    def test_absent_ledger_is_flagged_not_silent(self):
        res = self._run(lambda loki, js: self._main(loki, js))
        self.assertAlmostEqual(res["cost_usd"], 0.25, places=4)
        self.assertEqual(res["ledger"], "absent")

    def test_honesty_degraded_and_headline_round_trip(self):
        def pop(loki, js):
            pd = os.path.join(loki, "proofs", "20260101-run")
            os.makedirs(pd)
            with open(os.path.join(pd, "proof.json"), "w") as f:
                js.dump({"honesty": {"headline": "VERIFIED WITH GAPS",
                                     "degraded": [{"item": "build", "reason": "build not run"}]}}, f)
        res = self._run(pop)
        self.assertEqual(res["honesty"]["headline"], "VERIFIED WITH GAPS")
        self.assertEqual(res["honesty"]["degraded"],
                         [{"item": "build", "reason": "build not run"}])
        self.assertEqual(res["verify_verdict"], "VERIFIED WITH GAPS")

    def test_no_proof_means_honesty_none(self):
        res = self._run(lambda loki, js: os.makedirs(loki))
        self.assertIsNone(res["honesty"])

    def test_engine_recorded_from_marker_else_legacy(self):
        def v10(loki, js):
            os.makedirs(loki)
            with open(os.path.join(loki, "engine.json"), "w") as f:
                js.dump({"engine": "v10"}, f)
        self.assertEqual(self._run(v10)["engine"], "v10")
        self.assertEqual(self._run(lambda loki, js: os.makedirs(loki))["engine"], "legacy")


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
