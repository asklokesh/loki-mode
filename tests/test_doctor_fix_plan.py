"""A remediation planner earns trust by what it REFUSES to say.

The value of "here is the exact command to fix your blocker" is entirely
destroyed by one fabricated command. A user who runs a guessed command and sees
it succeed at doing something irrelevant now trusts a system that is still
broken -- strictly worse off than if we had printed nothing. So the property
under test is not "every blocker gets a command". It is:

    A command is printed ONLY when its provenance is real. Otherwise we say we
    do not know, and we say it in a form no one can mistake for a command.

Four things are asserted, and the middle two are the ones that matter:

  1. Known blockers map to their real command (the feature works at all).
  2. An UNKNOWN blocker yields an honest no-fix line AND no command-shaped
     string. Asserting only the first half lets a mutation append a fabricated
     command next to the honest text and survive.
  3. Prerequisites sort first. Node.js before the provider, because doctor's
     own provider fix is `npm install -g ...` and npm ships with Node. Report
     order would hand the user a command that cannot run yet.
  4. Empty blockers reads as HEALTHY, and -- the vacuity guard -- a non-report
     that also yields zero blockers does NOT. `{}` parses fine and produces an
     empty plan; calling that healthy is the fake-green this repo refuses.

The failing fixture is a REAL capture, not a hand-written shape: it is what
`loki doctor --json` emitted with PATH stripped to /usr/bin:/bin, which is the
bare-machine case this tool exists for.
"""

import importlib.util
import io
import json
import pathlib
import sys
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"

# Load the hyphenated filename directly. sys.dont_write_bytecode is set FIRST
# and is load-bearing for the mutation probe, not a tidiness preference:
# spec_from_file_location caches a .pyc next to the source, and a probe that
# mutates then restores the file can leave the source and its bytecode at the
# same size and mtime granularity. Python then reuses the STALE bytecode and
# the suite runs the mutated code against a restored file -- which presents as
# a red test with a provably-correct source, and reads exactly like a real
# defect. Cost one debugging cycle here; do not remove this line.
sys.dont_write_bytecode = True

_spec = importlib.util.spec_from_file_location("doctor_fix", _LIB / "doctor-fix.py")
_df = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_df)

# Verbatim from `PATH=/usr/bin:/bin loki doctor --json` on macOS: Node.js gone,
# every provider CLI gone. Trimmed to the keys the planner reads.
_REAL_FAILING = {
    "summary": {"passed": 5, "failed": 2, "warnings": 6, "ok": False},
    "checks": [
        {"name": "Node.js", "command": "node", "found": False, "version": None,
         "required": "required", "min_version": "18.0", "status": "fail"},
        {"name": "Python 3", "command": "python3", "found": True, "version": "3.9.6",
         "required": "required", "min_version": "3.8", "status": "pass"},
        {"name": "jq", "command": "jq", "found": True, "version": "1.8.1",
         "required": "required", "min_version": None, "status": "pass"},
    ],
    "ai_provider": {
        "found": False, "status": "fail", "required": "required",
        "detail": "No AI provider CLI. Fix: npm install -g @anthropic-ai/claude-code",
    },
    "disk": {"available_gb": 30.0, "status": "pass"},
}

_HEALTHY = {
    "summary": {"passed": 12, "failed": 0, "warnings": 1, "ok": True},
    "checks": [{"name": "Node.js", "command": "node", "found": True,
                "version": "26.5.0", "required": "required",
                "min_version": "18.0", "status": "pass"}],
    "ai_provider": {"found": True, "status": "pass", "required": "required",
                    "detail": None},
    "disk": {"available_gb": 30.1, "status": "pass"},
}

# Anything that looks like an instruction the user could paste. If one of these
# shows up against an unrecognized blocker, the planner guessed.
#
# These are all "<verb> " with the trailing space, matching an INVOCATION. Bare
# "install" is deliberately excluded: the honest blocker text itself reads
# "... is not installed", so matching the bare word would fail on correct
# output and force the assertion to be weakened later -- a test that cries wolf
# gets deleted, and this is the one assertion that must survive.
_COMMAND_SHAPED = ("brew ", "apt-get ", "npm ", "bun ", "pip ", "yum ",
                   "install -g", "curl ", "sudo ", "https://")


def _step(p, blocker_id):
    for s in p["steps"]:
        if s["id"] == blocker_id:
            return s
    raise AssertionError("no step for %r in %r" % (blocker_id, [s["id"] for s in p["steps"]]))


class KnownBlockersMapToCommands(unittest.TestCase):
    def test_missing_node_gets_a_node_install_command(self):
        s = _step(_df.plan(_REAL_FAILING), "Node.js")
        self.assertTrue(s["fix_known"])
        self.assertIn("node", s["command"].lower())

    def test_provider_fix_is_reused_from_doctors_own_text(self):
        """The command must come from ai_provider.detail, not a private copy.

        If the planner ever stops parsing doctor's embedded "Fix:", doctor
        becomes one of two sources of truth that can silently disagree.
        """
        s = _step(_df.plan(_REAL_FAILING), "ai_provider")
        self.assertTrue(s["fix_known"])
        self.assertEqual(s["command"], "npm install -g @anthropic-ai/claude-code")

    def test_low_disk_is_reported_with_the_measured_number(self):
        rep = dict(_REAL_FAILING, disk={"available_gb": 0.4, "status": "fail"})
        s = _step(_df.plan(rep), "disk")
        self.assertIn("0.4GB", s["blocker"])

    def test_too_old_is_worded_differently_from_absent(self):
        rep = {"checks": [{"name": "Python 3", "found": True, "version": "3.6",
                           "required": "required", "min_version": "3.8",
                           "status": "fail"}]}
        self.assertIn("older", _step(_df.plan(rep), "Python 3")["blocker"])


class UnknownBlockersAreNeverFabricated(unittest.TestCase):
    """The core honesty property. Both halves, because one half is defeatable."""

    _UNKNOWN = {
        "summary": {"passed": 0, "failed": 1, "warnings": 0, "ok": False},
        "checks": [{"name": "Quantum Flux Capacitor", "command": "qfc",
                    "found": False, "version": None, "required": "required",
                    "min_version": None, "status": "fail"}],
    }

    def test_unknown_blocker_is_marked_as_having_no_known_fix(self):
        s = _step(_df.plan(self._UNKNOWN), "Quantum Flux Capacitor")
        self.assertFalse(s["fix_known"])
        self.assertIsNone(s["command"])

    def test_rendered_output_says_so_plainly(self):
        text = _df.render(_df.plan(self._UNKNOWN))
        self.assertIn("no automated fix known", text)

    def test_no_command_shaped_string_is_emitted_for_an_unknown_blocker(self):
        """Guards the mutation an "is the honest text present" test cannot see.

        Appending a plausible command NEXT TO the honest line leaves that line
        intact. This asserts the absence directly.
        """
        text = _df.render(_df.plan(self._UNKNOWN))
        body = text.split("Quantum Flux Capacitor", 1)[1].split("Then re-run", 1)[0]
        for token in _COMMAND_SHAPED:
            self.assertNotIn(token, body.lower(),
                             "fabricated command-shaped text %r for an unknown blocker: %r"
                             % (token, body))


class PrerequisitesComeFirst(unittest.TestCase):
    def test_node_is_ordered_before_the_provider_that_needs_npm(self):
        p = _df.plan(_REAL_FAILING)
        self.assertLess(_step(p, "Node.js")["order"], _step(p, "ai_provider")["order"])

    def test_disk_outranks_everything(self):
        rep = dict(_REAL_FAILING, disk={"available_gb": 0.2, "status": "fail"})
        self.assertEqual(_df.plan(rep)["steps"][0]["id"], "disk")

    def test_unknown_blockers_sort_last(self):
        rep = json.loads(json.dumps(_REAL_FAILING))
        rep["checks"].append({"name": "Mystery Tool", "found": False, "version": None,
                              "required": "required", "min_version": None,
                              "status": "fail"})
        self.assertEqual(_df.plan(rep)["steps"][-1]["id"], "Mystery Tool")


class EmptyMeansHealthyOnlyWhenMeasured(unittest.TestCase):
    def test_no_blockers_reads_as_healthy(self):
        p = _df.plan(_HEALTHY)
        self.assertEqual(p["status"], "healthy")
        self.assertEqual(p["steps"], [])
        self.assertIn("healthy", _df.render(p).lower())

    def test_healthy_output_does_not_read_as_a_failure(self):
        """No numbered steps and no no-fix line -- an empty plan reads as OK.

        Asserts the SHAPE, not the vocabulary: "reported no blockers" is a
        healthy sentence that happens to contain the word "blockers".
        """
        text = _df.render(_df.plan(_HEALTHY))
        self.assertNotIn("Remediation plan", text)
        self.assertNotIn("no automated fix known", text)
        self.assertNotIn("1. ", text)

    def test_an_empty_object_is_not_a_report_and_not_healthy(self):
        """The vacuity guard. `{}` yields zero blockers, same as a clean run."""
        p = _df.plan({})
        self.assertEqual(p["status"], "not_a_report")
        self.assertNotIn("healthy", _df.render(p).lower())

    def test_unparseable_input_is_not_healthy(self):
        self.assertEqual(_df.plan(None)["status"], "not_a_report")

    def test_a_parse_gap_is_reported_rather_than_hidden(self):
        """Doctor counted 3 failures; only 1 is derivable. Say so."""
        rep = {"summary": {"failed": 3}, "checks": [
            {"name": "jq", "found": False, "required": "required",
             "min_version": None, "status": "fail"}]}
        self.assertIn("parse_gap", _df.plan(rep))


class ItPlansAndNeverExecutes(unittest.TestCase):
    def test_plan_declares_it_did_not_execute(self):
        self.assertFalse(_df.plan(_REAL_FAILING)["executed"])

    def test_output_tells_the_user_the_commands_were_not_run(self):
        self.assertIn("NOT run for you", _df.render(_df.plan(_REAL_FAILING)))


class CommandLine(unittest.TestCase):
    def _run(self, payload, argv):
        stdin, stdout = sys.stdin, sys.stdout
        sys.stdin, sys.stdout = io.StringIO(json.dumps(payload)), io.StringIO()
        try:
            return _df.main(argv), sys.stdout.getvalue()
        finally:
            sys.stdin, sys.stdout = stdin, stdout

    def test_json_flag_emits_the_plan(self):
        code, out = self._run(_REAL_FAILING, ["--json"])
        self.assertEqual(code, 1)
        self.assertEqual({s["id"] for s in json.loads(out)["steps"]},
                         {"Node.js", "ai_provider"})

    def test_healthy_exits_zero_and_a_non_report_does_not(self):
        self.assertEqual(self._run(_HEALTHY, ["--json"])[0], 0)
        self.assertEqual(self._run({}, ["--json"])[0], 2)

    def test_report_file_is_read_from_disk(self):
        import tempfile, os
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            json.dump(_REAL_FAILING, fh)
        try:
            stdout = sys.stdout
            sys.stdout = io.StringIO()
            try:
                code = _df.main(["--report", path, "--json"])
                out = sys.stdout.getvalue()
            finally:
                sys.stdout = stdout
            self.assertEqual(code, 1)
            self.assertEqual(len(json.loads(out)["steps"]), 2)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
