"""tests/test-checklist-run-check-arms.py

Wave B #6 trust gate: cover the run_check() arms in autonomy/checklist-verify.py
that the existing suite (test_checklist_verify_tests_pass.py) leaves untested.

run_check() dispatches six check types; tests_pass and grep_codebase already have
coverage. This file covers the remaining arms plus the _validate_path guard:

  - _validate_path : ../ traversal must be REJECTED (ValueError), safe path resolves
  - file_exists    : present -> True, absent -> False
  - file_contains  : present -> True, absent -> False, missing file -> False
  - command        : exit 0 -> True, non-zero -> False, missing binary -> None
  - http_check     : app not running -> None (inconclusive), 200+match -> True,
                     wrong status -> False, URLError/refused -> False (NEVER True)

The risky invariant: http_check must NEVER return True on a connection error or a
status mismatch. True-on-error would mark a dead endpoint 'verified'. It returns
None only when the app runner is not active (genuinely could not check), and False
on any real negative (wrong status, refused, URLError).

subprocess.run and urllib.request.urlopen are monkeypatched so the tests need no
real server, jest, or pytest installed in the project dir.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


def _load_module():
    here = Path(__file__).resolve().parent.parent
    path = here / "autonomy" / "checklist-verify.py"
    spec = importlib.util.spec_from_file_location("loki_checklist_verify", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _FakeCompleted:
    def __init__(self, returncode, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _FakeResponse:
    def __init__(self, code):
        self._code = code

    def getcode(self):
        return self._code


class RunCheckArms(unittest.TestCase):
    def setUp(self):
        self.mod = _load_module()
        self.tmp = tempfile.mkdtemp(prefix="loki-run-check-arms-")
        self._orig_run = subprocess.run
        import urllib.request
        self._orig_urlopen = urllib.request.urlopen

    def tearDown(self):
        subprocess.run = self._orig_run
        import urllib.request
        urllib.request.urlopen = self._orig_urlopen
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _check(self, check):
        return self.mod.run_check(check, project_dir=self.tmp, timeout=30)

    # ---- _validate_path ------------------------------------------------------

    def test_validate_path_rejects_traversal(self):
        # ../ escape must raise (the guard that keeps checks inside the project).
        with self.assertRaises(ValueError):
            self.mod._validate_path("../etc/passwd", self.tmp)

    def test_validate_path_accepts_in_project(self):
        # A plain in-project path resolves under project_dir (sanity: the guard
        # does not over-reject legitimate paths).
        resolved = self.mod._validate_path("sub/file.txt", self.tmp)
        self.assertTrue(resolved.startswith(os.path.realpath(self.tmp)))

    # ---- file_exists ---------------------------------------------------------

    def test_file_exists_present_is_true(self):
        Path(self.tmp, "present.txt").write_text("hi")
        result = self._check({"type": "file_exists", "path": "present.txt"})
        self.assertTrue(result["passed"])

    def test_file_exists_absent_is_false(self):
        result = self._check({"type": "file_exists", "path": "nope.txt"})
        self.assertFalse(result["passed"])

    # ---- file_contains -------------------------------------------------------

    def test_file_contains_pattern_present_is_true(self):
        Path(self.tmp, "app.js").write_text("const port = 3000;\n")
        result = self._check(
            {"type": "file_contains", "path": "app.js", "pattern": "port"})
        self.assertTrue(result["passed"])

    def test_file_contains_pattern_absent_is_false(self):
        Path(self.tmp, "app.js").write_text("nothing here\n")
        result = self._check(
            {"type": "file_contains", "path": "app.js", "pattern": "port"})
        self.assertFalse(result["passed"])

    def test_file_contains_missing_file_is_false(self):
        # Real code: os.path.isfile is False -> result["passed"] = False (line 85).
        result = self._check(
            {"type": "file_contains", "path": "gone.js", "pattern": "port"})
        self.assertFalse(result["passed"])

    # ---- command -------------------------------------------------------------

    def test_command_exit_zero_is_true(self):
        subprocess.run = lambda *a, **k: _FakeCompleted(returncode=0, stdout="ok")
        result = self._check({"type": "command", "command": "true"})
        self.assertTrue(result["passed"])

    def test_command_nonzero_is_false(self):
        subprocess.run = lambda *a, **k: _FakeCompleted(returncode=1, stderr="boom")
        result = self._check({"type": "command", "command": "false"})
        self.assertFalse(result["passed"])

    def test_command_missing_binary_is_none(self):
        # FileNotFoundError -> could not run -> None (inconclusive, not a failure).
        def _boom(*a, **k):
            raise FileNotFoundError()
        subprocess.run = _boom
        result = self._check({"type": "command", "command": "no-such-bin --x"})
        self.assertIsNone(result["passed"])

    # ---- http_check ----------------------------------------------------------

    def _write_app_state(self, status="running", url="http://127.0.0.1:8080"):
        state_dir = os.path.join(self.tmp, ".loki", "app-runner")
        os.makedirs(state_dir, exist_ok=True)
        Path(state_dir, "state.json").write_text(
            json.dumps({"status": status, "url": url}))

    def test_http_app_not_running_is_none(self):
        # No app-runner state at all -> app_url is None -> inconclusive (None),
        # NEVER True. The app runner is not active, so nothing could be checked.
        result = self._check({"type": "http_check", "path": "/health"})
        self.assertIsNone(
            result["passed"],
            "app not running must be inconclusive (None), never a pass")

    def test_http_state_not_running_is_none(self):
        # State file exists but status != running -> still no app_url -> None.
        self._write_app_state(status="stopped")
        result = self._check({"type": "http_check", "path": "/health"})
        self.assertIsNone(result["passed"])

    def test_http_200_match_is_true(self):
        self._write_app_state()
        import urllib.request
        urllib.request.urlopen = lambda req, timeout=None: _FakeResponse(200)
        result = self._check(
            {"type": "http_check", "path": "/health", "expected_status": 200})
        self.assertTrue(result["passed"])

    def test_http_wrong_status_is_false(self):
        # 500 when 200 expected -> False. NOT True (True would verify a broken app).
        self._write_app_state()
        import urllib.request
        urllib.request.urlopen = lambda req, timeout=None: _FakeResponse(500)
        result = self._check(
            {"type": "http_check", "path": "/health", "expected_status": 200})
        self.assertFalse(
            result["passed"],
            "a status mismatch must be False, never True (no verified dead app)")

    def test_http_urlerror_is_false_never_true(self):
        # Connection refused / URLError -> False, and CRITICALLY never True.
        self._write_app_state()
        import urllib.error
        import urllib.request

        def _refuse(req, timeout=None):
            raise urllib.error.URLError("Connection refused")
        urllib.request.urlopen = _refuse
        result = self._check({"type": "http_check", "path": "/health"})
        self.assertIs(
            result["passed"], False,
            "a connection error must be False, NEVER True (dead endpoint marked "
            "verified is the core risky invariant)")


if __name__ == "__main__":
    unittest.main()
