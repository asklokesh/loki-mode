"""tests/test_checklist_verify_tests_pass.py

wave-7 trust gate: autonomy/checklist-verify.py run_check(tests_pass).

A tests_pass checklist item REQUIRES that test verification actually ran. The
jest invocation uses --passWithNoTests, so a zero-match pattern exits 0 with
"No tests found ..." -- which would be a fake-green (a required verification
reporting SUCCESS with no test executed). pytest exits 5 when it collects no
tests. These tests prove the no-test signal now fails the check, while a real
passing run still passes and a real failing run still fails.

The check function is exercised directly with subprocess.run monkeypatched so
the test does not require jest/pytest to be installed in the project dir.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import tempfile
import types
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


class TestsPassTrustGate(unittest.TestCase):
    def setUp(self):
        self.mod = _load_module()
        self.tmp = tempfile.mkdtemp(prefix="loki-checklist-")
        self._orig_run = subprocess.run

    def tearDown(self):
        subprocess.run = self._orig_run
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_jest_project(self):
        # Presence of package.json routes run_check to the jest command.
        with open(os.path.join(self.tmp, "package.json"), "w") as f:
            f.write('{"name": "x"}')

    def _patch_run(self, completed):
        def fake_run(cmd, **kwargs):
            self._last_cmd = cmd
            return completed
        subprocess.run = fake_run

    def _check(self, pattern="src"):
        return self.mod.run_check(
            {"type": "tests_pass", "pattern": pattern},
            project_dir=self.tmp,
            timeout=30,
        )

    # ---- jest fake-green: exit 0 but "No tests found" -> must FAIL ----------

    def test_jest_no_tests_found_fails(self):
        self._make_jest_project()
        # Real jest --passWithNoTests output on a zero-match pattern.
        self._patch_run(_FakeCompleted(
            returncode=0,
            stderr="No tests found, exiting with code 0\n"
                   "Pattern: nomatch - 0 matches",
        ))
        result = self._check(pattern="nomatch")
        self.assertFalse(
            result["passed"],
            "tests_pass must NOT report success when no test was discovered",
        )
        self.assertIn("No tests discovered", result["output"])

    def test_jest_real_pass_still_passes(self):
        self._make_jest_project()
        self._patch_run(_FakeCompleted(
            returncode=0,
            stdout="Tests: 3 passed, 3 total\nTest Suites: 1 passed, 1 total",
        ))
        result = self._check()
        self.assertTrue(result["passed"])

    def test_jest_real_failure_still_fails(self):
        self._make_jest_project()
        self._patch_run(_FakeCompleted(
            returncode=1,
            stdout="Tests: 1 failed, 2 passed, 3 total",
        ))
        result = self._check()
        self.assertFalse(result["passed"])

    # ---- pytest path: exit code 5 = no tests collected -> must FAIL ---------

    def test_pytest_no_tests_collected_fails(self):
        # No package.json -> pytest command path.
        self._patch_run(_FakeCompleted(
            returncode=5,
            stdout="no tests ran in 0.01s",
        ))
        result = self._check()
        self.assertFalse(
            result["passed"],
            "pytest exit 5 (no tests collected) must fail the required check",
        )

    def test_pytest_real_pass_still_passes(self):
        self._patch_run(_FakeCompleted(
            returncode=0,
            stdout="3 passed in 0.05s",
        ))
        result = self._check()
        self.assertTrue(result["passed"])


if __name__ == "__main__":
    unittest.main()
