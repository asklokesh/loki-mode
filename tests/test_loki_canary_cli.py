import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).parents[1]
CLI = ROOT / "autonomy/loki"


class TestLokiCanaryCli(unittest.TestCase):
    def run_cli(self, *args, cwd=None):
        env = os.environ.copy()
        env.update({
            "DO_NOT_TRACK": "1",
            "LOKI_TELEMETRY_DISABLED": "true",
            "NO_COLOR": "1",
        })
        return subprocess.run(
            ["bash", str(CLI), "outcomes", "canary", *args],
            cwd=cwd or ROOT,
            env=env,
            capture_output=True,
            text=True,
        )

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / "trials.jsonl"
        self.source.write_text("measured trials\n")
        self.report = self.root / "report.json"
        self.report.write_text(json.dumps({
            "report": "loki-outcome-router/v1",
            "source": str(self.source),
            "source_sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "selected_route": "fast",
            "invalid_observations": [],
            "candidates": [
                {"route": "fast", "trials": 5, "mean_risk": 0.1,
                 "eligible": True, "refusal_reasons": []},
                {"route": "safe", "trials": 5, "mean_risk": 0.1,
                 "eligible": True, "refusal_reasons": []},
            ],
        }, sort_keys=True))

    def tearDown(self):
        self.temp.cleanup()

    def test_help_discovers_the_complete_workflow(self):
        result = self.run_cli("--help", cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        for command in ("plan", "record", "evaluate", "receipt", "verify"):
            self.assertIn(command, result.stdout)

    def test_each_subcommand_reaches_its_bundled_tool_from_any_directory(self):
        for command, gate in (
            ("plan", "--enable-canary"),
            ("record", "--enable-recording"),
            ("evaluate", "--enable-evaluation"),
            ("receipt", "--enable-receipt"),
            ("verify", "--enable-verification"),
        ):
            with self.subTest(command=command):
                result = self.run_cli(command, "--help", cwd=self.root)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(gate, result.stdout)

    def test_plan_preserves_explicit_opt_in_and_exit_code(self):
        args = (
            "plan", str(self.report), "--subject", "opaque-subject",
            "--control-route", "safe", "--canary-percent", "50", "--json",
        )
        refused = self.run_cli(*args, cwd=self.root)
        self.assertEqual(refused.returncode, 3)
        self.assertIn("canary is opt-in", refused.stdout)
        allowed = self.run_cli(*args, "--enable-canary", cwd=self.root)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        body = json.loads(allowed.stdout)
        self.assertIn(body["assignment"], {"control", "canary"})
        self.assertEqual(body["control_route"], "safe")

    def test_unknown_subcommand_fails_closed(self):
        result = self.run_cli("apply", cwd=self.root)
        self.assertEqual(result.returncode, 64)
        self.assertEqual(result.stdout, "")
        self.assertIn("unknown command", result.stderr)


if __name__ == "__main__":
    unittest.main()
