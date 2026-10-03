"""Tests for multi-repo workspaces (autonomy/lib/workspace.py, LOKI_WORKSPACES=1).

Uses two temp git repos and a fake launcher; no network, no engine.
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "autonomy", "lib"))

import workspace  # noqa: E402
import loki_yaml  # noqa: E402


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def _make_repo(path):
    os.makedirs(path)
    _git(path, "init", "-q")
    _git(path, "config", "user.name", "t")
    _git(path, "config", "user.email", "t@example.com")
    with open(os.path.join(path, "a.txt"), "w") as f:
        f.write("x\n")
    _git(path, "add", "a.txt")
    _git(path, "commit", "-q", "-m", "init")


def _launcher(path, body):
    with open(path, "w") as f:
        f.write("#!/bin/sh\n" + body + "\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)


class WorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = os.path.realpath(self.tmp.name)
        self.api = os.path.join(self.t, "api")
        self.web = os.path.join(self.t, "web")
        _make_repo(self.api)
        _make_repo(self.web)
        self.base = os.path.join(self.t, "base")
        os.makedirs(self.base)

    def tearDown(self):
        self.tmp.cleanup()

    def _ws(self, integration=None):
        ws = {"repos": [{"repo": "acme/api", "path": self.api},
                        {"repo": "acme/web", "path": self.web, "after": ["acme/api"]}]}
        if integration:
            ws["integration"] = integration
        return {"shop": ws}

    def test_schema_accepts_workspaces(self):
        schema = loki_yaml.load_schema()
        self.assertIn("workspaces", schema["properties"])
        errs = loki_yaml.validate({"workspaces": self._ws()}, schema)
        self.assertEqual(errs, [])

    def test_order_and_cycle(self):
        order = workspace.order_repos(self._ws()["shop"])
        self.assertEqual([e["repo"] for e in order], ["acme/api", "acme/web"])
        bad = {"repos": [{"repo": "a/b", "after": ["c/d"]}, {"repo": "c/d", "after": ["a/b"]}]}
        with self.assertRaises(ValueError):
            workspace.order_repos(bad)
        with self.assertRaises(ValueError):
            workspace.order_repos({"repos": [{"repo": "a/b", "after": ["x/y"]}]})

    def test_flag_gate(self):
        old = os.environ.pop("LOKI_WORKSPACES", None)
        try:
            self.assertEqual(workspace.main(["list"]), 2)
        finally:
            if old is not None:
                os.environ["LOKI_WORKSPACES"] = old

    def test_run_all_ok_with_integration_evidence(self):
        launcher = os.path.join(self.t, "launch-ok.sh")
        _launcher(launcher, 'echo "$1" > ran.txt; exit 0')
        rc, ev_path = workspace.run_workspace(
            "shop", "acme/api#12", self._ws({"command": "echo integ", "timeout_s": 30}),
            base_dir=self.base, launcher=launcher)
        self.assertEqual(rc, 0)
        with open(ev_path) as f:
            ev = json.load(f)
        self.assertEqual(ev["exit_code"], 0)
        self.assertEqual(set(ev["heads"]), {"acme/api", "acme/web"})
        self.assertEqual(len(ev["log_sha256"]), 64)
        self.assertFalse(ev["seal"])
        self.assertIn(".loki/workspaces/shop/", ev_path)

    def test_failed_predecessor_skips_dependent(self):
        launcher = os.path.join(self.t, "launch-fail.sh")
        _launcher(launcher, "exit 1")
        rc, ev_path = workspace.run_workspace(
            "shop", "acme/api#12", self._ws(), base_dir=self.base, launcher=launcher)
        self.assertEqual(rc, 1)
        with open(ev_path) as f:
            ev = json.load(f)
        self.assertTrue(ev["outcomes"]["acme/api"].startswith("FAILED"))
        self.assertTrue(ev["outcomes"]["acme/web"].startswith("SKIPPED"))
        self.assertEqual(ev["status"], "not_configured")

    def test_integration_timeout_is_failed(self):
        launcher = os.path.join(self.t, "launch-ok2.sh")
        _launcher(launcher, "exit 0")
        rc, ev_path = workspace.run_workspace(
            "shop", "acme/api#12", self._ws({"command": "sleep 30", "timeout_s": 1}),
            base_dir=self.base, launcher=launcher)
        self.assertEqual(rc, 1)
        with open(ev_path) as f:
            ev = json.load(f)
        self.assertEqual(ev["status"], "failed")


if __name__ == "__main__":
    unittest.main()
