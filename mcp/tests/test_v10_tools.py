"""Unit tests for mcp/v10_tools.py with subprocess mocked."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from mcp import v10_tools  # noqa: E402


def _ok(p):
    return os.path.realpath(p)


def _deny(p):
    raise PermissionError("Access denied: " + p)


def _write_events(repo, run_id, events):
    d = os.path.join(repo, ".loki", "runs", run_id)
    os.makedirs(d)
    with open(os.path.join(d, "events.jsonl"), "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")


class RunTests(unittest.TestCase):
    def test_rejects_flag_like_ref(self):
        with mock.patch("subprocess.Popen") as popen:
            r = v10_tools.v10_run("--help", "/x", _ok)
        self.assertIn("error", r)
        popen.assert_not_called()

    def test_path_validation_failure(self):
        with mock.patch("subprocess.Popen") as popen:
            r = v10_tools.v10_run("fix the bug", "/etc", _deny)
        self.assertIn("Access denied", r["error"])
        popen.assert_not_called()

    def test_starts_in_background_with_arg_list(self):
        with tempfile.TemporaryDirectory() as repo, \
                mock.patch.object(v10_tools, "V10_RUN_ID_WAIT_S", 0), \
                mock.patch("subprocess.Popen") as popen:
            popen.return_value.pid = 4242
            r = v10_tools.v10_run("fix the bug", repo, _ok)
            args, kwargs = popen.call_args
            self.assertEqual(args[0][1], "fix the bug")
            self.assertIsInstance(args[0], list)
            self.assertNotIn("shell", kwargs)
            self.assertTrue(kwargs["start_new_session"])
            self.assertEqual(kwargs["env"]["LOKI_ENGINE"], "v10")
            self.assertEqual(r["pid"], 4242)
            self.assertIsNone(r["run_id"])
            self.assertTrue(r["log_path"].startswith(os.path.realpath(repo)))


class StatusTests(unittest.TestCase):
    def test_done_run(self):
        ev = [
            {"seq": 0, "type": "run.started", "stage": None, "data": {}},
            {"seq": 1, "type": "stage.started", "stage": "plan", "data": {}},
            {"seq": 2, "type": "cost", "stage": "plan", "data": {"usd": 0.5}},
            {"seq": 3, "type": "stage.completed", "stage": "plan", "data": {}},
            {"seq": 4, "type": "run.completed", "stage": None, "data": {"verdict": "VERIFIED"}},
        ]
        with tempfile.TemporaryDirectory() as repo:
            _write_events(repo, "e10-a", ev)
            r = v10_tools.v10_status("", repo, _ok)
        self.assertEqual(r["run_id"], "e10-a")
        self.assertTrue(r["done"])
        self.assertEqual(r["verdict"], "VERIFIED")
        self.assertEqual(r["phase"], "done")
        self.assertAlmostEqual(r["cost_usd"], 0.5)

    def test_running_and_unmeasured_cost(self):
        ev = [
            {"seq": 0, "type": "stage.started", "stage": "build", "data": {}},
            {"seq": 1, "type": "cost", "stage": "build", "data": {}},
        ]
        with tempfile.TemporaryDirectory() as repo:
            _write_events(repo, "e10-b", ev)
            r = v10_tools.v10_status("e10-b", repo, _ok)
        self.assertFalse(r["done"])
        self.assertEqual(r["phase"], "build")
        self.assertIsNone(r["cost_usd"])
        self.assertIsNone(r["verdict"])

    def test_bad_run_id_and_missing(self):
        with tempfile.TemporaryDirectory() as repo:
            self.assertIn("error", v10_tools.v10_status("../x", repo, _ok))
            self.assertIn("error", v10_tools.v10_status("", repo, _ok))
            self.assertIn("error", v10_tools.v10_status("", "", _ok))


class VerifyTests(unittest.TestCase):
    def test_receipt_path_runs_verify(self):
        with tempfile.TemporaryDirectory() as repo:
            receipt = os.path.join(repo, "receipt.json")
            open(receipt, "w").write("{}")
            cp = subprocess.CompletedProcess([], 0, stdout="VERIFIED\n", stderr="")
            with mock.patch("subprocess.run", return_value=cp) as run:
                r = v10_tools.v10_verify(receipt, "", _ok)
            args, kwargs = run.call_args
            self.assertEqual(args[0][1:], ["verify", os.path.realpath(receipt)])
            self.assertEqual(kwargs["timeout"], v10_tools.V10_VERIFY_TIMEOUT_S)
            self.assertNotIn("shell", kwargs)
        self.assertEqual(r["exit_code"], 0)
        self.assertTrue(r["verified"])
        self.assertIn("VERIFIED", r["output"])

    def test_repo_path_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as repo:
            cp = subprocess.CompletedProcess([], 1, stdout="", stderr="hash mismatch")
            with mock.patch("subprocess.run", return_value=cp):
                r = v10_tools.v10_verify("", repo, _ok)
        self.assertEqual(r["exit_code"], 1)
        self.assertFalse(r["verified"])

    def test_timeout_and_validation(self):
        with tempfile.TemporaryDirectory() as repo:
            with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("loki", 1)):
                self.assertIn("timed out", v10_tools.v10_verify("", repo, _ok)["error"])
        with mock.patch("subprocess.run") as run:
            self.assertIn("error", v10_tools.v10_verify("/etc/passwd", "", _deny))
            self.assertIn("error", v10_tools.v10_verify("", "", _ok))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
