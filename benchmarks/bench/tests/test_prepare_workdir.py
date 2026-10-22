"""Regression: prepare_workdir must leave the workdir a git work tree whose HEAD
commit is the copied fixture. loki start (engine10) refuses a folder that is not
a git work tree and exits rc 2 in under a second; a bench run would record that
as a measured failure of the tool under test (#246 parity run).
No model call is made. Run: python3 benchmarks/bench/tests/test_prepare_workdir.py"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import runner  # noqa: E402


def _git(workdir, *args):
    return subprocess.run(["git", *args], cwd=workdir, capture_output=True, text=True)


class PrepareWorkdirTest(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.mkdtemp(prefix="loki-bench-fixture-")
        with open(os.path.join(self.fixture, "app.py"), "w") as f:
            f.write("print('hi')\n")
        os.makedirs(os.path.join(self.fixture, "pkg"))
        with open(os.path.join(self.fixture, "pkg", "mod.py"), "w") as f:
            f.write("X = 1\n")
        self.workdirs = []

    def tearDown(self):
        shutil.rmtree(self.fixture, ignore_errors=True)
        for w in self.workdirs:
            shutil.rmtree(w, ignore_errors=True)

    def _prepare(self, fixture=None):
        w = runner.prepare_workdir(self.fixture if fixture is None else fixture, "loki")
        self.workdirs.append(w)
        return w

    def test_workdir_is_a_git_work_tree(self):
        w = self._prepare()
        r = _git(w, "rev-parse", "--is-inside-work-tree")
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "true"))

    def test_head_commit_holds_the_whole_fixture_and_tree_is_clean(self):
        w = self._prepare()
        tracked = set(_git(w, "ls-tree", "-r", "--name-only", "HEAD").stdout.split())
        self.assertEqual(tracked, {"app.py", "pkg/mod.py"})
        self.assertEqual(_git(w, "status", "--porcelain").stdout, "")

    def test_agent_edit_shows_as_a_diff_against_the_baseline(self):
        w = self._prepare()
        with open(os.path.join(w, "app.py"), "a") as f:
            f.write("print('changed')\n")
        self.assertIn("app.py", _git(w, "diff", "--name-only").stdout)

    def test_missing_fixture_still_yields_a_git_work_tree_with_a_head(self):
        w = self._prepare(fixture=os.path.join(self.fixture, "absent"))
        self.assertEqual(_git(w, "rev-parse", "--verify", "HEAD").returncode, 0)

    def test_global_git_identity_is_not_required(self):
        env_home = tempfile.mkdtemp(prefix="loki-bench-home-")
        old = {k: os.environ.get(k) for k in ("HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM")}
        os.environ.update({"HOME": env_home, "GIT_CONFIG_GLOBAL": os.devnull,
                           "GIT_CONFIG_SYSTEM": os.devnull})
        try:
            w = self._prepare()
            self.assertEqual(_git(w, "rev-parse", "--verify", "HEAD").returncode, 0)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            shutil.rmtree(env_home, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
