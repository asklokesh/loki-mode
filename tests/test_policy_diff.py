"""A direction-blind policy diff is worse than no diff, because it is trusted.

tools/policy-diff.py exists to answer the one question `git diff` structurally
cannot: does this policy edit make the gate WEAKER or STRONGER. So these tests
assert the DIRECTION WORD, never merely that a change was detected. A tool that
prints "max_usd: 5 -> 50" and stops has reported the same thing git already
did, and hands the safety reasoning back to a reviewer 300 lines from the end
of a PR. Every assertion below would still pass against that useless tool if it
only checked "something changed" -- which is why each one names WEAKENS or
TIGHTENS explicitly.

Three properties get their own guard because each is a distinct way a loosening
gets waved through:

  A REMOVED KEY IS WEAKENING, not "removed". Deleting max_usd does not lower a
  ceiling, it stops enforcing cost at all.

  AN UNCLASSIFIABLE CHANGE READS "UNKNOWN DIRECTION". The live version of this
  is policy-load.KNOWN_KEYS growing while policy-diff's table does not, so the
  guard walks the real KNOWN_KEYS rather than trusting a fixture. That is the
  case where the new axis is invisible on the one surface built to see it.

  AN INVALID FILE IS REFUSED, NAMING THE FILE. Diffing a document no gate would
  honour produces a confident verdict about nothing.

Exit codes are asserted as themselves and not just as truthiness, because they
are the machine-readable half of the product: 0 passed, 1 failed, 2 could not
evaluate, 64 usage, 66 input missing.
"""

import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "policy-diff.py"

_spec = importlib.util.spec_from_file_location("policy_diff", _TOOL)
policy_diff = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(policy_diff)


def _run(old_text, new_text, *flags):
    """Write both policy files (None writes no file) and run the tool."""
    with tempfile.TemporaryDirectory() as d:
        old = pathlib.Path(d) / "old.json"
        new = pathlib.Path(d) / "new.json"
        if old_text is not None:
            old.write_text(old_text, encoding="utf-8")
        if new_text is not None:
            new.write_text(new_text, encoding="utf-8")
        r = subprocess.run(
            [sys.executable, str(_TOOL), str(old), str(new), *flags],
            capture_output=True, text=True, timeout=120)
        return r, str(old), str(new)


_BASE = '{"max_usd": 5.0, "require_receipt": true}'


class TestDirectionIsClassifiedNotJustDetected(unittest.TestCase):
    """The whole product: the reviewer must not have to do the reasoning."""

    def test_raising_a_ceiling_reads_weakens(self):
        r, _, _ = _run(_BASE, '{"max_usd": 50.0, "require_receipt": true}')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WEAKENS", r.stdout,
                      "raising max_usd 5 -> 50 admits every run the old policy "
                      "blocked; reporting it without the direction is what git "
                      "already does")
        self.assertNotIn("TIGHTENS", r.stdout)

    def test_lowering_a_ceiling_reads_tightens(self):
        r, _, _ = _run(_BASE, '{"max_usd": 2.0, "require_receipt": true}')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("TIGHTENS", r.stdout)
        self.assertNotIn("WEAKENS", r.stdout,
                         "a lowered ceiling flagged as a weakening trains "
                         "reviewers to ignore the flag")

    def test_dropping_require_receipt_reads_weakens(self):
        r, _, _ = _run(_BASE, '{"max_usd": 5.0, "require_receipt": false}')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WEAKENS", r.stdout)

    def test_adding_require_receipt_reads_tightens(self):
        r, _, _ = _run('{"max_usd": 5.0, "require_receipt": false}', _BASE)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("TIGHTENS", r.stdout)
        self.assertNotIn("WEAKENS", r.stdout)

    def test_an_identical_pair_reports_no_change(self):
        r, _, _ = _run(_BASE, _BASE)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("no change", r.stdout)
        self.assertNotIn("WEAKENS", r.stdout)
        self.assertNotIn("TIGHTENS", r.stdout)


class TestRemovalIsWeakeningNotMerelyRemoved(unittest.TestCase):
    """Removing a key stops enforcing that axis entirely: strictly weaker than
    any value that could have been in it."""

    def test_removing_max_usd_reads_weakens(self):
        r, _, _ = _run(_BASE, '{"require_receipt": true}')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WEAKENS", r.stdout,
                      "a removed ceiling reported as merely 'removed' is the "
                      "most dangerous edit rendered as the blandest line")
        self.assertIn("max_usd", r.stdout)

    def test_removing_require_receipt_reads_weakens(self):
        r, _, _ = _run(_BASE, '{"max_usd": 5.0}')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WEAKENS", r.stdout)

    def test_removing_a_false_flag_is_still_weakening(self):
        """The tempting exception, refused deliberately.

        `require_receipt: false -> absent` enforces nothing either way, so it
        reads as neutral. Allowing that one exception gives the reviewer a rule
        with a footnote about which removals are the safe kind, and the footnote
        is where the next loosening lives.
        """
        r, _, _ = _run('{"max_usd": 5.0, "require_receipt": false}',
                       '{"max_usd": 5.0}')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WEAKENS", r.stdout)


class TestUnknownDirectionIsNeverSilent(unittest.TestCase):
    """policy-load.KNOWN_KEYS will grow. A key it validates but this tool does
    not classify is a valid, clean-diffing policy edit -- the exact shape a
    silent loosening hides in."""

    def test_an_unclassifiable_key_reads_unknown_direction(self):
        # Called directly: policy-load rejects unknown keys, so this state is
        # unreachable through a file, and writing it at the parse layer would
        # be untestable dead code.
        direction, detail = policy_diff.classify("max_parallel_agents", 2, 40)
        self.assertEqual(direction, policy_diff.UNKNOWN)
        self.assertIn("max_parallel_agents", detail)

    def test_an_unclassifiable_key_is_never_reported_as_unchanged(self):
        direction, _ = policy_diff.classify("some_future_key", "a", "b")
        self.assertIsNotNone(
            direction,
            "an unrecognised key whose semantics we do not know is exactly "
            "where a silent loosening hides; None reads as 'unchanged'")

    def test_every_known_policy_key_is_classified(self):
        """The regression this file exists to catch, walking the REAL schema.

        Deliberately stricter than "or it reads UNKNOWN": a shipped policy key
        that permanently reads UNKNOWN makes a reviewer resolve the same axis
        by hand on every PR, and a flag nobody can action is a flag everyone
        learns to skip. UNKNOWN is the safety net, not the resting state.
        """
        spec = importlib.util.spec_from_file_location(
            "policy_load_probe", _ROOT / "tools" / "policy-load.py")
        policy_load = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(policy_load)
        for key in policy_load.KNOWN_KEYS:
            with self.subTest(key=key):
                self.assertIn(
                    key, policy_diff.DIRECTIONS,
                    "%s is a valid policy key that policy-diff cannot classify; "
                    "it must be added to DIRECTIONS or it diffs as UNKNOWN and "
                    "a reviewer resolves it by hand every time" % key)


class TestFailOnWeaken(unittest.TestCase):
    """The flag that lets CI require a human ack on a loosening."""

    def test_exits_non_zero_on_a_weakening(self):
        r, _, _ = _run(_BASE, '{"max_usd": 50.0, "require_receipt": true}',
                       "--fail-on-weaken")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)

    def test_exits_zero_on_a_tightening(self):
        r, _, _ = _run(_BASE, '{"max_usd": 2.0, "require_receipt": true}',
                       "--fail-on-weaken")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_exits_zero_on_an_identical_pair(self):
        r, _, _ = _run(_BASE, _BASE, "--fail-on-weaken")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_a_weakening_without_the_flag_still_exits_zero(self):
        """Reporting a weakening is a successful answer; failing the build is
        opt-in, or nobody can run this tool to look."""
        r, _, _ = _run(_BASE, '{"max_usd": 50.0, "require_receipt": true}')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WEAKENS", r.stdout)


class TestInvalidInputIsRefusedByName(unittest.TestCase):
    """Diffing a file no gate would honour is a confident verdict about
    nothing."""

    def test_an_invalid_new_file_is_refused_naming_the_file(self):
        r, _, new = _run(_BASE, '{"max_usd_": 5.0}')
        self.assertEqual(r.returncode, policy_diff.EXIT_CANNOT_EVALUATE,
                         r.stdout + r.stderr)
        self.assertIn(new, r.stderr, "the operator must be told WHICH file")
        self.assertIn("max_usd_", r.stderr, "and WHY")
        self.assertNotIn("WEAKENS", r.stdout,
                         "a verdict about an unhonoured document is nonsense")

    def test_an_invalid_old_file_is_refused_naming_the_file(self):
        r, old, _ = _run('{"max_usd": -1}', _BASE)
        self.assertEqual(r.returncode, policy_diff.EXIT_CANNOT_EVALUATE,
                         r.stdout + r.stderr)
        self.assertIn(old, r.stderr)

    def test_malformed_json_is_refused_not_diffed(self):
        r, _, new = _run(_BASE, '{"max_usd": 5.0,')
        self.assertEqual(r.returncode, policy_diff.EXIT_CANNOT_EVALUATE,
                         r.stdout + r.stderr)
        self.assertIn(new, r.stderr)

    def test_a_missing_file_reads_input_missing_not_cannot_evaluate(self):
        """66 and 2 are different findings: absent is not the same as invalid."""
        r, old, _ = _run(None, _BASE)
        self.assertEqual(r.returncode, policy_diff.EXIT_INPUT_MISSING,
                         r.stdout + r.stderr)
        self.assertIn(old, r.stderr)


class TestExitContract(unittest.TestCase):
    """Pinned here too, so a change to this tool cannot quietly break the
    convention tests/test_tool_exit_contract.py enforces across tools/."""

    def test_help_exits_zero_and_issues_no_verdict(self):
        r = subprocess.run([sys.executable, str(_TOOL), "--help"],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0)
        # Not "the word WEAKENS is absent" -- it is in the --help description,
        # which is correct. The defect shape is help being READ AS A PATH and
        # judged, the way receipt-attest printed a verdict about "--help". So
        # assert on the VERDICT LINES, which only a real diff emits.
        for verdict in ("WEAKENS:", "TIGHTENS:", "UNKNOWN DIRECTION:",
                        "no change:", "does not exist"):
            self.assertNotIn(verdict, r.stdout,
                             "a help request produced a verdict line")

    def test_a_usage_error_exits_64_not_2(self):
        """argparse defaults to 2, which in this repo means 'could not be
        checked' -- a different finding from 'you called it wrong'."""
        r = subprocess.run([sys.executable, str(_TOOL), "/nonexistent/nope"],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, policy_diff.EXIT_USAGE,
                         r.stdout + r.stderr)


class TestJsonOutput(unittest.TestCase):

    def test_json_carries_the_direction_and_the_weakening_count(self):
        r, _, _ = _run(_BASE, '{"max_usd": 50.0}', "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        payload = json.loads(r.stdout)
        self.assertEqual(payload["weakens"], 2, payload)
        directions = {c["key"]: c["direction"] for c in payload["changes"]}
        self.assertEqual(directions["max_usd"], policy_diff.WEAKENS)
        self.assertEqual(directions["require_receipt"], policy_diff.WEAKENS)


if __name__ == "__main__":
    unittest.main()
