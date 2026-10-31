"""Attribution benchmark: metrics math, dry-run, and task-set integrity.
No model call is made anywhere in this file.
Run: python3 benchmarks/bench/tests/test_attribution.py"""
import contextlib
import io
import json
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

    def test_cost_partial_row_is_lower_bound_not_measured(self):
        r = row(accepted=True, reported=True, cost=2.0)
        r["cost_partial"] = True
        m = A.compute_metrics([r])
        self.assertEqual(m["cost_status"], "partial_lower_bound")
        self.assertIsNone(m["cost_per_accepted_usd"])
        self.assertEqual(m["cost_per_accepted_lower_bound_usd"], 2.0)
        self.assertEqual(m["runs_with_unmeasured_cost"], 1)
        r["cost_partial"] = False
        self.assertEqual(A.compute_metrics([r])["cost_status"], "measured")

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
        rows = [row(arm="raw-configured", accepted=True, reported=True, cost=1.0),
                row(arm="loki", accepted=False, reported=True, cost=None)]
        s = A.summarize(rows)
        self.assertEqual(s["by_arm"]["raw-configured"]["acceptance_rate"], 1.0)
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
        two = ("raw-configured", "loki")
        self.assertEqual(A.arm_order(0, 0, two), ["raw-configured", "loki"])
        self.assertEqual(A.arm_order(1, 0, two), ["loki", "raw-configured"])
        self.assertEqual(A.arm_order(0, 1, two), ["loki", "raw-configured"])
        self.assertEqual(A.arm_order(1, 0), ["raw-bare", "loki", "droid", "raw-configured"])

    def test_dry_run_no_model_call(self):
        def boom(*a, **k):
            raise AssertionError("model-backed call during dry run")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = A.main(["--dry-run", "--repeats", "2"], runner=boom)
        text = out.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("DRY RUN", text)
        self.assertIn("48 model-backed runs", text)
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
        rows = [row(arm="raw-configured", accepted=True, reported=True, cost=1.0),
                dict(row(arm="droid", status="unmeasured", cost=None, elapsed=None),
                     unmeasured_reason="droid CLI not found on PATH")]
        plan = A.build_plan([], 1, "m", 1.0, 5)
        md = A.render_markdown({"generated_utc": "x", "plan": plan, "environment": {},
                                "rows": rows, "summary": A.summarize(rows)})
        self.assertIn("UNMEASURED (1 of 1 runs not measured)", md)
        self.assertIn("droid CLI not found on PATH", md)

    def test_unmeasured_never_printed_as_zero_or_failure(self):
        rows = [dict(row(arm="raw-configured", accepted=True, reported=True, cost=1.0)),
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
            rc = A.main(["--dry-run", "--arms", "raw-configured,nope"])
        self.assertEqual(rc, 2)


class BaselineArmsTest(unittest.TestCase):
    def test_arm_names_are_configured_and_bare(self):
        self.assertIn("raw-configured", A.ARMS)
        self.assertIn("raw-bare", A.ARMS)
        self.assertNotIn("raw_claude", A.ARMS)

    def test_legacy_alias_is_rejected_not_silently_mapped(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = A.main(["--dry-run", "--arms", "raw_claude"])
        self.assertEqual(rc, 2)

    def _cmd(self, arm):
        seen = {}

        def fake(cmd, **kw):
            seen["cmd"] = list(cmd)
            return subprocess.CompletedProcess(cmd, 0, "{}", "")
        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            A.run_raw_claude(d, "p", model="m", budget_usd=1.0, timeout_s=5,
                             runner=fake, bare=(arm == "raw-bare"))
        finally:
            shutil.rmtree(d, ignore_errors=True)
        return seen["cmd"]

    def test_bare_flag_only_on_raw_bare(self):
        self.assertIn("--bare", self._cmd("raw-bare"))
        self.assertNotIn("--bare", self._cmd("raw-configured"))

    def _task(self):
        return {"id": "t1", "class": "bugfix", "prompt": "p"}

    def test_raw_bare_without_key_is_unmeasured_with_reason_and_arm_name(self):
        r = A.run_cell(self._task(), "raw-bare", 1, model="m", budget_usd=1.0,
                       timeout_s=5, scratch=tempfile.gettempdir(),
                       bare_probe={"available": False, "reason": "no ANTHROPIC_API_KEY"})
        self.assertEqual(r["arm"], "raw-bare")
        self.assertEqual(r["status"], "unmeasured")
        self.assertIsNone(r["cost_usd"])
        self.assertIn("ANTHROPIC_API_KEY", r["unmeasured_reason"])

    def test_raw_bare_without_probe_never_runs(self):
        r = A.run_cell(self._task(), "raw-bare", 1, model="m", budget_usd=1.0,
                       timeout_s=5, scratch=tempfile.gettempdir())
        self.assertEqual(r["status"], "unmeasured")

    def test_probe_bare_reads_env_key(self):
        self.assertTrue(A.probe_bare({"ANTHROPIC_API_KEY": "k"})["available"])
        no = A.probe_bare({})
        self.assertFalse(no["available"])
        self.assertIn("ANTHROPIC_API_KEY", no["reason"])

    def test_report_drops_stripped_wording_and_names_both_baselines(self):
        plan = A.build_plan([], 1, "m", 1.0, 5)
        md = A.render_markdown({"generated_utc": "x", "plan": plan, "environment": {},
                                "rows": [], "summary": A.summarize([])})
        self.assertNotIn("stripped", md.lower())
        self.assertIn("raw-configured", md)
        self.assertIn("raw-bare", md)


class SpendCapTest(unittest.TestCase):
    def _ledger_dir(self, usd_lines):
        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        os.makedirs(os.path.join(d, ".loki", "metrics"))
        with open(os.path.join(d, ".loki", "metrics", "child-sessions.jsonl"), "w") as fh:
            for u in usd_lines:
                fh.write('{"phase":"x","usd":%s}\n' % u)
        return d

    def test_ledger_spend_sums_usd(self):
        d = self._ledger_dir([0.5, 0.25])
        try:
            self.assertAlmostEqual(A.ledger_spend(d), 0.75)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_ledger_spend_absent_or_garbage_is_none(self):
        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            self.assertIsNone(A.ledger_spend(d))
            os.makedirs(os.path.join(d, ".loki", "metrics"))
            with open(os.path.join(d, ".loki", "metrics", "child-sessions.jsonl"), "w") as fh:
                fh.write("not json\n")
            self.assertIsNone(A.ledger_spend(d))
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_true_spend_prefers_larger_of_reported_and_ledger(self):
        self.assertAlmostEqual(A.row_true_spend({"cost_usd": 0.2, "true_cost_usd": 1.6}), 1.6)
        self.assertAlmostEqual(A.row_true_spend({"cost_usd": 2.0, "true_cost_usd": 1.0}), 2.0)
        self.assertEqual(A.row_true_spend({"cost_usd": None}), 0.0)

    def test_true_spend_partial_flag_is_not_complete(self):
        self.assertTrue(A.row_spend_is_partial({"cost_usd": 1.0, "cost_partial": True}))
        self.assertFalse(A.row_spend_is_partial({"cost_usd": 1.0}))
        self.assertFalse(A.row_spend_is_partial({"cost_usd": 1.0, "cost_partial": False}))

    def test_partial_helper_decides_every_shape(self):
        import bench_schema as S
        P = S.cost_is_partial
        self.assertTrue(P({"cost_usd": None, "true_cost_usd": 1.0}))
        self.assertTrue(P({"cost_usd": 0.0, "true_cost_usd": 1.0}))
        self.assertTrue(P({"cost_usd": 0.5}, ledger_usd=0.9))
        self.assertTrue(P({"cost_usd": 1.0, "ledger_invalid_lines": 1}))
        self.assertTrue(P({"cost_usd": 1.0, "cost_unpriced_records": 1}))
        self.assertTrue(P({"cost_usd": 1.0, "cost_partial": True}))
        self.assertFalse(P({"cost_usd": 1.0, "true_cost_usd": 1.0}))
        self.assertFalse(P({"cost_usd": None}))

    def test_row_spend_is_partial_null_cost_with_true_cost(self):
        self.assertTrue(A.row_spend_is_partial({"cost_usd": None, "true_cost_usd": 1.0}))

    def test_row_spend_is_partial_zero_cost_below_true_cost(self):
        self.assertTrue(A.row_spend_is_partial({"cost_usd": 0.0, "true_cost_usd": 1.0}))

    def test_compute_metrics_zero_cost_below_true_is_lower_bound(self):
        r = row(accepted=True, reported=True, cost=0.0)
        r["true_cost_usd"] = 2.0
        m = A.compute_metrics([r])
        self.assertEqual(m["cost_status"], "partial_lower_bound")

    def test_result_rows_invalid_ledger_lines_mark_partial(self):
        d = tempfile.mkdtemp()
        try:
            import json as js
            r = dict(row(accepted=True, reported=True, cost=1.0))
            r["ledger_invalid_lines"] = 2
            with open(os.path.join(d, "attribution-s1.json"), "w") as f:
                js.dump({"rows": [r]}, f)
            out = A._result_rows(d)
            self.assertTrue(out[0]["cost_partial"])
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_result_rows_zero_cost_below_true_cost_marks_partial(self):
        d = tempfile.mkdtemp()
        try:
            import json as js
            r = dict(row(accepted=True, reported=True, cost=0.0))
            r["true_cost_usd"] = 1.5
            with open(os.path.join(d, "attribution-s1.json"), "w") as f:
                js.dump({"rows": [r]}, f)
            out = A._result_rows(d)
            self.assertTrue(out[0]["cost_partial"])
            self.assertAlmostEqual(out[0]["cost_usd"], 1.5)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_spend_cap_message_labels_lower_bound_for_zero_below_true(self):
        tasks, plan = self._plan(2)
        orig = A.run_cell

        def fake_cell(task, arm, repeat, **kw):
            return {"task": task["id"], "class": "bugfix", "arm": arm, "repeat": repeat,
                    "accepted": True, "reported_success": True, "status": "completed",
                    "cost_usd": 0.0, "true_cost_usd": 2.0, "elapsed_s": 1.0}
        A.run_cell = fake_cell
        try:
            rows = A.run_all(tasks, plan, max_spend_usd=1.0)
        finally:
            A.run_cell = orig
        self.assertIn("(lower bound)", rows[1]["unmeasured_reason"])

    def test_compute_metrics_null_cost_with_true_cost_is_lower_bound(self):
        r = row(accepted=True, reported=True, cost=None)
        r["true_cost_usd"] = 2.0
        m = A.compute_metrics([r])
        self.assertEqual(m["cost_status"], "partial_lower_bound")
        self.assertAlmostEqual(m["cost_per_accepted_lower_bound_usd"], 2.0)

    def test_ledger_read_counts_invalid_and_unpriced_lines(self):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, A.LEDGER_REL)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as f:
                f.write('not json\n[1]\n{"usd": 0.5}\n{"phase": "x"}\n')
            total, bad, unpriced = A.ledger_read(d)
            self.assertAlmostEqual(total, 0.5)
            self.assertEqual((bad, unpriced), (2, 1))
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def _plan(self, n):
        tasks = [{"id": "t%d" % i, "class": "bugfix", "prompt": "p",
                  "seed_sha256": "a", "acceptance_sha256": "b", "prompt_sha256": "c"}
                 for i in range(n)]
        return tasks, A.build_plan(tasks, 1, "m", 1.0, 5, ("raw-configured",))

    def test_cap_aborts_before_next_run_and_marks_rest_unmeasured(self):
        tasks, plan = self._plan(3)
        calls = []
        orig = A.run_cell

        def fake_cell(task, arm, repeat, **kw):
            calls.append(task["id"])
            return {"task": task["id"], "class": "bugfix", "arm": arm, "repeat": repeat,
                    "accepted": True, "reported_success": True, "status": "completed",
                    "cost_usd": 0.6, "elapsed_s": 1.0}
        A.run_cell = fake_cell
        try:
            rows = A.run_all(tasks, plan, max_spend_usd=1.0)
        finally:
            A.run_cell = orig
        self.assertEqual(calls, ["t0", "t1"])
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[2]["status"], "unmeasured")
        self.assertEqual(rows[2]["arm"], "raw-configured")
        self.assertIn("spend cap", rows[2]["unmeasured_reason"])

    def test_no_cap_runs_everything(self):
        tasks, plan = self._plan(2)
        orig = A.run_cell
        A.run_cell = lambda task, arm, repeat, **kw: {
            "task": task["id"], "class": "bugfix", "arm": arm, "repeat": repeat,
            "accepted": True, "reported_success": True, "status": "completed",
            "cost_usd": 99.0, "elapsed_s": 1.0}
        try:
            rows = A.run_all(tasks, plan)
        finally:
            A.run_cell = orig
        self.assertEqual([r["status"] for r in rows], ["completed", "completed"])

    def test_max_spend_flag_must_be_positive(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = A.main(["--dry-run", "--max-spend-usd", "0"])
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

    def test_pinned_environment_records_identity_presence_only(self):
        saved = os.environ.get("LOGNAME")
        try:
            os.environ["LOGNAME"] = "secret-name-not-recorded"
            env = A.pin_environment(False)
            self.assertEqual(env["identity_env"]["LOGNAME"], True)
            self.assertNotIn("secret-name-not-recorded", json.dumps(env))
            os.environ.pop("LOGNAME")
            env = A.pin_environment(False)
            self.assertEqual(env["identity_env"]["LOGNAME"], False)
            self.assertTrue(A._schema.identity_env_problems(env))
        finally:
            if saved is None:
                os.environ.pop("LOGNAME", None)
            else:
                os.environ["LOGNAME"] = saved

    def test_scoped_env_keeps_logname(self):
        saved = os.environ.get("LOGNAME")
        try:
            os.environ["LOGNAME"] = "u"
            self.assertEqual(A._scoped_env().get("LOGNAME"), "u")
        finally:
            if saved is None:
                os.environ.pop("LOGNAME", None)
            else:
                os.environ["LOGNAME"] = saved


class CostHarnRealOutcomeTest(unittest.TestCase):
    """COST-HARN: real rc, origin remote, v10 evidence, kept evidence."""

    SLUG_RE = r"[:/]([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?$"  # run_group.ts SLUG_RE

    def _run(self, rc, populate=None, stderr="boom\n"):
        import json as _json
        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        pf = os.path.join(d, "p.md")
        open(pf, "w").write("x")

        def fake(cmd, **kw):
            if cmd[1:2] == ["start"]:
                if populate:
                    populate(os.path.join(d, ".loki"), _json)
                return subprocess.CompletedProcess(cmd, rc, "out\n", stderr)
            return subprocess.CompletedProcess(cmd, 0, "", "")

        try:
            return A.run_loki(d, pf, model="claude-sonnet-5", budget_usd=1.0,
                              timeout_s=5, runner=fake)
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_seed_has_origin_remote_run_group_accepts(self):
        import re
        t = A.load_tasks(A.DEFAULT_TASKS_DIR)[0][0]
        wd = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            A.materialize_seed(t, wd)
            url = subprocess.run(["git", "-C", wd, "remote", "get-url", "origin"],
                                 capture_output=True, text=True).stdout.strip()
            self.assertTrue(re.search(self.SLUG_RE, url), "origin %r has no owner/repo" % url)
        finally:
            shutil.rmtree(wd, ignore_errors=True)

    def test_failed_run_stores_real_rc_and_stderr_tail(self):
        res = self._run(1, stderr="x" * 3000 + "TAIL")
        self.assertEqual(res["rc"], 1)
        self.assertFalse(res["reported_success"])
        self.assertTrue(res["stderr_tail"].endswith("TAIL"))
        self.assertEqual(len(res["stderr_tail"]), 2000)

    def test_clean_run_is_success_with_rc_zero(self):
        res = self._run(0)
        self.assertEqual(res["rc"], 0)
        self.assertTrue(res["reported_success"])

    def test_v10_receipt_and_events_are_read_first(self):
        def pop(loki, js):
            rd = os.path.join(loki, "runs", "20260101T000000Z-aaa")
            os.makedirs(rd)
            with open(os.path.join(rd, "receipt.json"), "w") as f:
                js.dump({"verdict": "VERIFIED", "not_proven": ["full suite"]}, f)
            with open(os.path.join(rd, "events.jsonl"), "w") as f:
                for ty, st, data in (("session.started", "implement", {}),
                                     ("session.started", "fix", {}),
                                     ("stage.failed", "verify", {"reason": "tests red"})):
                    f.write(js.dumps({"type": ty, "stage": st, "data": data}) + "\n")
        res = self._run(0, pop)
        self.assertEqual(res["verify_verdict"], "VERIFIED")
        self.assertEqual(res["honesty"]["degraded"], ["full suite"])
        self.assertEqual(res["iterations"], 2)
        self.assertEqual(res["failure_reason"], {"error_class": "verify", "brief": "tests red"})

    def test_cell_keeps_loki_evidence_before_workdir_deleted(self):
        t = A.load_tasks(A.DEFAULT_TASKS_DIR)[0][0]
        scratch = tempfile.mkdtemp(prefix="loki-attr-test-")
        ev = tempfile.mkdtemp(prefix="loki-attr-test-")

        def fake(cmd, **kw):
            if cmd[1:2] == ["start"]:
                os.makedirs(os.path.join(kw["cwd"], ".loki", "runs", "r1"))
                open(os.path.join(kw["cwd"], ".loki", "runs", "r1", "events.jsonl"), "w").write("{}\n")
                os.makedirs(os.path.join(kw["cwd"], ".loki", "node_modules"))
                open(os.path.join(kw["cwd"], ".loki", "node_modules", "big"), "w").write("x")
                return subprocess.CompletedProcess(cmd, 1, "", "kaput")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        try:
            row = A.run_cell(t, "loki", 1, model="claude-sonnet-5", budget_usd=1.0,
                             timeout_s=5, scratch=scratch, runner=fake, evidence_dir=ev)
            cell = os.path.join(ev, "%s-loki-1" % t["id"])
            self.assertTrue(os.path.isfile(os.path.join(cell, ".loki", "runs", "r1", "events.jsonl")))
            self.assertFalse(os.path.exists(os.path.join(cell, ".loki", "node_modules")))
            self.assertIn("kaput", open(os.path.join(cell, "stderr.txt")).read())
            self.assertEqual(row["rc"], 1)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
            shutil.rmtree(ev, ignore_errors=True)

    def test_loki_command_has_no_pr_and_prompts_off(self):
        seen = {}

        def fake(cmd, **kw):
            if cmd[1:2] == ["start"]:
                seen["cmd"] = cmd
                seen["env"] = kw.get("env") or {}
            return subprocess.CompletedProcess(cmd, 0, "", "")
        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            pf = os.path.join(d, "p.md")
            open(pf, "w").write("x")
            A.run_loki(d, pf, model="claude-sonnet-5", budget_usd=1.0,
                       timeout_s=5, runner=fake)
        finally:
            shutil.rmtree(d, ignore_errors=True)
        self.assertIn("--no-pr", seen["cmd"])
        self.assertEqual(seen["env"].get("GIT_TERMINAL_PROMPT"), "0")
        self.assertEqual(seen["env"].get("GH_PROMPT_DISABLED"), "1")

    def test_evidence_skips_secret_names_keeps_receipts(self):
        wd = tempfile.mkdtemp(prefix="loki-attr-test-")
        dest = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            lk = os.path.join(wd, ".loki")
            os.makedirs(os.path.join(lk, "runs", "r1"))
            for n in (".env", "prod.ENV", "gh_token.txt", "Secrets.json",
                      "signing-key.pem", "keys.json"):
                open(os.path.join(lk, n), "w").write("s")
            for n in ("runs/r1/receipt.json", "runs/r1/events.jsonl", "engine.json"):
                open(os.path.join(lk, n), "w").write("{}")
            A.keep_evidence(wd, dest, {})
            kept = sorted(os.listdir(os.path.join(dest, ".loki")))
            self.assertEqual(kept, ["engine.json", "runs"])
            self.assertTrue(os.path.isfile(os.path.join(dest, ".loki", "runs", "r1", "receipt.json")))
        finally:
            shutil.rmtree(wd, ignore_errors=True)
            shutil.rmtree(dest, ignore_errors=True)


class TaskVenvEvidenceTest(unittest.TestCase):
    def _task(self, root):
        seed = os.path.join(root, "seed")
        os.makedirs(seed)
        open(os.path.join(seed, "a.py"), "w").write("x = 1\n")
        return {"id": "venv-t", "seed_dir": seed}

    def test_seed_has_project_python_not_committed(self):
        root = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            wd = os.path.join(root, "wd")
            A.materialize_seed(self._task(root), wd)
            self.assertTrue(os.path.exists(os.path.join(wd, ".venv", "bin", "python")))
            tracked = subprocess.run(["git", "-C", wd, "ls-files"], capture_output=True,
                                     text=True).stdout.split()
            self.assertEqual(tracked, ["a.py"])
            st = subprocess.run(["git", "-C", wd, "status", "--porcelain"],
                                capture_output=True, text=True).stdout
            self.assertEqual(st.strip(), "")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_seed_venv_python_can_run_pytest(self):
        root = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            wd = os.path.join(root, "wd")
            A.materialize_seed(self._task(root), wd)
            open(os.path.join(wd, "test_a.py"), "w").write(
                "def test_ok():\n    assert 1 == 1\n")
            r = subprocess.run([os.path.join(wd, ".venv", "bin", "python"), "-m",
                                "pytest", "-q", "test_a.py"], cwd=wd,
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("1 passed", r.stdout)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_evidence_skips_venv_and_records_error(self):
        wd = tempfile.mkdtemp(prefix="loki-attr-test-")
        dest = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            os.makedirs(os.path.join(wd, ".loki", ".venv"))
            os.makedirs(os.path.join(wd, ".loki", "venv"))
            open(os.path.join(wd, ".loki", "engine.json"), "w").write("{}")
            row = {}
            A.keep_evidence(wd, dest, row)
            self.assertEqual(os.listdir(os.path.join(dest, ".loki")), ["engine.json"])
            self.assertNotIn("evidence_error", row)
            bad = {}
            blocker = os.path.join(dest, "blocker")
            open(blocker, "w").write("f")
            A.keep_evidence(wd, blocker, bad)
            self.assertIn("evidence_error", bad)
        finally:
            shutil.rmtree(wd, ignore_errors=True)
            shutil.rmtree(dest, ignore_errors=True)


class LokiLedgerRowTest(unittest.TestCase):
    """S1: the loki row carries true (ledger-summed) cost, phase split, engine and honesty."""

    def _run(self, populate):
        import json as _json

        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        pf = os.path.join(d, "p.md")
        open(pf, "w").write("x")

        def fake(cmd, **kw):
            if cmd[1:2] == ["start"]:
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
        self.assertAlmostEqual(res["cost_by_phase"]["main_session"], 0.25, places=4)
        self.assertNotIn("implement", res["cost_by_phase"])
        self.assertAlmostEqual(res["cost_by_phase"]["docs"], 0.2, places=4)

    def test_token_only_main_with_ledger_marks_row_cost_partial(self):
        def pop(loki, js):
            eff = os.path.join(loki, "metrics", "efficiency")
            os.makedirs(eff, exist_ok=True)
            with open(os.path.join(eff, "iteration-1.json"), "w") as f:
                js.dump({"iteration": 1, "input_tokens": 10, "output_tokens": 5,
                         "cache_read_tokens": 0, "cache_creation_tokens": 0}, f)
            with open(os.path.join(loki, "metrics", "child-sessions.jsonl"), "w") as f:
                f.write(js.dumps({"phase": "docs", "model": "sonnet", "usd": 0.2,
                                  "input_tokens": 1, "output_tokens": 1,
                                  "cache_creation_tokens": 1,
                                  "cache_read_tokens": 1, "source": "t"}) + "\n")
        res = self._run(pop)
        self.assertTrue(res["cost_partial"])
        self.assertAlmostEqual(res["cost_usd"], 0.2, places=4)

    def test_complete_cost_is_not_partial(self):
        res = self._run(lambda loki, js: self._main(loki, js))
        self.assertFalse(res["cost_partial"])

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

    def test_every_seed_ships_a_passing_executable_test(self):
        for t in self.tasks:
            tests_dir = os.path.join(t["seed_dir"], "tests")
            found = sorted(f for f in (os.listdir(tests_dir) if os.path.isdir(tests_dir) else [])
                           if f.startswith("test_") and f.endswith(".py"))
            self.assertTrue(found, "%s seed has no tests/test_*.py" % t["id"])
            wd = tempfile.mkdtemp(prefix="loki-attr-test-")
            try:
                shutil.copytree(t["seed_dir"], wd, dirs_exist_ok=True)
                r = subprocess.run(
                    [sys.executable, "-I", "-m", "unittest", "discover",
                     "-s", "tests", "-p", "test_*.py"],
                    cwd=wd, capture_output=True, text=True, timeout=60)
                self.assertEqual(r.returncode, 0,
                                 "%s seed test fails on unmodified seed: %s" % (t["id"], r.stderr[-400:]))
                self.assertNotIn("Ran 0 tests", r.stderr, t["id"])
            finally:
                shutil.rmtree(wd, ignore_errors=True)

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


class LokiBinaryPinTest(unittest.TestCase):
    """The loki arm must run the repo bin/loki and refuse a stale-version binary."""

    def setUp(self):
        from adapters import loki as L
        self.L = L
        self._saved = {k: os.environ.pop(k, None) for k in (
            "LOKI_BENCH_LOKI_BIN", "LOKI_BENCH_ALLOW_VERSION_MISMATCH")}

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _fake(self, version_text):
        cmds = []

        def fake(cmd, **kw):
            cmds.append(cmd)
            out = version_text if cmd[1:2] == ["version"] else "claude 1.0.0"
            return subprocess.CompletedProcess(cmd, 0, out, "")
        fake.cmds = cmds
        return fake

    def _repo_ver(self):
        return self.L.repo_version()

    def test_default_is_repo_bin_loki(self):
        expect = os.path.join(self.L.REPO_ROOT, "bin", "loki")
        self.assertEqual(self.L.loki_bin(), expect)
        self.assertTrue(os.path.isfile(expect))
        fake = self._fake("Loki Mode v%s" % self._repo_ver())
        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        try:
            self.L.run(d, "p.md", runner=fake, timeout=5)
        finally:
            shutil.rmtree(d, ignore_errors=True)
        self.assertTrue(fake.cmds)
        for c in fake.cmds:
            self.assertEqual(c[0], expect)

    def test_override_env_honored(self):
        os.environ["LOKI_BENCH_LOKI_BIN"] = "/opt/custom/loki"
        self.assertEqual(self.L.loki_bin(), "/opt/custom/loki")
        fake = self._fake("Loki Mode v1.0.0")
        self.L._detect_loki_version(runner=fake)
        self.assertEqual(fake.cmds[0][0], "/opt/custom/loki")

    def test_mismatch_refuses_execute(self):
        fake = self._fake("Loki Mode v0.0.1")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = A.main(["--execute"], runner=fake)
        self.assertEqual(rc, 2)
        self.assertIn("refusing", err.getvalue())
        self.assertFalse([c for c in fake.cmds if c[1:2] == ["start"]])

    def test_mismatch_waiver_env(self):
        os.environ["LOKI_BENCH_ALLOW_VERSION_MISMATCH"] = "1"
        self.assertIsNone(self.L.version_mismatch_error("Loki Mode v0.0.1"))

    def test_match_passes_and_unparseable_refuses(self):
        self.assertIsNone(self.L.version_mismatch_error(
            "Loki Mode v%s" % self._repo_ver()))
        self.assertIsNotNone(self.L.version_mismatch_error(None))
        self.assertIsNotNone(self.L.version_mismatch_error("garbage"))

    def test_metadata_records_path_and_version(self):
        fake = self._fake("Loki Mode v%s" % self._repo_ver())
        env = A.pin_environment(True, runner=fake, model="x")
        self.assertEqual(env["loki_bin"], self.L.loki_bin())
        self.assertEqual(env["loki_version"], "Loki Mode v%s" % self._repo_ver())
        self.assertIn("loki_repo_sha", env)
        self.assertEqual(A.pin_environment(False)["loki_bin"], self.L.loki_bin())


class CostTableTest(unittest.TestCase):
    """--dry-run prints cost per accepted from existing result files; no spend."""

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="costtable-")
        self.addCleanup(shutil.rmtree, self.d, True)

    def _write(self, rows, stamp="20260101T000000Z"):
        import json
        with open(os.path.join(self.d, "attribution-%s.json" % stamp), "w") as fh:
            json.dump({"rows": rows}, fh)

    def _ledger(self, task, arm, usd, stamp="20260101T000000Z", rep=1):
        import json
        mdir = os.path.join(self.d, "evidence-%s" % stamp,
                            "%s-%s-%d" % (task, arm, rep), ".loki", "metrics")
        os.makedirs(mdir)
        with open(os.path.join(mdir, "child-sessions.jsonl"), "w") as fh:
            fh.write(json.dumps({"usd": usd}) + "\n")

    def _table(self):
        return A.render_cost_table(self.d)

    def _line(self, text, arm):
        return [ln for ln in text.splitlines() if ln.startswith("| %s " % arm)][0]

    def test_ratios_against_both_floors_and_target(self):
        self._write([
            row("raw-configured", True, cost=4.0), row("raw-bare", True, cost=2.0),
            row("loki", True, cost=1.0)])
        text = self._table()
        loki = self._line(text, "loki")
        self.assertIn("$1.0000", loki)
        self.assertIn("0.25x", loki)   # vs raw-configured 4.0
        self.assertIn("0.50x", loki)   # vs raw-bare 2.0
        self.assertIn("1.00x", loki)   # 1.0 / (0.5 * raw-bare 2.0)

    def test_missing_arm_prints_unmeasured_not_zero(self):
        self._write([row("raw-configured", True, cost=4.0), row("loki", True, cost=1.0)])
        text = self._table()
        self.assertIn("unmeasured", self._line(text, "raw-bare"))
        loki = self._line(text, "loki")
        self.assertIn("unmeasured", loki)  # ratio vs absent raw-bare floor
        self.assertNotIn("0.00x", text)

    def test_none_accepted_has_no_ratio(self):
        self._write([row("raw-configured", True, cost=4.0), row("loki", False, cost=1.0)])
        loki = self._line(self._table(), "loki")
        self.assertIn("undefined", loki)

    def test_child_session_ledger_included(self):
        r = row("loki", True, cost=1.0)
        r["task"] = "tk"
        self._write([row("raw-configured", True, cost=4.0), r])
        self._ledger("tk", "loki", 3.0)
        loki = self._line(self._table(), "loki")
        self.assertIn("$3.0000", loki)  # larger of reported and ledger

    def test_missing_cost_without_ledger_is_unmeasured_not_zero(self):
        self._write([row("raw-configured", True, cost=4.0),
                     row("raw-bare", True, cost=2.0), row("loki", True, cost=None)])
        loki = self._line(self._table(), "loki")
        self.assertNotIn("$0.0000", loki)
        self.assertNotIn("$", loki)
        self.assertNotRegex(loki, r"\d\.\d\dx")  # no ratio computed from $0
        self.assertIn("unmeasured", loki)

    def test_ledger_only_cost_is_partial_not_complete_ratio(self):
        r = row("loki", True, cost=None)
        r["true_cost_usd"] = 0.40
        r["cost_partial"] = False
        self._write([row("raw-configured", True, cost=1.0),
                     row("raw-bare", True, cost=1.0), r])
        loki = self._line(self._table(), "loki")
        self.assertIn("unmeasured", loki)
        self.assertNotRegex(loki, r"\d\.\d\dx")
        self.assertRegex(loki, r"(&gt;|>)=")

    def test_malformed_ledger_line_keeps_valid_lines(self):
        r = row("loki", True, cost=1.0)
        r["task"] = "tk"
        self._write([row("raw-configured", True, cost=4.0), r])
        mdir = os.path.join(self.d, "evidence-20260101T000000Z", "tk-loki-1",
                            ".loki", "metrics")
        os.makedirs(mdir)
        with open(os.path.join(mdir, "child-sessions.jsonl"), "w") as fh:
            fh.write('{"usd": 1.5}\n{not json\n\n{"usd": "x"}\n{"usd": 2.0}\n')
        loki = self._line(self._table(), "loki")
        self.assertIn("$3.5000", loki)  # 1.5 + 2.0 summed, bad lines skipped

    def test_no_result_files(self):
        text = self._table()
        self.assertIn("no result files", text)

    def test_dry_run_prints_table_without_model_call(self):
        self._write([row("raw-configured", True, cost=4.0), row("loki", True, cost=1.0)])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = A.main(["--dry-run", "--out-dir", self.d],
                        runner=lambda *a, **k: 1 / 0)
        self.assertEqual(rc, 0)
        self.assertIn("cost per accepted", out.getvalue())
        self.assertIn("DRY RUN", out.getvalue())


class LeanArmsTest(unittest.TestCase):
    """TEN-COST-04: raw-lean and loki-lean arms, lever ablation, verdict lines."""

    ARMS4 = "raw-configured,raw-lean,loki,loki-lean"

    def _main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = A.main(argv, runner=lambda *a, **k: 1 / 0)
        return rc, out.getvalue(), err.getvalue()

    def test_dry_run_plans_all_four_arms(self):
        rc, out, _ = self._main(["--dry-run", "--arms", self.ARMS4])
        self.assertEqual(rc, 0)
        n_tasks = len(A.load_tasks(A.DEFAULT_TASKS_DIR)[0])
        self.assertIn("%d model-backed runs" % (4 * n_tasks), out)
        for arm in self.ARMS4.split(","):
            planned = [ln for ln in out.splitlines() if (" %s " % arm) in ln and " run 1" in ln]
            self.assertEqual(len(planned), n_tasks, arm)
        self.assertIn("cost_profile=lean", out)

    def test_plan_cells_carry_cost_profile(self):
        tasks = A.load_tasks(A.DEFAULT_TASKS_DIR)[0][:1]
        plan = A.build_plan(tasks, 1, "m", 1.0, 5, tuple(self.ARMS4.split(",")),
                            {"LOKI_E10_TRIM": "1"})
        prof = {c["arm"]: c.get("cost_profile") for c in plan["cells"]}
        self.assertEqual(prof["loki-lean"], "lean")
        self.assertEqual(prof["loki"], "off")
        self.assertIsNone(prof["raw-lean"])
        self.assertEqual(plan["loki_env"], {"LOKI_E10_TRIM": "1"})

    def _cell(self, arm, loki_env=None):
        t = A.load_tasks(A.DEFAULT_TASKS_DIR)[0][0]
        scratch = tempfile.mkdtemp(prefix="loki-attr-test-")
        seen = {}

        def fake(cmd, **kw):
            if cmd[1:2] == ["start"] or (cmd[:1] == ["claude"] and "-p" in cmd):
                seen["cmd"] = list(cmd)
                seen["env"] = dict(kw.get("env") or {})
            return subprocess.CompletedProcess(cmd, 0, "{}", "")
        try:
            row_ = A.run_cell(t, arm, 1, model="claude-sonnet-5", budget_usd=1.0,
                              timeout_s=5, scratch=scratch, runner=fake,
                              loki_env=loki_env)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        return row_, seen

    def test_loki_lean_row_and_env_carry_lean_profile(self):
        row_, seen = self._cell("loki-lean")
        self.assertEqual(row_["cost_profile"], "lean")
        self.assertEqual(seen["env"].get("LOKI_COST_PROFILE"), "lean")

    def test_plain_loki_pins_profile_off_against_parent_env(self):
        old = os.environ.get("LOKI_COST_PROFILE")
        os.environ["LOKI_COST_PROFILE"] = "lean"
        try:
            row_, seen = self._cell("loki")
        finally:
            if old is None:
                os.environ.pop("LOKI_COST_PROFILE", None)
            else:
                os.environ["LOKI_COST_PROFILE"] = old
        self.assertEqual(row_["cost_profile"], "off")
        self.assertEqual(seen["env"].get("LOKI_COST_PROFILE"), "off")

    def test_lever_env_reaches_child_and_row(self):
        row_, seen = self._cell("loki", {"LOKI_E10_TRIM": "1"})
        self.assertEqual(row_["lever_env"], {"LOKI_E10_TRIM": "1"})
        self.assertEqual(seen["env"].get("LOKI_E10_TRIM"), "1")

    def test_raw_lean_argv_and_lean_bare_conflict(self):
        _row, seen = self._cell("raw-lean")
        self.assertIn("--strict-mcp-config", seen["cmd"])
        self.assertNotIn("--bare", seen["cmd"])
        _row, seen = self._cell("raw-configured")
        self.assertNotIn("--strict-mcp-config", seen["cmd"])
        with self.assertRaises(ValueError):
            A.run_raw_claude("/nonexistent", "p", model="m", budget_usd=1.0,
                             timeout_s=5, bare=True, lean=True)

    def test_loki_env_rejects_non_loki_keys_exit_2(self):
        for bad in ("FOO=1", "loki_x=1", "LOKI_=1", "LOKI_X", "LOKI_COST_PROFILE=lean",
                    "LOKI_SESSION_MODEL=haiku", "XLOKI_A=1"):
            rc, _out, err = self._main(["--dry-run", "--arms", "loki", "--loki-env", bad])
            self.assertEqual(rc, 2, bad)
            self.assertIn("--loki-env", err)

    def test_loki_env_without_loki_arm_exit_2(self):
        rc, _out, err = self._main(["--dry-run", "--arms", "raw-lean",
                                    "--loki-env", "LOKI_E10_TRIM=1"])
        self.assertEqual(rc, 2)
        self.assertIn("needs a loki arm", err)

    def test_loki_env_repeatable_shown_in_plan(self):
        rc, out, _ = self._main(["--dry-run", "--arms", "loki", "--loki-env", "LOKI_E10_TRIM=1",
                                 "--loki-env", "LOKI_ROUTER=0"])
        self.assertEqual(rc, 0)
        self.assertIn("LOKI_E10_TRIM=1, LOKI_ROUTER=0", out)

    def test_parse_loki_env_conflicting_duplicate(self):
        with self.assertRaises(ValueError):
            A.parse_loki_env(["LOKI_A=1", "LOKI_A=2"])
        self.assertEqual(A.parse_loki_env(["LOKI_A=1", "LOKI_A=1"]), {"LOKI_A": "1"})

    def test_adapter_rejects_non_loki_env(self):
        from adapters import loki as L
        with self.assertRaises(ValueError):
            L.validate_lever_env({"PATH": "/x"})
        self.assertEqual(L.validate_lever_env({"LOKI_A": 1}), {"LOKI_A": "1"})

    def test_adapter_records_cache_tokens_by_phase(self):
        import json as js
        d = tempfile.mkdtemp(prefix="loki-attr-test-")
        pf = os.path.join(d, "p.md")
        open(pf, "w").write("x")

        def fake(cmd, **kw):
            if cmd[1:2] == ["start"]:
                eff = os.path.join(d, ".loki", "metrics", "efficiency")
                os.makedirs(eff)
                with open(os.path.join(eff, "iteration-1.json"), "w") as fh:
                    js.dump({"cost_usd": 1.0, "input_tokens": 10, "output_tokens": 5,
                             "cache_read_tokens": 100, "cache_creation_tokens": 40,
                             "model": "claude-sonnet-5"}, fh)
                with open(os.path.join(d, ".loki", "metrics", "child-sessions.jsonl"), "w") as fh:
                    fh.write(js.dumps({"phase": "review", "usd": 0.5, "cache_read_tokens": 30,
                                       "cache_creation_tokens": 10}) + "\n")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        try:
            res = A.run_loki(d, pf, model="claude-sonnet-5", budget_usd=1.0, timeout_s=5,
                             runner=fake, profile="lean", lever_env={"LOKI_A": "1"})
        finally:
            shutil.rmtree(d, ignore_errors=True)
        self.assertEqual(res["cost_profile"], "lean")
        self.assertEqual(res["lever_env"], {"LOKI_A": "1"})
        cache = res["cache_tokens_by_phase"]
        self.assertEqual(cache["review"], {"cache_read": 30, "cache_creation": 10})
        self.assertEqual(cache["main_session"], {"cache_read": 100, "cache_creation": 40})


class LeanCostTableTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="loki-attr-test-")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _write(self, rows):
        import json
        with open(os.path.join(self.d, "attribution-20260101T000000Z.json"), "w") as fh:
            json.dump({"rows": rows}, fh)

    def _rows(self, arm, tasks, usd, **extra):
        out = []
        for t in tasks:
            r = row(arm, True, True, cost=usd)
            r.update(task=t, **extra)
            out.append(r)
        return out

    def test_table_has_raw_lean_column_and_verdict_line(self):
        rows = (self._rows("raw-lean", "abc", 4.0) + self._rows(
            "loki-lean", "abc", 1.0, cost_profile="lean", lever_env={},
            engine="v10", loki_version="1.0.0"))
        for r in rows:
            r["cost_source"] = "claude_json.total_cost_usd"
        self._write(rows)
        text = A.render_cost_table(self.d)
        self.assertIn("vs raw-lean", text)
        self.assertIn("vs 0.5x target (raw-lean)", text)
        verdicts = [ln for ln in text.splitlines() if ln.startswith("verdict loki-lean vs raw-lean")]
        self.assertEqual(len(verdicts), 1)
        self.assertIn("NOT PROVEN", verdicts[0])
        self.assertIn("n:", verdicts[0])
        lean = [ln for ln in text.splitlines() if ln.startswith("| loki-lean ")][0]
        self.assertIn("0.25x", lean)

    def test_proven_when_repeats_ok(self):
        rows = []
        for rep in range(3):
            for arm, usd in (("raw-lean", 4.0), ("loki-lean", 1.0)):
                for t in "abc":
                    r = row(arm, True, True, cost=usd + 0.01 * rep)
                    r.update(task=t, repeat=rep + 1, engine="v10", loki_version="1.0.0", model_used="m1",
                             lever_env={}, cost_source="claude_json.total_cost_usd")
                    rows.append(r)
        self._write(rows)
        text = A.render_cost_table(self.d)
        line = [ln for ln in text.splitlines() if ln.startswith("verdict loki-lean vs raw-lean")][0]
        self.assertIn("PROVEN_AT(0.5)", line)
        self.assertNotIn("NOT PROVEN", line)
        self.assertIn("metered loki 1.00, floor 1.00", line)
        self.assertIn("reconciliation not measured", line)

    def test_unmetered_row_makes_verdict_line_invalid_lower_bound(self):
        rows = []
        for rep in range(3):
            for arm, usd in (("raw-lean", 4.0), ("loki-lean", 1.0)):
                for t in "abc":
                    r = row(arm, True, True, cost=usd)
                    r.update(task=t, repeat=rep + 1, engine="v10", loki_version="1.0.0", model_used="m1",
                             lever_env={}, cost_source="claude_json.total_cost_usd")
                    rows.append(r)
        rows[1]["cost_usd"] = None
        self._write(rows)
        line = [ln for ln in A.render_cost_table(self.d).splitlines()
                if ln.startswith("verdict loki-lean vs raw-lean")][0]
        self.assertIn("INVALID", line)
        self.assertIn("ratio not computable", line)
        self.assertIn("lower bound", line)

    def test_droid_arm_without_cost_states_cost_claim_stays_invalid(self):
        rows = [row("raw-lean", True, True, cost=4.0),
                row("droid", True, True, cost=None)]
        self._write(rows)
        text = A.render_cost_table(self.d)
        notes = [ln for ln in text.splitlines() if ln.startswith("droid arm:")]
        self.assertEqual(len(notes), 1, text)
        self.assertIn("cost_usd is None", notes[0])
        self.assertIn("INVALID", notes[0])

    def test_different_lever_env_is_not_pooled_into_loki_arm(self):
        rows = self._rows("loki", "abc", 1.0, lever_env={}, cost_profile="off")
        rows += self._rows("loki", "de", 9.0, lever_env={"LOKI_E10_TRIM": "1"},
                           cost_profile="off")
        self._write(rows)
        text = A.render_cost_table(self.d)
        base = [ln for ln in text.splitlines() if ln.startswith("| loki ")][0]
        abl = [ln for ln in text.splitlines() if ln.startswith("| loki+LOKI_E10_TRIM=1 ")][0]
        self.assertIn("| 3 |", base)
        self.assertIn("$3.0000", base)
        self.assertIn("| 2 |", abl)
        self.assertIn("$18.0000", abl)
        summ = A.summarize(rows, ("loki",))
        self.assertEqual(summ["by_arm"]["loki"]["accepted"], 3)
        self.assertEqual(summ["by_arm"]["loki+LOKI_E10_TRIM=1"]["accepted"], 2)

    def test_lever_env_value_boundary_does_not_pool(self):
        a = row("loki", True, cost=1.0)
        a["lever_env"] = {"LOKI_X": "1"}
        b = dict(a, lever_env={"LOKI_X": "10"})
        c = dict(a, lever_env={"LOKI_X": "1", "LOKI_Y": "2"})
        self.assertEqual(len({A.arm_label(x) for x in (a, b, c)}), 3)

    def test_attribution_cells_pair_each_loki_label_with_raw_lean(self):
        l1 = dict(row("loki-lean", True), model_used="claude-sonnet-5", lever_env={})
        l2 = dict(row("loki-lean", True), model_used="claude-sonnet-5",
                  lever_env={"LOKI_A": "1"})
        r = dict(row("raw-lean", True), model_used="claude-sonnet-5")
        cells = A.attribution_cells([l1, l2, r])
        self.assertEqual(sorted(c["loki_arm"] for c in cells),
                         ["loki-lean", "loki-lean+LOKI_A=1"])
        self.assertTrue(all(c["raw_arm"] == "raw-lean" and c["valid"] for c in cells))


if __name__ == "__main__":
    unittest.main()
