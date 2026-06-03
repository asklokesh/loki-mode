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


if __name__ == "__main__":
    unittest.main()
