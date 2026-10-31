"""tests/test_bench_runner.py -- R2 benchmark runner + grader behavior.

Covers the credibility-critical invariants:
  - The GRADER (not the adapter) sets success: an always-pass acceptance ->
    success True, an always-fail acceptance -> success False, for the SAME
    adapter output.
  - validate_adapter_output REJECTS any adapter that reports its own outcome
    (success/quality/passed/score/...).
  - N-trial aggregation: success_rate, medians, min/max spread.
  - Cost summary: cost_usd lifts from the adapter; cost_usd=null when the
    adapter omits tokens/cost (never coerced to 0).
  - task_hash is recorded and recomputed identically (verify round-trips).

NO paid API calls: the adapter is a pure-python mock with fixed cost/tokens.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BENCH = os.path.join(_REPO, "benchmarks", "bench")
if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)

import bench_schema as schema  # noqa: E402
import runner  # noqa: E402


# ---------------------------------------------------------------------------
# mock adapters -- fixed cost/tokens, NEVER report outcome
# ---------------------------------------------------------------------------

# Mock adapters use the SAME signature as the real Slice C adapters:
#   run(workdir, spec, *, model=, timeout=, runner=None)
# where `spec` is the materialized prompt-file path (NOT the task-spec dict).

def mock_adapter_with_cost(workdir, spec, *, model="mock-model", timeout=900,
                           runner=None):
    """A well-behaved adapter: writes a marker file, reports cost, no outcome."""
    with open(os.path.join(workdir, "agent-touched.txt"), "w") as fh:
        fh.write("done\n")
    return {
        "tool": "mock",
        "tool_version": "0.0.1",
        "model_used": model or "mock-model",
        "duration_s": 12.5,
        "iterations": 3,
        "tokens_in": 1000,
        "tokens_out": 500,
        "cost_usd": 0.42,
        "exit_status": "completed",
        "provenance": {"command": "mock", "verified": True},
    }


def mock_adapter_no_cost(workdir, spec, *, model="mock-model", timeout=900,
                         runner=None):
    """An adapter that did NOT collect cost: cost_usd null, tokens null."""
    return {
        "tool": "mock",
        "tool_version": "0.0.1",
        "model_used": model or "mock-model",
        "duration_s": 8.0,
        "exit_status": "completed",
        "provenance": {"verified": True},
        # cost_usd / tokens deliberately omitted
    }


def mock_adapter_that_judges(workdir, spec, *, model="mock-model", timeout=900,
                             runner=None):
    """A misbehaving adapter that tries to grade itself. MUST be rejected."""
    return {
        "tool": "mock",
        "tool_version": "0.0.1",
        "model_used": model or "mock-model",
        "duration_s": 1.0,
        "exit_status": "completed",
        "provenance": {},
        "success": True,   # forbidden
        "score": 100,      # forbidden
    }


# ---------------------------------------------------------------------------
# fixture + task-spec scaffolding
# ---------------------------------------------------------------------------

def _make_task(tmp, *, acceptance_cmd, quality=None, task_id="mock-task"):
    """Build a task-spec json + a one-file fixture under tmp. Returns spec path."""
    fixture_dir = os.path.join(tmp, "fixtures", task_id)
    os.makedirs(fixture_dir, exist_ok=True)
    with open(os.path.join(fixture_dir, "seed.txt"), "w") as fh:
        fh.write("fixture content\n")
    spec = {
        "schema_version": "1.0",
        "id": task_id,
        "source": "unit-test",
        "fixture": os.path.join("fixtures", task_id),
        "prompt": "do the thing",
        "acceptance": {"cmd": acceptance_cmd, "timeout_s": 30},
        "default_model": "mock-model",
        "agent_timeout_s": 60,
    }
    if quality:
        spec["quality"] = quality
    spec_path = os.path.join(tmp, "%s.json" % task_id)
    with open(spec_path, "w") as fh:
        json.dump(spec, fh)
    return spec_path


class GraderDecidesSuccessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_always_pass_acceptance_marks_success(self):
        # exit 0 acceptance -> grader sets success True
        spec_path = _make_task(self.tmp, acceptance_cmd="true", task_id="pass-task")
        row = runner.run_task(spec_path, "mock", trials=1,
                              adapter=mock_adapter_with_cost)
        self.assertTrue(row["trials"][0]["success"])
        self.assertEqual(row["trials"][0]["acceptance_exit_code"], 0)
        self.assertEqual(row["summary"]["n_success"], 1)
        self.assertEqual(row["summary"]["success_rate"], 1.0)

    def test_always_fail_acceptance_marks_failure(self):
        # exit 1 acceptance -> grader sets success False, even though the adapter
        # ran fine and reported "completed". Adapter outcome is irrelevant.
        spec_path = _make_task(self.tmp, acceptance_cmd="false", task_id="fail-task")
        row = runner.run_task(spec_path, "mock", trials=1,
                              adapter=mock_adapter_with_cost)
        self.assertFalse(row["trials"][0]["success"])
        self.assertNotEqual(row["trials"][0]["acceptance_exit_code"], 0)
        self.assertEqual(row["summary"]["n_success"], 0)
        self.assertEqual(row["summary"]["success_rate"], 0.0)

    def test_grader_uses_produced_repo_state(self):
        # Acceptance command checks for the file the adapter writes -> success
        # only because the adapter actually produced it in the workdir.
        spec_path = _make_task(
            self.tmp, acceptance_cmd="test -f agent-touched.txt",
            task_id="state-task")
        row = runner.run_task(spec_path, "mock", trials=1,
                              adapter=mock_adapter_with_cost)
        self.assertTrue(row["trials"][0]["success"])
        # The no-cost adapter does NOT write the file -> grader fails it.
        row2 = runner.run_task(spec_path, "mock", trials=1,
                               adapter=mock_adapter_no_cost)
        self.assertFalse(row2["trials"][0]["success"])


class HeldOutOverlayTest(unittest.TestCase):
    """The grader overlays held-out test files AFTER the agent runs, so an agent
    that edits the in-workdir test to pass is still graded against the real test.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-overlay-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_overlay_task(self, task_id):
        # fixture ships a permissive test; overlay ships the REAL strict test.
        fixture_dir = os.path.join(self.tmp, "fixtures", task_id)
        overlay_dir = os.path.join(self.tmp, "acceptance", task_id)
        os.makedirs(fixture_dir, exist_ok=True)
        os.makedirs(overlay_dir, exist_ok=True)
        # The fixture's check.sh always passes (what a cheating agent would keep).
        with open(os.path.join(fixture_dir, "check.sh"), "w") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        # The held-out overlay's check.sh requires real work (a solution file).
        with open(os.path.join(overlay_dir, "check.sh"), "w") as fh:
            fh.write("#!/bin/sh\ntest -f solution.txt\n")
        spec = {
            "schema_version": "1.0", "id": task_id, "source": "unit-test",
            "fixture": os.path.join("fixtures", task_id),
            "prompt": "do the thing",
            "acceptance": {
                "cmd": "sh check.sh", "timeout_s": 30,
                "overlay": os.path.join("acceptance", task_id),
            },
            "default_model": "mock-model", "agent_timeout_s": 60,
        }
        spec_path = os.path.join(self.tmp, "%s.json" % task_id)
        with open(spec_path, "w") as fh:
            json.dump(spec, fh)
        return spec_path

    def test_overlay_overrides_agent_tampered_test(self):
        # Cheating adapter: overwrites check.sh to always pass, does NOT solve.
        def cheating_adapter(workdir, spec, *, model="m", timeout=900, runner=None):
            with open(os.path.join(workdir, "check.sh"), "w") as fh:
                fh.write("#!/bin/sh\nexit 0\n")  # tamper
            return {
                "tool": "mock", "tool_version": "0.0.1", "model_used": model,
                "duration_s": 1.0, "exit_status": "completed",
                "provenance": {}, "cost_usd": None,
            }
        spec_path = self._make_overlay_task("cheat-task")
        row = runner.run_task(spec_path, "mock", trials=1, adapter=cheating_adapter)
        # Grader overlays the REAL check.sh (needs solution.txt) -> cheat fails.
        self.assertFalse(row["trials"][0]["success"])

    def test_overlay_passes_when_agent_actually_solves(self):
        def solving_adapter(workdir, spec, *, model="m", timeout=900, runner=None):
            with open(os.path.join(workdir, "solution.txt"), "w") as fh:
                fh.write("solved\n")
            return {
                "tool": "mock", "tool_version": "0.0.1", "model_used": model,
                "duration_s": 1.0, "exit_status": "completed",
                "provenance": {}, "cost_usd": None,
            }
        spec_path = self._make_overlay_task("solve-task")
        row = runner.run_task(spec_path, "mock", trials=1, adapter=solving_adapter)
        self.assertTrue(row["trials"][0]["success"])


class AdapterBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_adapter_that_judges_is_rejected(self):
        spec_path = _make_task(self.tmp, acceptance_cmd="true", task_id="judge-task")
        with self.assertRaises(ValueError) as ctx:
            runner.run_task(spec_path, "mock", trials=1,
                            adapter=mock_adapter_that_judges)
        self.assertIn("forbidden", str(ctx.exception).lower())

    def test_schema_rejects_each_forbidden_key(self):
        base = {
            "tool": "x", "tool_version": "1", "model_used": "m",
            "duration_s": 1.0, "exit_status": "completed", "provenance": {},
        }
        for k in ("success", "quality", "passed", "score", "verdict", "winner"):
            bad = dict(base)
            bad[k] = "anything"
            errs = schema.validate_adapter_output(bad)
            self.assertTrue(any("forbidden" in e.lower() for e in errs),
                            "expected %s to be rejected" % k)


class AggregationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_n_trial_aggregation(self):
        spec_path = _make_task(self.tmp, acceptance_cmd="true", task_id="agg-task")
        row = runner.run_task(spec_path, "mock", trials=3,
                              adapter=mock_adapter_with_cost)
        self.assertEqual(len(row["trials"]), 3)
        self.assertEqual(row["summary"]["n_trials"], 3)
        self.assertEqual(row["summary"]["n_success"], 3)
        self.assertEqual(row["summary"]["success_rate"], 1.0)
        # all durations 12.5 -> median/min/max == 12.5
        self.assertEqual(row["summary"]["duration_s_median"], 12.5)
        self.assertEqual(row["summary"]["duration_s_min"], 12.5)
        self.assertEqual(row["summary"]["duration_s_max"], 12.5)

    def test_cost_summary_and_per_solved(self):
        spec_path = _make_task(self.tmp, acceptance_cmd="true", task_id="cost-task")
        row = runner.run_task(spec_path, "mock", trials=2,
                              adapter=mock_adapter_with_cost)
        self.assertEqual(row["summary"]["cost_usd_median"], 0.42)
        # total cost 0.84 over 2 solved -> 0.42 per solved
        self.assertEqual(row["summary"]["cost_usd_per_solved"], 0.42)

    def test_zero_success_renders_not_vanishes(self):
        spec_path = _make_task(self.tmp, acceptance_cmd="false", task_id="zero-task")
        row = runner.run_task(spec_path, "mock", trials=3,
                              adapter=mock_adapter_with_cost)
        self.assertEqual(row["summary"]["n_success"], 0)
        self.assertEqual(row["summary"]["success_rate"], 0.0)
        # cost still recorded; per-solved is null (no solved trials)
        self.assertIsNone(row["summary"]["cost_usd_per_solved"])


class CostNullSemanticsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_cost_null_when_adapter_omits_tokens(self):
        spec_path = _make_task(self.tmp, acceptance_cmd="true", task_id="nocost-task")
        row = runner.run_task(spec_path, "mock", trials=2,
                              adapter=mock_adapter_no_cost)
        for t in row["trials"]:
            self.assertIsNone(t["cost_usd"])
            self.assertIsNone(t["adapter"]["tokens_in"])
            self.assertIsNone(t["adapter"]["tokens_out"])
        # summary cost is null, never coerced to 0
        self.assertIsNone(row["summary"]["cost_usd_median"])
        self.assertIsNone(row["summary"]["cost_usd_per_solved"])


class TaskHashTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_task_hash_recorded_and_deterministic(self):
        spec_path = _make_task(self.tmp, acceptance_cmd="true", task_id="hash-task")
        row1 = runner.run_task(spec_path, "mock", trials=1,
                               adapter=mock_adapter_with_cost)
        row2 = runner.run_task(spec_path, "mock", trials=1,
                               adapter=mock_adapter_with_cost)
        self.assertTrue(row1["task_hash"])
        self.assertEqual(len(row1["task_hash"]), 64)  # sha256 hex
        self.assertEqual(row1["task_hash"], row2["task_hash"])

    def test_task_hash_changes_with_fixture(self):
        spec_path = _make_task(self.tmp, acceptance_cmd="true", task_id="hash2-task")
        spec = runner.load_task(spec_path)
        fixture_dir = runner.resolve_fixture_dir(spec_path, spec)
        h1 = schema.compute_task_hash(spec, fixture_dir)
        # mutate the fixture; the hash must change
        with open(os.path.join(fixture_dir, "seed.txt"), "a") as fh:
            fh.write("changed\n")
        h2 = schema.compute_task_hash(spec, fixture_dir)
        self.assertNotEqual(h1, h2)

    def test_verify_round_trips(self):
        spec_path = _make_task(self.tmp, acceptance_cmd="true", task_id="verify-task")
        row = runner.run_task(spec_path, "mock", trials=1,
                              adapter=mock_adapter_with_cost)
        result_path = os.path.join(self.tmp, "result.json")
        with open(result_path, "w") as fh:
            json.dump(row, fh)
        report = runner.verify_result(result_path)
        # hash must match the inputs on disk (we did not touch them)
        self.assertTrue(report["hash_match"])
        self.assertEqual(report["stored_hash"], report["recomputed_hash"])

    def test_verify_detects_fixture_drift(self):
        spec_path = _make_task(self.tmp, acceptance_cmd="true", task_id="drift-task")
        row = runner.run_task(spec_path, "mock", trials=1,
                              adapter=mock_adapter_with_cost)
        result_path = os.path.join(self.tmp, "result.json")
        with open(result_path, "w") as fh:
            json.dump(row, fh)
        # drift the fixture after the run
        spec = runner.load_task(spec_path)
        fixture_dir = runner.resolve_fixture_dir(spec_path, spec)
        with open(os.path.join(fixture_dir, "seed.txt"), "a") as fh:
            fh.write("tampered\n")
        report = runner.verify_result(result_path)
        self.assertFalse(report["hash_match"])
        self.assertFalse(report["ok"])


class RealAdapterIntegrationTest(unittest.TestCase):
    """Drive the REAL Slice C loki adapter through the runner with an injected
    fake CLI runner -- no paid calls. Proves the runner<->adapter call
    convention (workdir, prompt_path, model=, timeout=, runner=) is correct and
    that the grader marks success/failure from the produced repo state.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-real-")
        # Import the real adapter the same way the runner's loader would.
        self.loki_adapter = runner.load_adapter("loki")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _fake_runner(self, marker_in_workdir):
        """Return a subprocess.run-compatible fake.

        It simulates the agent: when invoked for `loki start`, it creates the
        acceptance marker file in cwd. Version probes return a fixed string.
        """
        class _Proc:
            def __init__(self, rc=0, stdout="", stderr=""):
                self.returncode = rc
                self.stdout = stdout
                self.stderr = stderr

        def _run(cmd, cwd=None, capture_output=True, text=True,
                 timeout=None, env=None):
            argv = cmd if isinstance(cmd, list) else [cmd]
            joined = " ".join(str(a) for a in argv)
            if "version" in joined or "--version" in joined:
                return _Proc(0, stdout="loki 7.10.0")
            if "start" in joined and marker_in_workdir:
                # Simulate the agent producing repo state in the workdir.
                open(os.path.join(cwd, "agent-touched.txt"), "w").write("ok\n")
            return _Proc(0, stdout="done")
        return _run

    def test_runner_drives_real_loki_adapter_success(self):
        spec_path = _make_task(
            self.tmp, acceptance_cmd="test -f agent-touched.txt",
            task_id="real-pass")
        row = runner.run_task(
            spec_path, "loki", trials=1, adapter=self.loki_adapter,
            runner_fn=self._fake_runner(marker_in_workdir=True))
        self.assertEqual(row["tool"], "loki")
        self.assertEqual(row["trials"][0]["adapter"]["tool"], "loki")
        self.assertTrue(row["trials"][0]["success"])
        # Adapter output passed our validator (no forbidden keys).
        self.assertEqual(schema.validate_adapter_output(row["trials"][0]["adapter"]), [])

    def test_trial_records_advisor_calls_from_the_run(self):
        spec_path = _make_task(self.tmp, acceptance_cmd="test -f agent-touched.txt", task_id="adv-calls")
        base = self._fake_runner(marker_in_workdir=True)

        def with_advisor(cmd, cwd=None, **kw):
            if "start" in " ".join(str(a) for a in (cmd if isinstance(cmd, list) else [cmd])):
                os.makedirs(os.path.join(cwd, ".loki", "metrics"), exist_ok=True)
                with open(os.path.join(cwd, ".loki", "metrics", "result-cost-1.json"), "w") as fh:
                    json.dump({"total_cost_usd": 0.1, "advisor_calls": 4}, fh)
            return base(cmd, cwd=cwd, **kw)

        row = runner.run_task(spec_path, "loki", trials=1, adapter=self.loki_adapter, runner_fn=with_advisor)
        self.assertEqual(row["trials"][0]["advisor_calls"], 4)
        self.assertEqual(row["trials"][0]["advisor_errors"], 0)
        # No cost record at all: unknown (None), never 0.
        row = runner.run_task(spec_path, "loki", trials=1, adapter=self.loki_adapter,
                              runner_fn=self._fake_runner(marker_in_workdir=True))
        self.assertIsNone(row["trials"][0]["advisor_calls"])

    def test_runner_drives_real_loki_adapter_failure(self):
        # Agent does NOT produce the marker -> grader fails the trial.
        spec_path = _make_task(
            self.tmp, acceptance_cmd="test -f agent-touched.txt",
            task_id="real-fail")
        row = runner.run_task(
            spec_path, "loki", trials=1, adapter=self.loki_adapter,
            runner_fn=self._fake_runner(marker_in_workdir=False))
        self.assertFalse(row["trials"][0]["success"])


class ReproducibleTaskPathTest(unittest.TestCase):
    """A result for an in-repo task must store a REPO-RELATIVE task_path and
    verify from any cwd -- the #1 credibility rule (reproducible by a stranger
    who cloned the repo to a different location).
    """

    _DEMO = os.path.join(_REPO, "benchmarks", "bench", "tasks", "demo-pass.json")

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-repro-")
        self._cwd = os.getcwd()

    def tearDown(self):
        os.chdir(self._cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_in_repo_task_path_is_relative(self):
        row = runner.run_task(self._DEMO, "mock", trials=1,
                              adapter=mock_adapter_with_cost)
        self.assertFalse(os.path.isabs(row["task_path"]),
                         "in-repo task_path must be repo-relative, got %r"
                         % row["task_path"])
        self.assertTrue(row["task_path"].startswith("benchmarks/bench/tasks/"))

    def test_verify_works_after_chdir(self):
        row = runner.run_task(self._DEMO, "mock", trials=1,
                              adapter=mock_adapter_with_cost)
        result_path = os.path.join(self.tmp, "result.json")
        with open(result_path, "w") as fh:
            json.dump(row, fh)
        # Simulate a stranger: run verify from a totally different cwd.
        os.chdir(self.tmp)
        report = runner.verify_result(result_path)
        self.assertTrue(report["hash_match"],
                        "verify must relocate an in-repo task from any cwd: %s"
                        % report["problems"])


def mock_adapter_effort(workdir, spec, *, model="mock-model", timeout=900,
                        runner=None, effort=None):
    """An adapter that can apply an effort level; echoes it in provenance."""
    out = mock_adapter_with_cost(workdir, spec, model=model, timeout=timeout)
    out["provenance"] = {"command": "mock --effort %s" % effort, "verified": True}
    return out


def mock_adapter_strict(workdir, spec, *, model="mock-model", timeout=900):
    """Rejects any extra kwarg: proves the default path passes no effort."""
    return mock_adapter_with_cost(workdir, spec, model=model, timeout=timeout)


class EffortAxisTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-effort-")
        self.spec_path = _make_task(self.tmp, acceptance_cmd="true",
                                    task_id="effort-task")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_each_effort_level_emits_a_row_with_the_effort_field(self):
        rows = [runner.run_task(self.spec_path, "mock", trials=1,
                                adapter=mock_adapter_effort, effort=lv)
                for lv in runner.parse_efforts("high,medium")]
        self.assertEqual([r["effort"] for r in rows], ["high", "medium"])
        self.assertIn("mock --effort high",
                      rows[0]["trials"][0]["adapter"]["provenance"]["command"])

    def test_cli_effort_list_writes_one_row_file_per_level(self):
        out = os.path.join(self.tmp, "res.json")
        old_load, old_env = runner.load_adapter, os.environ.get("LOKI_BENCH_SPEND_APPROVED")
        runner.load_adapter = lambda name: mock_adapter_effort
        os.environ["LOKI_BENCH_SPEND_APPROVED"] = "1"
        try:
            rc = runner._main(["run", self.spec_path, "--adapter", "mock",
                               "--trials", "1", "--effort", "high,medium",
                               "--out", out])
        finally:
            runner.load_adapter = old_load
            if old_env is None:
                os.environ.pop("LOKI_BENCH_SPEND_APPROVED", None)
            else:
                os.environ["LOKI_BENCH_SPEND_APPROVED"] = old_env
        self.assertEqual(rc, 0)
        got = {}
        for lv in ("high", "medium"):
            with open(os.path.join(self.tmp, "res-effort-%s.json" % lv)) as fh:
                got[lv] = json.load(fh)["effort"]
        self.assertEqual(got, {"high": "high", "medium": "medium"})

    def _sweep_catalog(self):
        cat = os.path.join(self.tmp, "cat.json")
        with open(cat, "w") as fh:
            json.dump({"providers": {"claude": {"cli_aliases": {"mini": "m-gap"}, "models": [
                {"id": "m-gap", "alias": "mini", "effort": {"levels": ["high", "low", "max"]}},
                {"id": "m-none", "effort": {"levels": []}}]}}}, fh)
        return cat

    def test_effort_sweep_expands_to_the_catalog_levels_low_to_max(self):
        old = os.environ.get("LOKI_MODEL_CATALOG")
        os.environ["LOKI_MODEL_CATALOG"] = self._sweep_catalog()
        try:
            self.assertEqual(runner.parse_efforts("sweep", "m-gap"), ["low", "high", "max"])
            self.assertEqual(runner.parse_efforts("sweep", "mini"), ["low", "high", "max"])
            for model in (None, "m-none", "unknown"):
                with self.assertRaises(ValueError):
                    runner.parse_efforts("sweep", model)
        finally:
            if old is None:
                os.environ.pop("LOKI_MODEL_CATALOG", None)
            else:
                os.environ["LOKI_MODEL_CATALOG"] = old

    def test_cli_effort_sweep_writes_one_row_per_listed_level(self):
        out = os.path.join(self.tmp, "sw.json")
        saved = {k: os.environ.get(k) for k in ("LOKI_MODEL_CATALOG", "LOKI_BENCH_SPEND_APPROVED")}
        old_load = runner.load_adapter
        runner.load_adapter = lambda name: mock_adapter_effort
        os.environ["LOKI_MODEL_CATALOG"] = self._sweep_catalog()
        os.environ["LOKI_BENCH_SPEND_APPROVED"] = "1"
        try:
            rc = runner._main(["run", self.spec_path, "--adapter", "mock", "--trials", "1",
                               "--model", "m-gap", "--effort", "sweep", "--out", out])
        finally:
            runner.load_adapter = old_load
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.assertEqual(rc, 0)
        for lv in ("low", "high", "max"):
            with open(os.path.join(self.tmp, "sw-effort-%s.json" % lv)) as fh:
                self.assertEqual(json.load(fh)["effort"], lv)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "sw-effort-medium.json")))

    def test_default_run_has_no_effort_axis(self):
        # Golden: adapter called with no effort kwarg (strict adapter would
        # TypeError) and the row key set is exactly the pre-effort shape.
        row = runner.run_task(self.spec_path, "mock", trials=1,
                              adapter=mock_adapter_strict)
        self.assertEqual(sorted(row), sorted([
            "schema_version", "task_id", "task_path", "task_hash", "harness_sig",
            "tool", "model", "trials", "summary"]))

    def test_adapter_without_effort_support_is_refused(self):
        with self.assertRaises(ValueError):
            runner.run_task(self.spec_path, "mock", trials=1,
                            adapter=mock_adapter_strict, effort="high")

    def test_invalid_effort_is_refused(self):
        with self.assertRaises(ValueError):
            runner.parse_efforts("high,turbo")
        with self.assertRaises(ValueError):
            runner.run_task(self.spec_path, "mock", trials=1,
                            adapter=mock_adapter_effort, effort="turbo")

    def test_claude_code_adapter_passes_effort_flag(self):
        from adapters import claude_code
        cmds = []

        def fake(cmd, **kw):
            cmds.append(cmd)

            class R:
                returncode = 0
                stdout = "{}"
                stderr = ""
            return R()
        for eff in ("high", None):
            claude_code.run(self.tmp, "spec.md", model="sonnet", timeout=5,
                            runner=fake, effort=eff)
        main_cmds = [c for c in cmds if "-p" in c]
        self.assertEqual(main_cmds[0][main_cmds[0].index("--effort") + 1], "high")
        self.assertNotIn("--effort", main_cmds[1])


class WrongPassCaptureTest(unittest.TestCase):
    """P4(b): a VERIFIED verdict with a failing held-out grader is a wrong pass."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-wp-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _row(self, accept, verdict, task_id="wp-task"):
        spec = _make_task(self.tmp, acceptance_cmd=accept, task_id=task_id)
        return runner.run_task(spec, "mock", trials=1, adapter=mock_adapter_with_cost,
                               model="floor-model", verify_fn=lambda wd, model: verdict)

    def test_verified_with_failing_grader_is_wrong_pass(self):
        seal = self._row("false", "VERIFIED")["trials"][0]["seal"]
        self.assertEqual(seal["verdict"], "VERIFIED")
        self.assertIs(seal["grader_pass"], False)
        self.assertIs(seal["wrong_pass"], True)
        self.assertEqual(seal["model"], "floor-model")

    def test_verified_with_passing_grader_is_not_wrong_pass(self):
        self.assertIs(self._row("true", "VERIFIED")["trials"][0]["seal"]["wrong_pass"], False)

    def test_blocked_with_failing_grader_is_not_wrong_pass(self):
        self.assertIs(self._row("false", "BLOCKED")["trials"][0]["seal"]["wrong_pass"], False)

    def test_missing_verdict_is_unmeasured_never_a_pass(self):
        seal = self._row("false", None)["trials"][0]["seal"]
        self.assertIsNone(seal["verdict"])
        self.assertIsNone(seal["wrong_pass"])

    def test_no_verify_fn_adds_no_seal_key(self):
        spec = _make_task(self.tmp, acceptance_cmd="true", task_id="plain")
        row = runner.run_task(spec, "mock", trials=1, adapter=mock_adapter_with_cost)
        self.assertNotIn("seal", row["trials"][0])

    def test_summary_is_measure_schema_and_skips_unmeasured(self):
        rows = [self._row("false", "VERIFIED", "t1"), self._row("true", "VERIFIED", "t2"),
                self._row("false", None, "t3")]
        doc = runner.wrong_pass_results(rows, "floor", "floor-model")
        self.assertEqual(doc["schema"], "loki.seeded-defects.results/v2")
        run = doc["runs"][0]
        self.assertEqual((run["setup"], run["model"], run["n"], run["wrong_pass"]),
                         ("floor", "floor-model", 2, 1))
        self.assertEqual(run["outcomes"], {"t1": "SEALED", "t2": "NOT_SEALED"})
        self.assertEqual(run["unmeasured"], ["t3"])
        self.assertEqual(len(run["records"]), 3)

    def test_default_verify_is_unmeasured_without_spend_approval(self):
        old = os.environ.pop("LOKI_BENCH_SPEND_APPROVED", None)
        try:
            self.assertIsNone(runner.default_verify(self.tmp, "m"))
        finally:
            if old is not None:
                os.environ["LOKI_BENCH_SPEND_APPROVED"] = old

    def test_two_trials_one_unmeasured_is_unmeasured_not_not_sealed(self):
        spec = _make_task(self.tmp, acceptance_cmd="true", task_id="mixed")
        seq = iter(["CONCERNS", None])
        row = runner.run_task(spec, "mock", trials=2, adapter=mock_adapter_with_cost,
                              verify_fn=lambda wd, m: next(seq))
        run = runner.wrong_pass_results([row], "floor", "m")["runs"][0]
        self.assertEqual(run["outcomes"], {})
        self.assertEqual(run["unmeasured"], ["mixed"])
        self.assertEqual(run["n"], 0)

    def test_two_trials_one_wrong_pass_one_unmeasured_stays_sealed(self):
        spec = _make_task(self.tmp, acceptance_cmd="false", task_id="mixed2")
        seq = iter([None, "VERIFIED"])
        row = runner.run_task(spec, "mock", trials=2, adapter=mock_adapter_with_cost,
                              verify_fn=lambda wd, m: next(seq))
        run = runner.wrong_pass_results([row], "floor", "m")["runs"][0]
        self.assertEqual(run["outcomes"], {"mixed2": "SEALED"})
        self.assertEqual(run["unmeasured"], [])

    def test_cli_refuses_effort_with_wrong_pass_out(self):
        spec = _make_task(self.tmp, acceptance_cmd="true", task_id="eff")
        rc = runner._main(["run", spec, "--adapter", "mock", "--model", "m", "--effort", "high",
                           "--seal-verify", "--setup", "top",
                           "--wrong-pass-out", os.path.join(self.tmp, "o.json")])
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "o.json")))

    def test_write_refuses_corpus_results_path_and_leaves_no_tmp(self):
        corpus = os.path.join(_REPO, "benchmarks", "seeded-defects", "results", "wrong-pass.json")
        with self.assertRaises(ValueError):
            runner.write_wrong_pass([], "top", "m", corpus)
        out = os.path.join(self.tmp, "ok.json")
        runner.write_wrong_pass([], "top", "m", out)
        self.assertEqual(os.listdir(self.tmp), ["ok.json"])

    def test_cli_writes_wrong_pass_file_with_stub_verify(self):
        spec = _make_task(self.tmp, acceptance_cmd="false", task_id="cli-task")
        out = os.path.join(self.tmp, "wp.json")
        row = runner.run_task(spec, "mock", trials=1, adapter=mock_adapter_with_cost,
                              verify_fn=lambda wd, m: "VERIFIED")
        runner.write_wrong_pass([row], "top", "m", out)
        with open(out) as fh:
            self.assertEqual(json.load(fh)["runs"][0]["wrong_pass"], 1)


def _stage_adapter(review_outcome):
    def adapter(workdir, spec, *, model="mock-model", timeout=900, runner=None):
        out = mock_adapter_with_cost(workdir, spec, model=model)
        out["stages"] = {"review": {"model": "rev-model", "outcome": review_outcome}}
        return out
    return adapter


class StageOutcomesTest(unittest.TestCase):
    """Wall-author and review-stage outcomes by model: schema only, informational."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-stage-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, adapter, trials=2):
        spec = _make_task(self.tmp, acceptance_cmd="true", task_id="st")
        row = runner.run_task(spec, "mock", trials=trials, adapter=adapter, model="floor-model",
                              verify_fn=lambda wd, m: "VERIFIED")
        return runner.wrong_pass_results([row], "floor", "floor-model")["runs"][0]

    def test_review_data_gives_per_model_counts(self):
        seq = iter(["approved", "rejected"])
        def adapter(workdir, spec, **kw):
            return _stage_adapter(next(seq))(workdir, spec, **kw)
        so = self._run(adapter)["stage_outcomes"]
        self.assertEqual(so["review"]["by_model"],
                         {"rev-model": {"n": 2, "outcomes": {"approved": 1, "rejected": 1}}})
        self.assertIsNone(so["review"]["reason"])
        self.assertIsNone(so["wall_author"]["by_model"])

    def test_absent_data_is_unmeasured_not_zero(self):
        so = self._run(mock_adapter_with_cost)["stage_outcomes"]
        for stage in ("wall_author", "review"):
            self.assertIsNone(so[stage]["by_model"])
            self.assertIn("unmeasured", so[stage]["reason"])

    def test_empty_or_non_string_record_is_dropped_and_counted(self):
        bad = [{"model": "", "outcome": "approved"},
               {"model": "rev-model", "outcome": ""},
               {"model": 7, "outcome": "approved"},
               {"model": "rev-model", "outcome": None}]
        for rec in bad:
            self.assertEqual(runner.stage_records({"stages": {"review": rec}}), {})
        seq = iter(bad[:2])
        def adapter(workdir, spec, **kw):
            out = mock_adapter_with_cost(workdir, spec, **kw)
            out["stages"] = {"review": next(seq)}
            return out
        so = self._run(adapter)["stage_outcomes"]
        self.assertIsNone(so["review"]["by_model"])
        self.assertEqual(so["review"]["trials_without_record"], 2)
        self.assertIn("unmeasured", so["review"]["reason"])

    def test_partial_stage_reports_missing_count_with_no_reason(self):
        seq = iter([True, False])
        def adapter(workdir, spec, **kw):
            if next(seq):
                return _stage_adapter("approved")(workdir, spec, **kw)
            return mock_adapter_with_cost(workdir, spec, **kw)
        so = self._run(adapter)["stage_outcomes"]
        self.assertEqual(so["review"]["by_model"],
                         {"rev-model": {"n": 1, "outcomes": {"approved": 1}}})
        self.assertEqual(so["review"]["trials_without_record"], 1)
        self.assertIsNone(so["review"]["reason"])


class CollectEfficiencyFallbackTest(unittest.TestCase):
    def test_collect_efficiency_returns_proof_shape(self):
        # With no efficiency files, usd must be None (not 0) and the shape must
        # match proof-generator's. Uses an empty temp loki dir.
        tmp = tempfile.mkdtemp(prefix="bench-eff-")
        try:
            cost, model = runner.collect_efficiency(tmp)
            self.assertIn("usd", cost)
            self.assertIn("input_tokens", cost)
            self.assertIn("output_tokens", cost)
            self.assertIn("cache_read_tokens", cost)
            self.assertIn("cache_creation_tokens", cost)
            self.assertIsNone(cost["usd"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def _arm_adapter(tool, log, writes=True):
    """A mock arm that logs its call order and (optionally) edits a file."""
    def _run(workdir, spec, *, model="mock-model", timeout=900, runner=None):
        log.append(tool)
        if writes:
            with open(os.path.join(workdir, "seed.txt"), "a") as fh:
                fh.write(tool + "\n")
        return {"tool": tool, "tool_version": "1.0", "model_used": model,
                "duration_s": 2.0, "iterations": 1, "tokens_in": 1, "tokens_out": 1,
                "cost_usd": 0.1, "exit_status": "completed", "provenance": {}}
    return _run


class ArmsInterleaveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bench-arms-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _tasks(self):
        return [_make_task(self.tmp, acceptance_cmd="true", task_id=t) for t in ("task-a", "task-b")]

    def test_interleaved_order_same_base_and_valid_rows(self):
        log = []
        arms = ["loki-lean", "claude_code", "loki"]
        out = runner.run_arms(self._tasks(), arms, reps=2,
                              adapters={a: _arm_adapter(a, log) for a in arms})
        # task order kept; within a task each rep runs every arm once, rotated.
        rot = lambda n: arms[n:] + arms[:n]  # noqa: E731
        # Latin-square rotation per (task, rep): offsets 0,1 for task-a, 2,0 for task-b.
        self.assertEqual(log, rot(0) + rot(1) + rot(2) + rot(0))
        self.assertEqual([(x["task_id"], x["rep"], x["arm"], x["position"]) for x in out["schedule"]][:6],
                         [("task-a", 1, "loki-lean", 0), ("task-a", 1, "claude_code", 1), ("task-a", 1, "loki", 2),
                          ("task-a", 2, "claude_code", 0), ("task-a", 2, "loki", 1), ("task-a", 2, "loki-lean", 2)])
        first = [x["arm"] for x in out["schedule"] if x["position"] == 0]
        self.assertGreater(len(set(first)), 1)
        self.assertEqual(len(out["rows"]), 6)
        for row in out["rows"]:
            self.assertEqual(schema.validate_result_row(row), [])
            self.assertEqual([t["trial"] for t in row["trials"]], [1, 2])
        # one frozen base tree per task, shared by every arm and every trial.
        for tid in ("task-a", "task-b"):
            trees = {t["base_tree"] for r in out["rows"] if r["task_id"] == tid for t in r["trials"]}
            self.assertEqual(len(trees), 1)
            self.assertNotIn(None, trees)

    def test_files_changed_is_measured_by_the_harness(self):
        log = []
        out = runner.run_arms(self._tasks()[:1], ["claude_code", "loki-lean"], reps=1, adapters={
            "claude_code": _arm_adapter("claude_code", log, writes=True),
            "loki-lean": _arm_adapter("loki-lean", log, writes=False)})
        by = {r["tool"]: r["trials"][0]["adapter"]["files_changed"] for r in out["rows"]}
        self.assertEqual(by, {"claude_code": 1, "loki-lean": 0})

    def test_base_mismatch_is_caught_after_rep_one(self):
        log = []
        calls = {"n": 0}
        real = runner._base_tree

        def drifting(workdir):
            calls["n"] += 1
            return "tree-%d" % (calls["n"] % 2)
        runner._base_tree = drifting
        try:
            with self.assertRaises(ValueError):
                runner.run_arms(self._tasks()[:1], ["claude_code", "loki-lean"], reps=3, adapters={
                    "claude_code": _arm_adapter("claude_code", log), "loki-lean": _arm_adapter("loki-lean", log)})
        finally:
            runner._base_tree = real
        self.assertEqual(len(log), 2)

    def test_named_arms_are_spend_gated(self):
        os.environ.pop("LOKI_BENCH_SPEND_APPROVED", None)
        with self.assertRaises(RuntimeError):
            runner.run_arms(self._tasks()[:1], ["loki-lean", "claude_code"], reps=1)

    def test_parent_lean_env_is_refused_for_the_plain_arm(self):
        os.environ["LOKI_LEAN"] = "1"
        try:
            with self.assertRaises(ValueError):
                runner.run_arms(self._tasks()[:1], ["loki", "claude_code"], reps=1,
                                adapters={"loki": _arm_adapter("loki", []), "claude_code": _arm_adapter("claude_code", [])})
        finally:
            del os.environ["LOKI_LEAN"]

    def test_lean_arm_loads_the_loki_adapter_entrypoint(self):
        self.assertEqual(runner.load_adapter("loki-lean").__name__, "run_lean")
        self.assertEqual(runner.load_adapter("loki").__name__, "run")


if __name__ == "__main__":
    unittest.main()
