"""#348 (CW-15): per-trial false-pass, council cache share and journal reuse
metrics, each with a positive control that can make the metric fire. Fake
adapters only; no model call. Run: python3 -m pytest benchmarks/bench/tests/test_trial_metrics.py"""
import os
import json
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import bench_schema as schema  # noqa: E402
import runner  # noqa: E402
from adapters import _base, loki  # noqa: E402

_SPEC = {"id": "t", "prompt": "make ok", "acceptance": {"cmd": "test -f ok", "timeout_s": 10}}


def _fake(tool, *, writes, exit_status="completed", prov=None):
    def adapter(workdir, prompt_path, **kw):
        if writes:
            open(os.path.join(workdir, "ok"), "w").close()
        return _base.build_output(
            tool=tool, tool_version="1", model_used="m", duration_s=1.0,
            iterations=1, tokens_in=1, tokens_out=1, cost_usd=0.01,
            exit_status=exit_status, provenance=prov or {})
    return adapter


class TrialMetricsTest(unittest.TestCase):
    def setUp(self):
        self.fix = tempfile.mkdtemp(prefix="loki-bench-fixture-")
        open(os.path.join(self.fix, "seed"), "w").close()

    def tearDown(self):
        shutil.rmtree(self.fix, ignore_errors=True)

    def _row(self, adapter, tool):
        return runner.run_trial(adapter, _SPEC, self.fix, "m", tool, 1)

    def test_schema_pin(self):
        row = self._row(_fake("claude_code", writes=True), "claude_code")
        self.assertEqual(tuple(row["metrics"]), schema.TRIAL_METRIC_KEYS)

    def test_false_pass_control_fires(self):
        # Claims VERIFIED, produces nothing: the grader fails it.
        a = _fake("loki", writes=False, prov={"verify_verdict": "VERIFIED"})
        m = self._row(a, "loki")["metrics"]
        self.assertIs(m["claimed_done"], True)
        self.assertIs(m["false_pass"], True)

    def test_false_pass_clean_claim_is_false(self):
        a = _fake("loki", writes=True, prov={"verify_verdict": "VERIFIED"})
        self.assertIs(self._row(a, "loki")["metrics"]["false_pass"], False)

    def test_loki_partial_is_not_a_claim(self):
        a = _fake("loki", writes=False, exit_status="error_rc_1",
                  prov={"verify_verdict": "PARTIAL"})
        m = self._row(a, "loki")["metrics"]
        self.assertIs(m["claimed_done"], False)
        self.assertIsNone(m["false_pass"])

    def test_other_tool_clean_exit_is_a_claim(self):
        m = self._row(_fake("claude_code", writes=False), "claude_code")["metrics"]
        self.assertIs(m["false_pass"], True)

    def test_unmeasured_trial_has_no_claim(self):
        a = _fake("claude_code", writes=True, exit_status="timeout")
        m = self._row(a, "claude_code")["metrics"]
        self.assertIsNone(m["claimed_done"])
        self.assertIsNone(m["false_pass"])

    def test_council_cache_share_control(self):
        phases = {"main_session": {"cache_read": 900, "cache_creation": 0},
                  "council": {"cache_read": 80, "cache_creation": 10, "input": 10},
                  "reviewer": {"cache_read": 20, "cache_creation": 0, "input": 80}}
        self.assertEqual(schema.council_cache_share(phases), 0.5)

    def test_council_cache_share_none_vs_zero(self):
        self.assertIsNone(schema.council_cache_share(
            {"main_session": {"cache_read": 5, "cache_creation": 5}}))
        self.assertIsNone(schema.council_cache_share(None))
        self.assertEqual(schema.council_cache_share(
            {"review": {"cache_read": 0, "cache_creation": 10, "input": 10}}), 0.0)

    def test_journal_reuse_control(self):
        a = _fake("loki", writes=True, prov={"journal_reuse_wall_s": 12.5})
        self.assertEqual(self._row(a, "loki")["metrics"]["journal_reuse_wall_s"], 12.5)
        b = _fake("loki", writes=True)
        self.assertIsNone(self._row(b, "loki")["metrics"]["journal_reuse_wall_s"])


class CachePassThroughTest(unittest.TestCase):
    def test_build_output_keeps_cache_tokens(self):
        out = _base.build_output(
            tool="loki", tool_version="1", model_used="m", duration_s=1,
            iterations=1, tokens_in=1, tokens_out=1, cost_usd=0.1,
            exit_status="completed", provenance={},
            cache_read_tokens=41472, cache_creation_tokens=17702)
        norm = schema.normalize_adapter_output(out)
        self.assertEqual(norm["cache_read_tokens"], 41472)
        self.assertEqual(norm["cache_creation_tokens"], 17702)

    def test_unknown_cache_stays_default(self):
        out = _base.build_output(
            tool="x", tool_version="1", model_used="m", duration_s=1,
            iterations=1, tokens_in=1, tokens_out=1, cost_usd=0.1,
            exit_status="completed", provenance={})
        self.assertEqual(schema.normalize_adapter_output(out)["cache_read_tokens"], 0)

    def test_phase_split_carries_input_tokens(self):
        class Eff:
            @staticmethod
            def read_child_ledger(_d):
                return [{"phase": "council", "cache_read_tokens": 8,
                         "cache_creation_tokens": 1, "input_tokens": 1}], 0
        got = loki._cache_tokens_by_phase(
            "x", {"cache_read_tokens": 10, "cache_creation_tokens": 2}, Eff)
        self.assertEqual(got["council"], {"cache_read": 8, "cache_creation": 1, "input": 1})
        self.assertEqual(got["main_session"], {"cache_read": 2, "cache_creation": 1})



def _cp(cmd, rc=0, out=""):
    return subprocess.CompletedProcess(cmd, rc, out, "")


class InterruptRunnerTest(unittest.TestCase):
    """The deterministic stop point, real subprocess, no model."""

    SCRIPT = ("import sys,time\nprint('[wall] go',flush=True)\n"
              "print('[implement] x  (wall done 3s)',flush=True)\n"
              "time.sleep(30)\nprint('never')\n")

    def test_stops_at_marker_and_keeps_prior_output(self):
        t0 = __import__("time").time()
        rc, out, err, status, dur = _base.run_cli(
            [sys.executable, "-c", self.SCRIPT], cwd=os.getcwd(), timeout=60,
            stop_marker=r"\(wall done")
        self.assertEqual(status, "interrupted")
        self.assertIn("(wall done", out)
        self.assertNotIn("never", out)
        self.assertLess(__import__("time").time() - t0, 20)

    def test_control_without_marker_runs_to_completion(self):
        rc, out, err, status, dur = _base.run_cli(
            [sys.executable, "-c", "print('done')"], cwd=os.getcwd(), timeout=60,
            stop_marker=r"\(wall done")
        self.assertEqual((status, rc), ("completed", 0))

    def test_heavy_stderr_before_marker_does_not_block_the_marker(self):
        # >64KB on stderr before the marker used to fill the unread pipe, so the
        # child never reached the marker and the leg was recorded as a timeout.
        script = ("import sys,time\nsys.stderr.write('e'*300000)\nsys.stderr.flush()\n"
                  "print('STAGE_DONE',flush=True)\ntime.sleep(30)\n")
        rc, out, err, status, dur = _base.run_cli(
            [sys.executable, "-c", script], cwd=os.getcwd(), timeout=8,
            stop_marker="STAGE_DONE")
        self.assertEqual(status, "interrupted")
        self.assertIn("STAGE_DONE", out)
        self.assertEqual(len(err), 300000)

    def test_fake_runner_output_cut_at_marker(self):
        def fake(cmd, **kw):
            return _cp(cmd, 0, "a\n(wall done 1s)\nb\n")
        rc, out, err, status, dur = _base.run_cli(
            ["x"], cwd=".", timeout=5, runner=fake, stop_marker=r"\(wall done")
        self.assertEqual(status, "interrupted")
        self.assertNotIn("b", out.split("done")[-1])


def _eff(d, n, usd):
    eff = os.path.join(d, ".loki", "metrics", "efficiency")
    os.makedirs(eff, exist_ok=True)
    with open(os.path.join(eff, "iteration-%d.json" % n), "w") as fh:
        json.dump({"cost_usd": usd, "input_tokens": 10, "output_tokens": 5,
                   "model": "claude-sonnet-5"}, fh)


class LokiResumeLegsTest(unittest.TestCase):
    def _run(self, **kw):
        d = tempfile.mkdtemp(prefix="loki-resume-test-")
        pf = os.path.join(d, "p.md")
        open(pf, "w").write("x")
        calls = []

        def fake(cmd, **k):
            calls.append(cmd[1:3])
            if cmd[1:2] == ["start"] and "--resume" not in cmd:
                _eff(d, 1, 1.0)
                return _cp(cmd, 0, "[00:01] intake      done   1s   a\n[00:03] wall        done   3s   b\nOutcome: VERIFIED\n")
            if cmd[1:3] == ["start", "--resume"]:
                _eff(d, 2, 0.5)
                return _cp(cmd, 0, "Outcome: VERIFIED\n")
            return _cp(cmd, 0, "Loki Mode v0.0.0\n")
        try:
            res = loki.run(d, pf, model="claude-sonnet-5", timeout=5,
                           runner=fake, **kw)
        finally:
            shutil.rmtree(d, ignore_errors=True)
        return res, calls

    def test_interrupted_run_records_both_legs(self):
        res, calls = self._run(interrupt_after_stage="wall")
        r = res["provenance"]["resume"]
        self.assertTrue(r["killed"])
        self.assertIn(["start", "--resume"], calls)
        self.assertEqual(r["leg1_usd"], 1.0)
        self.assertEqual(r["leg2_usd"], 0.5)
        self.assertEqual(res["provenance"]["journal_reuse_wall_s"], r["leg2_s"])
        self.assertEqual(res["cost_usd"], 1.5)

    def test_control_has_no_resume(self):
        res, calls = self._run()
        self.assertIsNone(res["provenance"]["resume"])
        self.assertIsNone(res["provenance"]["journal_reuse_wall_s"])
        self.assertNotIn(["start", "--resume"], calls)

    def test_stage_never_reached_means_no_resume_leg(self):
        res, calls = self._run(interrupt_after_stage="plan")
        self.assertFalse(res["provenance"]["resume"]["killed"])
        self.assertNotIn(["start", "--resume"], calls)


def _row(success, usd, secs, tin=100, tout=50, resume=None):
    return {"success": success, "cost_usd": usd, "duration_s": secs,
            "adapter": {"tokens_in": tin, "tokens_out": tout,
                        "provenance": {"resume": resume}}}


class ResumeCostTest(unittest.TestCase):
    KILLED = {"killed": True, "leg1_usd": 0.4}

    def test_overhead_is_positive_control(self):
        m = schema.resume_cost(_row(True, 1.0, 100.0),
                               _row(True, 1.3, 150.0, 130, 70, self.KILLED))
        self.assertEqual((m["extra_s"], m["extra_usd"], m["extra_tokens"]),
                         (50.0, 0.3, 50))
        self.assertTrue(m["reached_done"] and m["killed"] and m["extra_usd_complete"])

    def test_lost_work_cannot_read_as_cheap(self):
        m = schema.resume_cost(_row(True, 1.0, 100.0),
                               _row(False, 0.2, 10.0, resume=self.KILLED))
        self.assertLess(m["extra_usd"], 0)
        self.assertFalse(m["reached_done"])

    def test_unknown_is_none_not_zero(self):
        m = schema.resume_cost(_row(True, None, 100.0),
                               _row(True, 1.0, 120.0, resume={"killed": True, "leg1_usd": None}))
        self.assertIsNone(m["extra_usd"])
        self.assertFalse(m["extra_usd_complete"])

    def test_not_killed_says_so(self):
        m = schema.resume_cost(_row(True, 1.0, 100.0),
                               _row(True, 1.0, 100.0, resume={"killed": False}))
        self.assertFalse(m["killed"])

    def test_pair_runner_end_to_end_with_fake_adapter(self):
        fix = tempfile.mkdtemp(prefix="loki-bench-fixture-")
        open(os.path.join(fix, "seed"), "w").close()
        task = tempfile.mkdtemp(prefix="loki-bench-task-")
        with open(os.path.join(task, "t.json"), "w") as fh:
            json.dump({**_SPEC, "fixture": fix, "agent_timeout_s": 5,
                       "source": "test", "default_model": "m"}, fh)

        def adapter(workdir, prompt_path, **kw):
            killed = "interrupt_after_stage" in kw
            open(os.path.join(workdir, "ok"), "w").close()
            return _base.build_output(
                tool="loki", tool_version="1", model_used="m",
                duration_s=30.0 if killed else 20.0, iterations=1,
                tokens_in=15 if killed else 10, tokens_out=5,
                cost_usd=0.15 if killed else 0.1, exit_status="completed",
                provenance={"resume": {"killed": killed, "leg1_usd": 0.05}
                            if killed else None})
        try:
            res = runner.run_resume_pair(os.path.join(task, "t.json"), "loki",
                                         interrupt="wall", adapter=adapter)
        finally:
            shutil.rmtree(fix, ignore_errors=True)
            shutil.rmtree(task, ignore_errors=True)
        rc = res["pairs"][0]["resume_cost"]
        self.assertEqual((rc["extra_s"], rc["extra_usd"], rc["extra_tokens"]),
                         (10.0, 0.05, 5))
        self.assertTrue(rc["killed"] and rc["reached_done"])


class KeptWorkdirTest(unittest.TestCase):
    """LOKI_BENCH_WORKDIRS keeps <root>/<tool>/<task>/<label>/ for trust_time."""

    def setUp(self):
        self.fix = tempfile.mkdtemp(prefix="loki-bench-fixture-")
        open(os.path.join(self.fix, "seed"), "w").close()
        self.root = tempfile.mkdtemp(prefix="loki-bench-kept-")
        self._old = os.environ.pop("LOKI_BENCH_WORKDIRS", None)

    def tearDown(self):
        os.environ.pop("LOKI_BENCH_WORKDIRS", None)
        if self._old is not None:
            os.environ["LOKI_BENCH_WORKDIRS"] = self._old
        shutil.rmtree(self.fix, ignore_errors=True)
        shutil.rmtree(self.root, ignore_errors=True)

    def test_kept_at_tool_task_trial_when_env_set(self):
        os.environ["LOKI_BENCH_WORKDIRS"] = self.root
        runner.run_trial(_fake("claude_code", writes=True), _SPEC, self.fix, "m", "claude_code", 2)
        kept = os.path.join(self.root, "claude_code", "t", "2")
        self.assertTrue(os.path.isfile(os.path.join(kept, "ok")))
        self.assertTrue(os.path.isfile(os.path.join(kept, "seed")))

    def test_nothing_kept_without_env(self):
        # Negative control: the default still cleans up, nothing lands in root.
        runner.run_trial(_fake("claude_code", writes=True), _SPEC, self.fix, "m", "claude_code", 1)
        self.assertEqual(os.listdir(self.root), [])

    def test_existing_kept_dir_is_refused(self):
        os.environ["LOKI_BENCH_WORKDIRS"] = self.root
        runner.run_trial(_fake("loki", writes=True), _SPEC, self.fix, "m", "loki", 1)
        with self.assertRaises(ValueError):
            runner.run_trial(_fake("loki", writes=True), _SPEC, self.fix, "m", "loki", 1)

    def test_resume_pair_keeps_control_and_interrupted_apart(self):
        os.environ["LOKI_BENCH_WORKDIRS"] = self.root
        task = tempfile.mkdtemp(prefix="loki-bench-task-")
        with open(os.path.join(task, "t.json"), "w") as fh:
            json.dump({**_SPEC, "fixture": self.fix, "agent_timeout_s": 5,
                       "source": "test", "default_model": "m"}, fh)
        try:
            runner.run_resume_pair(os.path.join(task, "t.json"), "claude_code",
                                   interrupt=30, adapter=_fake("claude_code", writes=True))
        finally:
            shutil.rmtree(task, ignore_errors=True)
        base = os.path.join(self.root, "claude_code", "t")
        self.assertEqual(sorted(os.listdir(base)), ["1", "control-1"])


class EngineShaTest(unittest.TestCase):
    """Each loki row names the engine checkout it ran, not the harness branch."""

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="loki-bench-engine-")
        os.makedirs(os.path.join(self.d, "bin"))
        open(os.path.join(self.d, "bin", "loki"), "w").close()
        self._old = os.environ.get("LOKI_BENCH_LOKI_BIN")
        os.environ["LOKI_BENCH_LOKI_BIN"] = os.path.join(self.d, "bin", "loki")

    def tearDown(self):
        if self._old is None:
            os.environ.pop("LOKI_BENCH_LOKI_BIN", None)
        else:
            os.environ["LOKI_BENCH_LOKI_BIN"] = self._old
        shutil.rmtree(self.d, ignore_errors=True)

    def test_sha_of_the_binarys_checkout(self):
        g = ["git", "-C", self.d, "-c", "user.name=t", "-c", "user.email=t@l"]
        subprocess.run(["git", "-C", self.d, "init", "-q"], check=True)
        subprocess.run(g + ["add", "-A"], check=True)
        subprocess.run(g + ["commit", "-q", "-m", "x"], check=True)
        want = subprocess.run(["git", "-C", self.d, "rev-parse", "HEAD"], check=True,
                              capture_output=True, text=True).stdout.strip()
        self.assertEqual(loki.engine_sha(), want)

    def test_none_outside_a_checkout(self):
        # Negative control: a binary with no git checkout above it has no SHA.
        self.assertIsNone(loki.engine_sha())


if __name__ == "__main__":
    unittest.main()
