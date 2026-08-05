"""The release gate must fail closed on the required workflows at the exact SHA.

WHAT THIS GUARDS. Every publish job (npm, PyPI, TS SDK, Docker, Homebrew)
hangs off `needs: release`. Before required-ci existed, `release` needed only
`gate`, which runs the suite on Python 3.12 ONLY and never consults the
security audit. A VERSION push could publish to every channel while the Tests
matrix was still running, or already red on 3.10, 3.11 or 3.13.

TWO FAILURE MODES ARE ASSERTED HERE, and the second is the subtle one:

  1. The decision rules must treat anything other than an explicit success as
     not-a-pass. `cancelled` is the case that actually occurred in this repo:
     a Tests run was cancelled when a newer push superseded it, and a check
     that only tests for `failure` reads that as publishable.

  2. A required workflow must actually RUN at a release commit. Security Audit
     originally triggered on pull_request and a weekly cron only, so a release
     SHA had no Security Audit run at all. Requiring it without also adding a
     push trigger would deadlock every release instead of gating it -- a gate
     that can never pass is not stricter, it is broken. The trigger and the
     REQUIRED list have to change together, so this test pins both.
"""

import pathlib
import re
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_RELEASE = _ROOT / ".github" / "workflows" / "release.yml"


def _required_names():
    """The workflow names release.yml waits for, read from the file itself."""
    src = _RELEASE.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"REQUIRED=\$\(printf '%s\\n'([^)]*)\)", src)
    if not m:
        return []
    return re.findall(r'"([^"]+)"', m.group(1))


def _evaluate(runs, required):
    """The decision rules from the required-ci step, in Python.

    runs: list of (name, status, conclusion). Mirrors the shell loop exactly:
    empty -> vacuity guard, any non-success conclusion -> FAIL, anything not
    completed or not yet reported -> PENDING.
    """
    if not runs:
        return "PENDING_EMPTY"
    pending = False
    failed = False
    for want in required:
        line = next((r for r in runs if r[0] == want), None)
        if line is None:
            pending = True
            continue
        _, status, concl = line
        if status != "completed":
            pending = True
        elif concl != "success":
            failed = True
    if failed:
        return "FAIL"
    return "PENDING" if pending else "PASS"


class TheRequiredListCoversTheRealGates(unittest.TestCase):

    def test_tests_bun_parity_and_security_audit_are_all_required(self):
        names = _required_names()
        for expected in ("Tests", "Bun Parity", "Security Audit"):
            self.assertIn(
                expected, names,
                "%r is not in the release gate's REQUIRED list; a release can "
                "publish without it. Found: %r" % (expected, names))

    def test_every_required_workflow_can_actually_run_at_a_release_sha(self):
        """A required workflow that never fires at a VERSION push deadlocks
        the gate rather than enforcing it.

        DEPENDENCY-FREE ON PURPOSE. This originally used PyYAML and turned all
        four Python jobs red: CI installs pytest, fastapi, httpx, pydantic,
        sqlalchemy, aiosqlite and uvicorn, and PyYAML is not among them. It
        passed locally only because a transitive install happened to provide
        it. A test that guards the RELEASE GATE must not itself depend on a
        package the release environment does not install, so the two things it
        needs -- a workflow's `name:` and whether its trigger block contains
        `push:` -- are read with the standard library.
        """
        wf_dir = _ROOT / ".github" / "workflows"
        by_name = {}
        for path in sorted(wf_dir.glob("*.yml")):
            text = path.read_text(encoding="utf-8", errors="replace")
            m = re.search(r"^name:[ \t]*(.+?)[ \t]*$", text, re.M)
            if not m:
                continue
            by_name[m.group(1).strip().strip("'\"")] = text

        for want in _required_names():
            self.assertIn(want, by_name,
                          "required workflow %r has no workflow file" % want)
            text = by_name[want]
            # The trigger block runs from a line that is exactly `on:` until
            # the next top-level (column-zero) key. Scanning the whole file for
            # "push:" would match a job step or a comment.
            block = re.search(r"^on:[ \t]*$\n((?:[ \t]+.*\n|\n)*)", text, re.M)
            self.assertIsNotNone(
                block, "%r has no parsable `on:` trigger block" % want)
            self.assertRegex(
                block.group(1), r"(?m)^[ \t]+push:",
                "%r is required by the release gate but has no push trigger, "
                "so it never runs at a release SHA and the gate would wait "
                "until its deadline and then fail every release" % want)


class NothingButAnExplicitSuccessCounts(unittest.TestCase):

    def setUp(self):
        self.required = ["Tests", "Bun Parity", "Security Audit"]

    def _runs(self, **overrides):
        base = {n: ("completed", "success") for n in self.required}
        base.update(overrides)
        return [(n, s, c) for n, (s, c) in base.items()]

    def test_all_success_passes(self):
        self.assertEqual(_evaluate(self._runs(), self.required), "PASS")

    def test_audit_failure_blocks(self):
        runs = self._runs(**{"Security Audit": ("completed", "failure")})
        self.assertEqual(_evaluate(runs, self.required), "FAIL")

    def test_audit_cancelled_blocks(self):
        """The case that actually happened: superseded by a newer push."""
        runs = self._runs(**{"Security Audit": ("completed", "cancelled")})
        self.assertEqual(
            _evaluate(runs, self.required), "FAIL",
            "a cancelled run was treated as a pass; a conclusion check that "
            "only tests for 'failure' lets a superseded run publish")

    def test_audit_timed_out_blocks(self):
        runs = self._runs(**{"Security Audit": ("completed", "timed_out")})
        self.assertEqual(_evaluate(runs, self.required), "FAIL")

    def test_audit_skipped_blocks(self):
        runs = self._runs(**{"Security Audit": ("completed", "skipped")})
        self.assertEqual(_evaluate(runs, self.required), "FAIL")

    def test_audit_absent_does_not_pass(self):
        runs = [r for r in self._runs() if r[0] != "Security Audit"]
        self.assertNotEqual(
            _evaluate(runs, self.required), "PASS",
            "a missing Security Audit run was treated as a pass; an absent "
            "measurement is not evidence of health")

    def test_audit_still_running_does_not_pass(self):
        runs = self._runs(**{"Security Audit": ("in_progress", None)})
        self.assertEqual(_evaluate(runs, self.required), "PENDING")

    def test_an_empty_api_result_is_not_a_pass(self):
        """Vacuity guard: 'no failing runs' over zero runs is not success."""
        self.assertEqual(_evaluate([], self.required), "PENDING_EMPTY")


if __name__ == "__main__":
    unittest.main()
