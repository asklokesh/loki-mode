"""tests/test_bench_cli.py -- R2 benchmark CLI (bash route) behavior.

Exercises the bash route end-to-end with NO paid API calls:
  - `loki bench --help` and `loki bench list` via the real CLI dispatch
    (autonomy/loki -> cmd_bench -> benchmarks/bench/run.sh).
  - `loki bench list` shows the committed demo task fixture.
  - `loki bench verify <result.json>` recomputes task_hash on a generated result
    fixture and reports hash_match.

These are subprocess tests (the CLI is bash); they assert exit codes + output
substrings, matching the proof-route test style.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LOKI = os.path.join(_REPO, "autonomy", "loki")
_RUN_SH = os.path.join(_REPO, "benchmarks", "bench", "run.sh")
_BENCH = os.path.join(_REPO, "benchmarks", "bench")
_DEMO_TASK = os.path.join(_BENCH, "tasks", "demo-pass.json")

if _BENCH not in sys.path:
    sys.path.insert(0, _BENCH)


def _run(argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, timeout=120, **kw)


class BenchHelpTest(unittest.TestCase):
    def test_loki_bench_help_via_cli(self):
        r = _run(["bash", _LOKI, "bench", "--help"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("loki bench", r.stdout)
        self.assertIn("run", r.stdout)
        self.assertIn("verify", r.stdout)
        # The credibility line must be present in help.
        self.assertIn("NEVER", r.stdout)

    def test_loki_bench_no_subcommand_exits_nonzero(self):
        # Bare `loki bench` prints usage and exits 1 (matches cmd_proof style).
        r = _run(["bash", _LOKI, "bench"])
        self.assertEqual(r.returncode, 1)
        self.assertIn("Usage", r.stdout)

    def test_run_sh_help_direct(self):
        r = _run(["bash", _RUN_SH, "--help"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("loki bench", r.stdout)


class BenchListTest(unittest.TestCase):
    def test_list_shows_demo_task_via_cli(self):
        r = _run(["bash", _LOKI, "bench", "list"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("demo-pass", r.stdout)

    def test_list_direct(self):
        r = _run(["bash", _RUN_SH, "list"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("demo-pass", r.stdout)


class BenchVerifyTest(unittest.TestCase):
    """Generate a real result-row for the committed demo task (via the python
    runner with a mock adapter, no paid calls), then verify it through the bash
    CLI route.
    """

    def setUp(self):
        import runner

        def mock_adapter(workdir, spec, *, model="m", timeout=900, runner=None):
            return {
                "tool": "mock", "tool_version": "0.0.1", "model_used": model,
                "duration_s": 1.0, "exit_status": "completed",
                "cost_usd": 0.01, "tokens_in": 10, "tokens_out": 5,
                "provenance": {"verified": True},
            }

        self.tmp = tempfile.mkdtemp(prefix="bench-cli-")
        row = runner.run_task(_DEMO_TASK, "mock", trials=1, adapter=mock_adapter)
        self.result_path = os.path.join(self.tmp, "result.json")
        with open(self.result_path, "w") as fh:
            json.dump(row, fh)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_verify_matches_via_cli(self):
        # task_hash recorded against the committed fixture should match on disk.
        # (Overall `ok` also gates on a live tool-version re-check; the "mock"
        # tool is not on PATH so we assert on hash_match, the recompute signal.)
        r = _run(["bash", _LOKI, "bench", "verify", self.result_path])
        report = json.loads(r.stdout)
        self.assertTrue(report["hash_match"])
        self.assertEqual(report["stored_hash"], report["recomputed_hash"])

    def test_verify_detects_tamper(self):
        # Corrupt the stored task_hash -> verify must report mismatch + exit 1.
        with open(self.result_path) as fh:
            row = json.load(fh)
        row["task_hash"] = "0" * 64
        with open(self.result_path, "w") as fh:
            json.dump(row, fh)
        r = _run(["bash", _LOKI, "bench", "verify", self.result_path])
        self.assertEqual(r.returncode, 1)
        report = json.loads(r.stdout)
        self.assertFalse(report["hash_match"])


if __name__ == "__main__":
    unittest.main()
