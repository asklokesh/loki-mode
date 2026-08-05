"""The suite must never let an inherited GIT_DIR reach a test's git calls.

Thirteen call sites across five modules run `subprocess.run(["git", ...],
cwd=fixture_repo)` without `-C`. `cwd` does not override GIT_DIR -- git's
environment wins -- so under any inherited git environment those calls act on
the REAL repository. Measured 2026-07-31: that produced 22 failures and wrote
fixture commits onto the live branch, which reached origin/main.

tests/conftest.py strips those variables for the whole session. These tests
assert the strip actually happened and that the `cwd=`-only pattern is safe
once it has, so the protection cannot be removed without a red test.
"""

import os
import subprocess
import unittest

CONFTEST_STRIPPED = (
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
    "GIT_QUARANTINE_PATH",
)


class GitEnvIsolationTests(unittest.TestCase):
    def test_git_env_is_absent_during_tests(self):
        """No git redirect variable survives into a test."""
        leaked = [name for name in CONFTEST_STRIPPED if name in os.environ]
        self.assertEqual(
            leaked, [],
            "git environment leaked into the test session: %s. "
            "tests/conftest.py strips these; a test that inherits them can "
            "commit into the real repository." % leaked)

    def test_cwd_only_git_call_targets_the_fixture(self):
        """The `cwd=` pattern the suite uses must act on the fixture repo.

        This is the real contract. If GIT_DIR were leaking, this commit would
        land in the repository running the test rather than in tmp.
        """
        import tempfile

        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "f.txt"), "w") as handle:
                handle.write("x\n")

            # Deliberately the unsafe-looking form the suite uses: cwd, no -C.
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            subprocess.run(["git", "add", "-A"], cwd=root, check=True)
            subprocess.run(
                ["git", "-c", "user.email=t@t", "-c", "user.name=t",
                 "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"],
                cwd=root, check=True)

            # The commit must exist in the fixture...
            inside = subprocess.run(
                ["git", "log", "--oneline", "-1"], cwd=root,
                capture_output=True, text=True, check=True)
            self.assertIn("fixture", inside.stdout)

            # ...and the fixture's git dir must be the fixture's own.
            where = subprocess.run(
                ["git", "rev-parse", "--absolute-git-dir"], cwd=root,
                capture_output=True, text=True, check=True)
            self.assertTrue(
                os.path.realpath(where.stdout.strip()).startswith(
                    os.path.realpath(root)),
                "git resolved outside the fixture (%s); GIT_DIR is leaking "
                "and tests can write to the real repository"
                % where.stdout.strip())


if __name__ == "__main__":
    unittest.main()
