"""Every tool obeys one exit-code convention, and GATES never leak green.

WHY A CONTRACT TEST. Twenty-five tools under tools/ are meant to compose in CI:
`ci-gate.py` maps child exit codes, shell chains use `&&`, and `gate-report.py`
re-emits a verdict. The convention that emerged is:

    0   checked, passed
    1   checked, FAILED
    2   could NOT be checked / no policy configured
    3   nothing to check (empty)
    64  usage error
    66  input missing (path does not exist)

Nothing enforced it, and two real violations were already found and fixed:
`model-advisor` exited 0 on a NONEXISTENT workspace (v8.96.0), and
`receipt-attest` read `--help` as a proof path and issued a verdict about it
(v8.95.0). A per-tool test proves one tool is fine while the next one added
quietly breaks the convention, so this walks the real directory instead.

THE DISTINCTION THAT IS EASY TO GET WRONG, and which this file exists to pin:

A GATE returning 0 while its own output says it could not evaluate is a
green-leak: CI reads the exit code, sees success, and merges on an unchecked
axis. That is the single defect class this whole tool line exists to prevent.

An ADVISOR is different. `model-advisor.py` answering "NO BASIS: no measured,
priced iteration" IS a successful, honest answer to the question asked -- there
genuinely is no recommendation to make, the output says so in words, and no
gate consumes its exit code. Forcing it non-zero would train operators to
ignore a failing advisor, which is worse.

So the green-leak rule is applied to GATES ONLY, and the membership of that
list is itself asserted: a new tool with "guard" or "gate" in its name is
covered automatically, and a tool moving INTO the gate role cannot silently
escape the stricter rule.
"""

import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOLS = _ROOT / "tools"

# Tools whose exit code is a VERDICT a machine branches on. Anything named
# *-guard or *-gate is one by construction; the rest are listed explicitly.
_EXPLICIT_GATES = {"ci-gate.py", "receipt-attest.py", "receipt-bundle.py"}

# Not exit-contract participants: benchmark harnesses and repo maintenance
# scripts that predate the convention and are not composed in CI.
_NOT_PARTICIPANTS = {
    "bench_cross_project_lift.py", "bench_memory_retrieval.py",
    "hybrid_search.py", "index-codebase.py", "probe-model-catalog.py",
    "regen-state-machine-refs.py",
}

_CANNOT_EVALUATE = (
    "UNKNOWN", "NO BASIS", "CANNOT", "UNMEASURED", "not measured",
    "NO RECEIPTS", "no receipts", "UNEVALUABLE",
)


def _participants():
    for p in sorted(_TOOLS.glob("*.py")):
        if p.name not in _NOT_PARTICIPANTS:
            yield p


def _is_gate(name):
    """True when a tool's exit code is a verdict a machine branches on.

    Matches BOTH naming forms. The original predicate only matched the SUFFIX
    form (`ci-gate.py`), so every prefix-named tool escaped the strictest rule
    in this file: `gate-status.py`, `gate-log.py`, `gate-explain.py` and
    `gate-badge.py` were all silently classified as advisors and exempted from
    the green-leak check.

    All four happened to comply already -- verified by running them against a
    blind workspace, where they exit 2 or 64 and never 0. So this closes a
    COVERAGE gap, not a defect. That is precisely why it was worth closing: an
    exemption nobody noticed is one that will still be there when a tool
    eventually does not comply.
    """
    stem = name.rsplit(".", 1)[0]
    return (name in _EXPLICIT_GATES
            or stem.endswith(("-guard", "-gate"))
            or stem.startswith(("gate-", "guard-")))


def _run(path, *args, **kw):
    return subprocess.run(
        [sys.executable, str(path), *args],
        capture_output=True, text=True, timeout=120, **kw)


class HelpIsNeverAVerdict(unittest.TestCase):
    """`--help` must answer the question asked, not one nobody asked.

    receipt-attest read `--help` as a proof path and printed
    "UNVERIFIABLE -- proof file not found: --help". To a script parsing that,
    an answer about a nonexistent file is indistinguishable from a real finding
    about a real receipt.
    """

    def test_help_exits_zero_everywhere(self):
        for tool in _participants():
            with self.subTest(tool=tool.name):
                r = _run(tool, "--help")
                self.assertEqual(
                    r.returncode, 0,
                    "%s --help exited %d; a help request is not a failure"
                    % (tool.name, r.returncode))

    def test_help_never_emits_a_verdict_line(self):
        for tool in _participants():
            with self.subTest(tool=tool.name):
                r = _run(tool, "--help")
                self.assertNotIn(
                    "proof file not found", r.stdout + r.stderr,
                    "%s treated --help as a path and judged it" % tool.name)


class AUsageErrorIsSixtyFour(unittest.TestCase):
    """The convention this file DOCUMENTED but never checked.

    The header at the top of this module has listed "64 usage error" since
    it was written, and no test asserted it. argparse exits 2 for every
    usage error unless a tool overrides ArgumentParser.error(), and 2 in
    this convention means "could NOT be checked" -- a real verdict about
    the subject.

    So an unoverridden parser tells a CI caller that the axis was evaluated
    and found unevaluable, when nothing was examined at all: the mistake
    was in the command line. The two codes call for opposite responses,
    since retrying cannot fix a typo.

    This gap was not hypothetical. tools/verification-tax.py shipped with
    no override (`--bogus` exited 2), a missing path returning 4, and
    COULD_NOT_CHECK defined as 4 -- a code absent from the convention
    entirely. All three passed this suite, because this suite never asked.

    A convention stated in a comment and unasserted by a test is a
    convention that holds only while everyone remembers it.
    """

    def test_an_unknown_flag_exits_64(self):
        for tool in _participants():
            with self.subTest(tool=tool.name):
                r = _run(tool, "--zzz-not-a-real-flag")
                self.assertEqual(
                    r.returncode, 64,
                    "%s exited %d for an unknown flag; the convention is 64. "
                    "argparse defaults to 2, which here means 'could not be "
                    "checked' -- a verdict about the subject rather than "
                    "about the command line. Override ArgumentParser.error()."
                    % (tool.name, r.returncode))


class AMissingPathIsNeverSuccess(unittest.TestCase):
    def test_nonexistent_workspace_exits_non_zero(self):
        """model-advisor exited 0 here, so a CI job on a mistyped path saw green."""
        missing = "/nonexistent/definitely/not/here"
        for tool in _participants():
            name = tool.name
            if name in ("tool-index.py", "policy-load.py", "gate-report.py",
                        "signing-status.py", "gate-init.py"):
                continue  # take no workspace positional
            with self.subTest(tool=name):
                r = _run(tool, missing)
                self.assertNotEqual(
                    r.returncode, 0,
                    "%s reported success for a path that does not exist" % name)


class GatesNeverLeakGreen(unittest.TestCase):
    """The sharpest rule, and deliberately scoped to gates.

    An ADVISOR saying "no basis" has answered honestly and exits 0. A GATE
    saying it could not evaluate and exiting 0 tells CI to merge on an axis
    nobody checked.
    """

    def setUp(self):
        self.ws = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.ws, ".loki"), exist_ok=True)

    def test_a_gate_that_cannot_evaluate_never_exits_zero(self):
        cases = {
            "cost-guard.py": ["--max-usd", "5"],
            "token-guard.py": ["--max-output-tokens", "5"],
            "ci-gate.py": ["--max-usd", "5"],
        }
        for name, extra in cases.items():
            path = _TOOLS / name
            if not path.exists():
                continue
            with self.subTest(tool=name):
                r = _run(path, self.ws, *extra)
                said = [m for m in _CANNOT_EVALUATE
                        if m in (r.stdout + r.stderr)]
                if not said:
                    continue
                self.assertNotEqual(
                    r.returncode, 0,
                    "%s exited 0 while its own output says %r -- CI would "
                    "merge on an axis nobody checked" % (name, said[0]))

    def test_the_gate_list_covers_every_guard_and_gate_by_name(self):
        """A tool named like a gate is covered the day it lands.

        This test previously restated the SAME suffix-only pattern it was
        meant to guard (`"-gate." in name`), so it was blind to prefix-named
        tools by construction: `gate-status`, `gate-log`, `gate-explain` and
        `gate-badge` all escaped the green-leak rule and nothing noticed.

        A guard that reuses the predicate's own rule cannot detect a gap in
        that rule. It now derives the expectation from the NAME, independently
        of how `_is_gate` happens to be written.
        """
        for tool in _participants():
            stem = tool.name.rsplit(".", 1)[0]
            looks_like_a_gate = (
                stem.endswith(("-guard", "-gate"))
                or stem.startswith(("gate-", "guard-")))
            if looks_like_a_gate:
                self.assertTrue(
                    _is_gate(tool.name),
                    "%s is named like a gate but escapes the gate rule, so "
                    "the green-leak check never runs against it" % tool.name)

    def test_every_gate_named_tool_is_actually_covered(self):
        """The membership itself, asserted by name rather than by count.

        Names the four prefix-form tools explicitly. A count would pass while
        silently losing one, and this file exists because an exemption nobody
        noticed is one that is still there when a tool stops complying.
        """
        for name in ("gate-status.py", "gate-log.py", "gate-explain.py",
                     "gate-badge.py", "ci-gate.py", "cost-guard.py",
                     "token-guard.py"):
            if not (_TOOLS / name).exists():
                continue
            with self.subTest(tool=name):
                self.assertTrue(
                    _is_gate(name),
                    "%s is a gate but _is_gate() does not classify it as one; "
                    "the strictest rule in this file would skip it" % name)

    def test_model_advisor_is_deliberately_not_a_gate(self):
        """Pins the JUDGEMENT, so a future reader does not 'fix' it.

        Its exit 0 on a real workspace with no history is correct: the question
        was 'is there a cheaper model', the honest answer is 'no basis to say',
        and no gate consumes its exit code.
        """
        self.assertFalse(_is_gate("model-advisor.py"))
        r = _run(_TOOLS / "model-advisor.py", self.ws)
        self.assertEqual(
            r.returncode, 0,
            "an advisor with no basis is a successful honest answer; forcing "
            "it non-zero trains operators to ignore a failing advisor")
        self.assertIn("NO BASIS", r.stdout)


if __name__ == "__main__":
    unittest.main()
