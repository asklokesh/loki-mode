"""A generated ceiling must have a basis, or must not exist.

WHAT THIS PROTECTS. tools/gate-init.py exists to remove the several manual
steps between a team and a working cost gate. Every generator that does that
faces the same temptation: fill in the blank so the output looks complete. For
a cost ceiling that is the one thing it must not do.

    A FABRICATED CEILING IS WORSE THAN NO CEILING.

No ceiling is visibly unfinished and someone sets it. A plausible $5.00 with no
derivation gets committed, CI goes green, and the gate enforces a number nobody
chose and nobody can defend. The green is the damage: it reads as "reviewed and
within budget" while meaning "arbitrary". That is the same shape as the four
surfaces this repo already paid for, where an unmeasured cost rendered as
"$0.00" and a skeptic could not tell free from unmeasured.

So the central assertion here is a NEGATIVE one, and negatives are the ones
that rot quietly: with no measured history, no number appears anywhere in the
policy. Asserted structurally (the key is absent, and no value in the file is a
ceiling-shaped number), not by matching one string a refactor would rename.

The positive direction is asserted too. A guard so strict it never derived a
ceiling would leave every adopter hand-picking one, which is the manual step
the tool exists to delete.

THE THIRD PROPERTY, which the other two cannot see: the emitted file must LOAD
under the real policy-load.py. A generator whose output the loader rejects is
worse than one that emits nothing -- the operator has a committed artifact, a
passing generator, and a gate that never runs. That is checked by invoking
policy-load as a subprocess, never by re-stating its schema here.
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest

# A stale __pycache__ is how a mutation "does not land": the probe rewrites the
# source, the interpreter loads yesterday's bytecode, and the test passes for
# the wrong reason.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "gate-init.py"
_LOADER = _ROOT / "tools" / "policy-load.py"


def _run(*args):
    """Drive the tool as a subprocess: the exit code is part of its contract."""
    return subprocess.run(
        [sys.executable, str(_TOOL)] + [str(a) for a in args],
        capture_output=True, text=True, timeout=120)


def _workspace(costs=None, measured=True):
    """A temp workspace, optionally with a cost history of `costs` USD."""
    d = tempfile.mkdtemp()
    if costs is not None:
        hist = pathlib.Path(d) / ".loki" / "cost-history.jsonl"
        hist.parent.mkdir(parents=True, exist_ok=True)
        rows = [
            {"ts": time.time() + i, "workspace": d, "model": "test",
             "usd": c if measured else None, "measured": measured}
            for i, c in enumerate(costs)
        ]
        hist.write_text(
            "\n".join(json.dumps(r, sort_keys=True) for r in rows) + "\n",
            encoding="utf-8")
    return d


def _numbers(obj):
    """Every numeric leaf in a JSON structure, booleans excluded.

    Structural, so it still catches a fabricated ceiling written under a
    renamed key -- which is exactly how a negative assertion goes blind.
    """
    if isinstance(obj, bool):
        return []
    if isinstance(obj, (int, float)):
        return [obj]
    if isinstance(obj, dict):
        return [n for v in obj.values() for n in _numbers(v)]
    if isinstance(obj, list):
        return [n for v in obj for n in _numbers(v)]
    return []


class NoHistoryInventsNothing(unittest.TestCase):
    """THE CENTRAL ONE. No measured runs means no number, anywhere."""

    def test_no_history_writes_no_ceiling(self):
        ws = _workspace()
        out = os.path.join(ws, "policy.json")
        proc = _run(ws, "--out", out)
        self.assertEqual(proc.returncode, 0, proc.stderr)

        policy = json.loads(pathlib.Path(out).read_text(encoding="utf-8"))

        # Absent, not null: policy-load rejects a null max_usd outright, so a
        # null here would also break requirement 3.
        self.assertNotIn("max_usd", policy,
                         "a ceiling was written with no measured history to "
                         "derive it from: %r" % policy)
        # And nothing ceiling-shaped smuggled in under another key.
        self.assertEqual([], _numbers(policy),
                         "a number appeared in a policy with no basis: %r"
                         % policy)

    def test_no_history_says_the_operator_must_choose(self):
        # BOTH output modes. The note lived only in the human branch once, so
        # --json emitted "ceiling": null with an empty stderr -- a machine
        # consumer got a policy enforcing less than it looked like, with no
        # warning at all. A machine-readable format changes how a warning is
        # rendered, never whether it is emitted.
        for extra in ([], ["--json"]):
            ws = _workspace()
            out = os.path.join(ws, "policy.json")
            proc = _run(ws, "--out", out, *extra)
            combined = proc.stdout + proc.stderr
            self.assertIn("NO CEILING WAS SET", combined,
                          "silently omitting the ceiling is not enough; the "
                          "operator must be told to choose one (mode %r). "
                          "Output: %r" % (extra, combined))

    def test_json_mode_stdout_stays_parseable(self):
        # The note goes to stderr precisely so --json can be piped.
        ws = _workspace()
        out = os.path.join(ws, "policy.json")
        proc = _run(ws, "--out", out, "--json")
        verdict = json.loads(proc.stdout)
        self.assertIsNone(verdict["ceiling"])

    def test_history_with_no_measured_runs_is_the_same_as_none(self):
        # Rows exist but every one is unmeasured. Reading those as $0.00 is the
        # exact defect this repo removed from four surfaces; here it would
        # produce a $0.00 ceiling that blocks every run doing real work.
        ws = _workspace([None, None], measured=False)
        out = os.path.join(ws, "policy.json")
        proc = _run(ws, "--out", out)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        policy = json.loads(pathlib.Path(out).read_text(encoding="utf-8"))
        self.assertNotIn("max_usd", policy,
                         "unmeasured runs were treated as measured spend: %r"
                         % policy)


class HistoryDerivesACeiling(unittest.TestCase):
    """The positive direction: a guard that never derives is also useless."""

    def test_ceiling_is_derived_from_measured_runs(self):
        ws = _workspace([1.10, 1.40, 1.20, 2.00])
        out = os.path.join(ws, "policy.json")
        proc = _run(ws, "--out", out)
        self.assertEqual(proc.returncode, 0, proc.stderr)

        policy = json.loads(pathlib.Path(out).read_text(encoding="utf-8"))
        self.assertIn("max_usd", policy,
                      "measured history was present but no ceiling derived")
        # Above observed spend (a ceiling at the median blocks half of all
        # normal runs) and not unboundedly above it.
        self.assertGreater(policy["max_usd"], 1.30)
        self.assertLess(policy["max_usd"], 20.0)

    def test_the_basis_is_stated(self):
        ws = _workspace([1.10, 1.40, 1.20, 2.00])
        out = os.path.join(ws, "policy.json")
        proc = _run(ws, "--out", out, "--json")
        verdict = json.loads(proc.stdout)
        self.assertIsNotNone(verdict["basis"])
        # A number whose derivation is not stated is indistinguishable from an
        # invented one at review time.
        self.assertIn("measured run", verdict["basis"])
        self.assertIn("median", verdict["basis"])


class OutputLoads(unittest.TestCase):
    """The generated file must survive the REAL loader, both shapes."""

    def _assert_loads(self, out):
        proc = subprocess.run(
            [sys.executable, str(_LOADER), "--file", str(out), "--as-args"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0,
                         "policy-load rejected the generated policy: %s"
                         % proc.stderr)
        # An empty argv is policy-load's own vacuously-green case.
        self.assertTrue(proc.stdout.strip(),
                        "the generated policy implies no ci-gate flags")

    def test_policy_with_history_loads(self):
        ws = _workspace([1.10, 1.40, 1.20, 2.00])
        out = os.path.join(ws, "policy.json")
        self.assertEqual(_run(ws, "--out", out).returncode, 0)
        self._assert_loads(out)

    def test_policy_without_history_loads(self):
        ws = _workspace()
        out = os.path.join(ws, "policy.json")
        self.assertEqual(_run(ws, "--out", out).returncode, 0)
        self._assert_loads(out)


class NeverClobbers(unittest.TestCase):
    """An existing policy is reviewed and committed. Replacing it is a choice."""

    def test_refuses_to_overwrite_and_names_the_file(self):
        ws = _workspace([1.10, 1.40])
        out = pathlib.Path(ws) / "policy.json"
        original = '{"max_usd": 0.25, "require_receipt": true}\n'
        out.write_text(original, encoding="utf-8")

        proc = _run(ws, "--out", str(out))
        self.assertNotEqual(proc.returncode, 0,
                            "overwriting a committed policy exited 0")
        self.assertEqual(original, out.read_text(encoding="utf-8"),
                         "the existing policy was modified despite refusing")
        self.assertIn(str(out), proc.stdout + proc.stderr,
                      "the refusal did not name the file")

    def test_force_does_overwrite(self):
        ws = _workspace([1.10, 1.40])
        out = pathlib.Path(ws) / "policy.json"
        out.write_text('{"max_usd": 0.25, "require_receipt": true}\n',
                       encoding="utf-8")

        proc = _run(ws, "--out", str(out), "--force")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        policy = json.loads(out.read_text(encoding="utf-8"))
        self.assertNotEqual(0.25, policy.get("max_usd"),
                            "--force did not replace the old ceiling")


class WorkflowSnippet(unittest.TestCase):
    def test_snippet_is_labelled_untested(self):
        ws = _workspace([1.10, 1.40])
        out = os.path.join(ws, "policy.json")
        proc = _run(ws, "--out", out, "--print-workflow")
        self.assertIn("NOT TESTED", proc.stdout,
                      "a snippet this tool has never executed was presented "
                      "as ready to use")

    def test_does_not_write_into_github_dir(self):
        ws = _workspace([1.10, 1.40])
        out = os.path.join(ws, "policy.json")
        _run(ws, "--out", out, "--print-workflow")
        self.assertFalse(os.path.exists(os.path.join(ws, ".github")),
                         "the tool wrote into .github/, which is live")


if __name__ == "__main__":
    unittest.main()
