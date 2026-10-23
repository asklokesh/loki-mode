"""S-105: the release job's "Create Git Tag" step must never continue past a
tag it could not publish.

Release run 36331009098: the release changed workflow files, GITHUB_TOKEN was
refused the tag push ("without workflows permission"), the step echoed
"continuing", and gh release create then failed on "tag exists locally but has
not been pushed". This drives the ACTUAL step body (extracted from
release.yml) with real git against a local bare "origin"; a pre-receive hook
on that bare repo plays the GitHub rejection.
"""

import os
import pathlib
import re
import subprocess
import tempfile
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_RELEASE = pathlib.Path(os.environ.get(
    "S105_RELEASE_YML", _ROOT / ".github" / "workflows" / "release.yml"))
_VERSION = "9.99.0"
_TAG = "v" + _VERSION
_ENV = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
            GIT_TERMINAL_PROMPT="0", VERSION=_VERSION)
_ID = ["-c", "user.name=t", "-c", "user.email=t@t"]


def _tag_step_script():
    src = _RELEASE.read_text(encoding="utf-8")
    m = re.search(r"\n( +)- name: Create Git Tag\n", src)
    assert m, "Create Git Tag step not found in release.yml"
    step_indent = len(m.group(1))
    rest = src[m.end():]
    run_m = re.search(r"\n?( +)run: \|\n", rest)
    assert run_m, "Create Git Tag step has no run block"
    indent = len(run_m.group(1))
    body = []
    for line in rest[run_m.end():].splitlines():
        if line.strip() == "":
            body.append("")
            continue
        cur = len(line) - len(line.lstrip(" "))
        if cur <= indent or cur <= step_indent:
            break
        body.append(line)
    strip = min(len(l) - len(l.lstrip(" ")) for l in body if l.strip())
    script = "\n".join(l[strip:] for l in body)
    # The pre-S-105 step inlined the expression; normalise so both run.
    return script.replace("${{ steps.version.outputs.version }}", "${VERSION}")


def _git(cwd, *args, check=True):
    return subprocess.run(["git", *_ID, *args], cwd=cwd, env=_ENV, check=check,
                          capture_output=True, text=True).stdout.strip()


class CreateGitTagStep(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="s105-tag-")
        t = pathlib.Path(self.tmp.name)
        self.origin, self.work = str(t / "origin.git"), str(t / "work")
        subprocess.run(["git", "init", "-q", "--bare", self.origin], env=_ENV, check=True)
        subprocess.run(["git", "init", "-q", "-b", "main", self.work], env=_ENV, check=True)
        _git(self.work, "commit", "-q", "--allow-empty", "-m", "old")
        self.old_sha = _git(self.work, "rev-parse", "HEAD")
        _git(self.work, "commit", "-q", "--allow-empty", "-m", "release")
        self.release_sha = _git(self.work, "rev-parse", "HEAD")
        _git(self.work, "remote", "add", "origin", self.origin)
        _git(self.work, "push", "-q", "origin", "main")

    def tearDown(self):
        self.tmp.cleanup()

    def _prepush(self, sha, keep_local=False):
        """The maintainer pushes the tag with their own credentials. By
        default the tag is then dropped locally (pushed after checkout);
        keep_local models the usual case, where the fetch-depth: 0 checkout
        already fetched it."""
        _git(self.work, "tag", "-a", _TAG, "-m", "rm", sha)
        _git(self.work, "push", "-q", "origin", "refs/tags/" + _TAG)
        if not keep_local:
            _git(self.work, "tag", "-d", _TAG)

    def _reject_pushes(self):
        hook = pathlib.Path(self.origin, "hooks", "pre-receive")
        hook.write_text("#!/bin/sh\necho 'refusing to allow a GitHub App to create or "
                        "update workflow without workflows permission' >&2\nexit 1\n")
        hook.chmod(0o755)

    def _run(self):
        # GitHub runs step bodies as bash --noprofile --norc -eo pipefail.
        return subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c",
                               _tag_step_script()], cwd=self.work,
                              env=_ENV, capture_output=True, text=True, timeout=60)

    def _remote_tag(self):
        return _git(self.origin, "rev-parse", "-q", "--verify",
                    "refs/tags/%s^{commit}" % _TAG, check=False)

    def test_prepushed_tag_at_release_sha_is_reused(self):
        self._prepush(self.release_sha)
        self._reject_pushes()
        r = self._run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("reusing", r.stdout)
        self.assertEqual(_git(self.work, "rev-parse", _TAG + "^{commit}"), self.release_sha)

    def test_prepushed_tag_at_wrong_sha_fails(self):
        self._prepush(self.old_sha)
        r = self._run()
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("not the release SHA", r.stdout)
        self.assertEqual(self._remote_tag(), self.old_sha, "remote tag must never be moved")

    def test_rejected_push_without_remote_tag_fails_loudly(self):
        self._reject_pushes()
        r = self._run()
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("own credentials", r.stdout)
        self.assertNotIn("continuing", r.stdout)
        self.assertEqual(self._remote_tag(), "")

    def test_fetched_prepushed_tag_at_release_sha_is_reused(self):
        self._prepush(self.release_sha, keep_local=True)
        before = _git(self.origin, "rev-parse", "refs/tags/" + _TAG)
        r = self._run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(_git(self.origin, "rev-parse", "refs/tags/" + _TAG), before)

    def test_fetched_prepushed_tag_at_wrong_sha_fails(self):
        self._prepush(self.old_sha, keep_local=True)
        r = self._run()
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("not the release SHA", r.stdout)
        self.assertEqual(self._remote_tag(), self.old_sha, "remote tag must never be moved")

    def test_happy_path_pushes_tag_at_release_sha(self):
        r = self._run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self._remote_tag(), self.release_sha)

    def test_step_never_forces_or_deletes(self):
        s = _tag_step_script()
        self.assertNotRegex(s, r"--force|\s-f\s|push\s+[^\n]*\s\+|--delete|tag\s+-d")


if __name__ == "__main__":
    unittest.main()
