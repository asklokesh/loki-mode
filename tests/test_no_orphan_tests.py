"""A test cannot be committed without the thing it tests.

THE CLASS, and it has now taken down every Python CI job THREE times.

  v9.10.1  `git add -A tests/` committed tests whose tools were untracked.
           pytest collection errored, so ALL FOUR Python jobs died before
           running a single assertion.
  v9.11.x  Same shape again: tests/test_cost_forecast.py was tracked while
           tools/cost-forecast.py was not. 27 tests pass on any machine with
           the working tree; on a clean checkout the tool does not exist and
           the subprocess returns empty stdout.

Each time it was fixed by committing the missing file. That fixes the
INSTANCE and leaves the CLASS live, which is why it came back twice. The
defect is not "someone forgot a file" -- it is that a test referencing a
path git does not carry LOOKS IDENTICAL to a passing test locally. The
working tree hides it; only a fresh clone reveals it, and CI is the first
fresh clone.

WHY THIS IS THE RIGHT GUARD, and not "be careful when staging". The property
that matters is checkable and cheap: every path a tracked test invokes must
itself be tracked. It is not a matter of discipline, so it should not be
guarded by discipline.

VACUITY, which is the trap in a test like this. If the discovery regex
matches nothing, this file passes while asserting nothing at all -- the same
false-green shape as a substring search over an empty listing. So the
discovery itself is asserted: the scan must find references, and it must find
them in more than one test file, before any verdict is trusted.
"""

import pathlib
import re
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TESTS = _ROOT / "tests"

# Repo-relative paths a test hands to a subprocess or reads directly. Kept
# deliberately narrow: the directories that hold executable helpers a test can
# invoke. A broader pattern would sweep up prose in docstrings.
_REF = re.compile(r"\b((?:tools|autonomy/lib|scripts)/[A-Za-z0-9_.-]+\.(?:py|sh))")

# Paths that appear in test source as ILLUSTRATION, not as invocation.
#
# These are NEGATIVE FIXTURES: a path handed to a tool precisely BECAUSE it
# does not exist, to prove the tool reports a missing input rather than
# inventing an answer. `tools/x.py`, `tools/no-such-tool.py` and
# `tools/definitely-not-here.py` all exist only inside an assertion about
# absence, and a guard that demanded they be tracked would be demanding the
# fixtures be destroyed.
#
# Recognized by NAMING INTENT rather than an exact list, so a future negative
# fixture is covered the day it lands without editing this file. The words are
# ones no real tool would carry -- a shipped tool is never named "no-such" or
# "definitely-not-here" -- so the pattern cannot accidentally excuse a genuine
# orphan. Anything not matching here must be real and tracked.
_FIXTURE_WORDS = ("no-such", "not-here", "nonexistent", "does-not-exist",
                  "missing-tool", "definitely-not")


def _is_negative_fixture(ref):
    stem = ref.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return stem == "x" or any(w in stem for w in _FIXTURE_WORDS)


def _tracked():
    r = subprocess.run(
        ["git", "-C", str(_ROOT), "ls-files"],
        capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        return None
    return set(r.stdout.split())


def _references():
    """Every (test file, referenced path) pair, from tracked tests only.

    Untracked tests are irrelevant: they are not in the clone CI builds, so
    they cannot break it. Scanning them would report failures for work in
    progress, which trains people to ignore this file.
    """
    tracked = _tracked()
    pairs = []
    for p in sorted(_TESTS.rglob("test*.py")):
        rel = p.relative_to(_ROOT).as_posix()
        if tracked is not None and rel not in tracked:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for hit in set(_REF.findall(text)):
            if not _is_negative_fixture(hit):
                pairs.append((rel, hit))
    return pairs


class TheScanActuallyFindsSomething(unittest.TestCase):
    """Asserted FIRST, because the verdict below is worthless without it.

    A discovery regex that silently stops matching turns this whole file into
    a green light that checks nothing. That failure mode is invisible -- the
    suite still reports a pass -- so the discovery is measured explicitly
    rather than assumed.
    """

    def test_references_are_discovered_at_all(self):
        pairs = _references()
        self.assertTrue(
            pairs,
            "the reference scan matched NOTHING, so every assertion in this "
            "file is vacuous. Either the regex broke or the tests stopped "
            "invoking helper paths; both need a human.")

    def test_references_span_several_test_files(self):
        pairs = _references()
        files = {f for f, _ in pairs}
        self.assertGreater(
            len(files), 1,
            "only %d test file references a helper path; the scan is almost "
            "certainly broken rather than the repo being that small" % len(files))


class EveryReferencedPathIsTracked(unittest.TestCase):
    """The invariant itself.

    Two distinct failures are separated on purpose, because they need
    different fixes: a path git does not carry (stage it), versus a path that
    does not exist at all (the test is stale -- delete it or restore the tool).
    """

    def test_no_tracked_test_invokes_an_untracked_path(self):
        tracked = _tracked()
        if tracked is None:
            self.skipTest("git unavailable; tracking unchecked, NOT passed")

        orphans = sorted({
            "%s -> %s" % (test, ref)
            for test, ref in _references()
            if (_ROOT / ref).exists() and ref not in tracked
        })

        self.assertEqual(
            orphans, [],
            "these tests invoke files that exist locally but are NOT tracked "
            "by git, so they vanish in a fresh clone and every Python CI job "
            "dies at collection: %s\nStage the referenced file by name."
            % "; ".join(orphans))

    def test_no_tracked_test_invokes_a_path_that_does_not_exist(self):
        """The stale half of the class.

        Distinct from the above: nothing to stage, because there is nothing
        there. Either the helper was deliberately dropped and its test should
        have gone with it, or the path is a typo.
        """
        missing = sorted({
            "%s -> %s" % (test, ref)
            for test, ref in _references()
            if not (_ROOT / ref).exists()
        })

        self.assertEqual(
            missing, [],
            "these tests invoke paths that do not exist anywhere in the repo. "
            "The helper was dropped and its test outlived it, or the path is "
            "misspelled: %s" % "; ".join(missing))


if __name__ == "__main__":
    unittest.main()
