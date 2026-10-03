#!/usr/bin/env python3
"""Tests for autonomy/lib/worktree_prep.py using a throwaway git repo."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "autonomy" / "lib"))
import worktree_prep  # noqa: E402


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


class WorktreePrepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        self._old_home = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)
        self.repo = Path(self.tmp.name) / "src"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@example.com")
        git(self.repo, "config", "user.name", "t")
        (self.repo / ".gitignore").write_text("node_modules/\n")
        (self.repo / "a.txt").write_text("one\n")
        git(self.repo, "add", ".gitignore", "a.txt")
        git(self.repo, "commit", "-q", "-m", "init")

    def tearDown(self):
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home
        self.tmp.cleanup()

    def dest(self, name):
        return str(Path(self.tmp.name) / name)

    def test_basic_and_left_out(self):
        (self.repo / "a.txt").write_text("dirty\n")
        (self.repo / "new.txt").write_text("x\n")
        res = worktree_prep.prepare_worktree(str(self.repo), self.dest("wt"), "b1")
        self.assertEqual(res["deps"], "none")
        self.assertEqual(res["left_out_changes"], 2)
        self.assertEqual((Path(res["path"]) / "a.txt").read_text(), "one\n")
        self.assertFalse((Path(res["path"]) / "new.txt").exists())
        head = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout.strip()
        self.assertEqual(res["base_sha"], head)
        self.assertTrue((self.home / ".loki" / "repos").is_dir())

    def test_cow_deps(self):
        nm = self.repo / "node_modules" / "pkg"
        nm.mkdir(parents=True)
        (nm / "i.js").write_text("1\n")
        res = worktree_prep.prepare_worktree(str(self.repo), self.dest("wt2"), "b2")
        self.assertIn(res["deps"], ("cow", "copy"))
        self.assertTrue((Path(res["path"]) / "node_modules" / "pkg" / "i.js").exists())

    def test_setup_command(self):
        res = worktree_prep.prepare_worktree(
            str(self.repo), self.dest("wt3"), "b3", setup="touch setup-ran")
        self.assertEqual(res["deps"], "setup")
        self.assertTrue((Path(res["path"]) / "setup-ran").exists())


if __name__ == "__main__":
    unittest.main()
