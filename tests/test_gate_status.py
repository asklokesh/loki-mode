"""A status screen must not report health on an axis it could not read.

THE DEFECT CLASS THIS PINS. tools/gate-status.py answers one question --
"is this repo's merge gate set up and working?" -- by composing five other
tools. Every composition of that shape has exactly one interesting failure, and
this repo has now paid for it on more than fifteen surfaces:

    a component that could not be checked gets rendered as fine.

It arrives as a dash in a cell, a skipped row, a `.get(k, 0)`, an `or False`.
The screen still fills up, the verdict still reads healthy, and the operator
learns that the gate is working from a tool that did not look. That is strictly
worse than no status screen, because this one is trusted. So:

    UNKNOWN is a state, never a rendering artifact, and it always wins.

BOTH DIRECTIONS ARE ASSERTED, deliberately. The over-strict fix -- treat
anything uncertain as broken, or refuse to report OK at all -- is its own
dishonesty: it makes the healthy case indistinguishable from the blind one,
trains an operator to ignore the screen, and takes with it the measured data
the gate line exists to surface. A guard that can never say OK has the same
information content as one that always does. So MeasuredHealthIsStillReported
asserts a genuinely configured repo reads OK on every axis it really has, that
a measured cost history survives, and specifically that a measured ZERO median
survives as 0 rather than being flattened to UNKNOWN by a falsy check.

NOTHING HERE RE-DERIVES A COMPONENT RULE. The tests drive the real tools on
real temp workspaces. A test that stubbed policy validity or baseline drift
would pass against a gate-status that had quietly grown its own second copy of
those rules, which is the drift this file is also meant to prevent.
"""

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

# A stale .pyc makes a mutation probe report a FALSE failure: the probe edits
# the source, the loader serves the cached bytecode, and the test fails for a
# reason that has nothing to do with the mutation.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "gate-status.py"

_spec = importlib.util.spec_from_file_location("gate_status", _TOOL)
gs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gs)


def _run(*args, **kw):
    return subprocess.run([sys.executable, str(_TOOL), *args],
                          capture_output=True, text=True, timeout=180, **kw)


def _workspace(policy=None, history=None):
    """A temp workspace, optionally with a valid policy and a cost history."""
    d = tempfile.mkdtemp(prefix="loki-gate-status-")
    os.makedirs(os.path.join(d, ".loki"), exist_ok=True)
    if policy is not None:
        with open(os.path.join(d, ".loki-policy.json"), "w",
                  encoding="utf-8") as handle:
            json.dump(policy, handle)
    if history is not None:
        path = os.path.join(d, ".loki", "cost-history.jsonl")
        with open(path, "w", encoding="utf-8") as handle:
            for row in history:
                handle.write(json.dumps(row) + "\n")
    return d


def _state_of(result, component):
    for row in result["components"]:
        if row["component"] == component:
            return row["state"]
    raise AssertionError(
        "component %r is absent from the status entirely; a line that is "
        "dropped rather than reported UNKNOWN is the defect this file exists "
        "to catch" % component)


class AMissingComponentIsNeverHealthy(unittest.TestCase):
    """THE defect: a composed tool that is not on disk still reading OK.

    Pointing gate-status at a nonexistent tool path is the honest simulation of
    every real way a composed check goes dark: a rename, a file missing from
    the shipped package (which happened here to four quality-gate detectors),
    a partial checkout. The axis is not checked. The screen must say so, and
    the verdict must not be OK.
    """

    def setUp(self):
        # A workspace that is otherwise healthy, so the ONLY thing wrong is the
        # missing tool. If the verdict still came out OK, that would be the
        # missing component being silently skipped, not a healthy repo.
        self.ws = _workspace(
            policy={"max_usd": 5.0, "require_receipt": True},
            history=[{"usd": 0.30, "measured": True, "run": 1},
                     {"usd": 0.20, "measured": True, "run": 2}])
        self.addCleanup(shutil.rmtree, self.ws, True)
        self._saved = gs.SIGNING_STATUS
        gs.SIGNING_STATUS = os.path.join(
            os.path.dirname(self._saved), "no-such-signing-tool.py")

    def tearDown(self):
        gs.SIGNING_STATUS = self._saved

    def test_a_missing_tool_reads_unknown_not_ok(self):
        line = gs.check_signing()
        self.assertEqual(
            line["state"], gs.UNKNOWN,
            "a component tool that is not on disk was reported as %r; that "
            "axis was never checked, and absent is not OK"
            % line["state"])
        self.assertIn(
            "unavailable", line["detail"],
            "the line does not say the component is unavailable, so an "
            "operator cannot tell a blind axis from a checked one")

    def test_a_missing_component_drags_the_verdict_off_ok(self):
        """THE mutation target. Weakest-link, not a count.

        Everything else in this workspace is healthy. If the verdict is OK,
        the unavailable component was dropped from the decision -- the status
        screen reporting health on a repo it did not fully read.
        """
        result = gs.evaluate(self.ws)
        self.assertNotEqual(
            result["verdict"], gs.OK,
            "a component that could NOT be checked still produced an OK "
            "verdict; the screen reports the gate healthy on an axis it never "
            "read, which is the exact defect this tool exists to prevent")
        self.assertEqual(
            result["verdict"], gs.UNKNOWN,
            "an unavailable component must read UNKNOWN, never PROBLEM: 'we "
            "could not check' and 'we checked and it is broken' send an "
            "operator to fix different things")

    def test_the_missing_line_is_still_present_on_the_screen(self):
        """A dropped row is how the verdict silently gets easier."""
        result = gs.evaluate(self.ws)
        self.assertEqual(_state_of(result, "signing"), gs.UNKNOWN)
        self.assertEqual(
            len(result["components"]), 5,
            "a component line vanished instead of reporting UNKNOWN")

    def test_the_exit_code_matches_the_unknown_verdict(self):
        """Whatever a script branches on must agree with the screen."""
        result = gs.evaluate(self.ws)
        self.assertEqual(result["exit_code"], gs.EXIT_UNKNOWN)


class UnknownOutranksProblem(unittest.TestCase):
    """Precedence, for the same reason ci-gate.py orders them this way.

    Told PROBLEM, an operator fixes the named thing, re-runs, sees green, and
    is still blind on the dead axis. So a run with both must report UNKNOWN.
    """

    def test_verdict_is_weakest_link_never_a_count(self):
        for states, expected in (
                ([gs.OK, gs.OK, gs.OK], gs.OK),
                ([gs.OK, gs.PROBLEM, gs.OK], gs.PROBLEM),
                ([gs.OK, gs.UNKNOWN, gs.OK], gs.UNKNOWN),
                # Four of five healthy. A percentage would call this fine.
                ([gs.OK, gs.OK, gs.OK, gs.OK, gs.UNKNOWN], gs.UNKNOWN),
                ([gs.PROBLEM, gs.UNKNOWN], gs.UNKNOWN),
        ):
            with self.subTest(states=states):
                verdict = gs.UNKNOWN if gs.UNKNOWN in states else (
                    gs.PROBLEM if gs.PROBLEM in states else gs.OK)
                self.assertEqual(verdict, expected)

    def test_a_majority_healthy_workspace_is_not_reported_healthy(self):
        """The same rule through the real code path, not a restated formula."""
        ws = _workspace(policy={"max_usd": 5.0})
        self.addCleanup(shutil.rmtree, ws, True)
        result = gs.evaluate(ws)
        states = [r["state"] for r in result["components"]]
        self.assertIn(gs.OK, states, "nothing was healthy, so this proves "
                                     "nothing about weakest-link")
        self.assertNotEqual(
            result["verdict"], gs.OK,
            "some components were OK and the verdict followed the majority; "
            "a gate verdict is weakest-link, never a score")


class MeasuredHealthIsStillReported(unittest.TestCase):
    """The opposite error: an over-strict fix that can never say OK.

    A screen that reports UNKNOWN unconditionally is exactly as uninformative
    as one that reports OK unconditionally, and it destroys the measured cost
    data the gate line exists to surface.
    """

    def setUp(self):
        self.ws = _workspace(
            policy={"max_usd": 5.0, "require_receipt": True},
            history=[{"usd": 0.30, "measured": True, "run": 1},
                     {"usd": 0.25, "measured": True, "run": 2},
                     {"usd": 0.20, "measured": True, "run": 3}])
        self.addCleanup(shutil.rmtree, self.ws, True)
        self.result = gs.evaluate(self.ws)

    def test_a_valid_policy_reads_ok(self):
        self.assertEqual(
            _state_of(self.result, "policy"), gs.OK,
            "a valid, enforcing policy file was not reported OK; an "
            "over-strict guard has blanked a genuinely configured axis")

    def test_measured_cost_history_reads_ok_and_carries_the_numbers(self):
        line = [r for r in self.result["components"]
                if r["component"] == "cost_history"][0]
        self.assertEqual(
            line["state"], gs.OK,
            "three measured runs were reported as no history; the measured "
            "cost data this gate line exists to surface was suppressed")
        self.assertIn("3 measured run", line["detail"])
        self.assertIn("0.2500", line["detail"],
                      "the real median was dropped from the line")

    def test_would_run_is_yes_when_the_policy_loads(self):
        self.assertEqual(_state_of(self.result, "would_run"), gs.OK)

    def test_a_measured_zero_survives_as_zero(self):
        """`is None`, never falsy. A real $0.00 median is a MEASUREMENT.

        A cached-only run genuinely costs ~0. Rendering that as UNKNOWN is the
        same collapse as rendering unmeasured as $0.00, run backwards, and it
        would make a real cost regression from 0 invisible.
        """
        ws = _workspace(policy={"max_usd": 5.0},
                        history=[{"usd": 0.0, "measured": True, "run": 1},
                                 {"usd": 0.0, "measured": True, "run": 2}])
        self.addCleanup(shutil.rmtree, ws, True)
        line = [r for r in gs.evaluate(ws)["components"]
                if r["component"] == "cost_history"][0]
        self.assertEqual(
            line["state"], gs.OK,
            "a measured cost of exactly zero was treated as unmeasured")
        self.assertIn(
            "$0.0000", line["detail"],
            "a measured zero was rendered as UNKNOWN; absent is not zero, and "
            "zero is not absent")

    def test_an_unmeasured_history_reads_unknown_not_ok(self):
        """The forward direction of the same rule, on the same surface."""
        ws = _workspace(policy={"max_usd": 5.0},
                        history=[{"usd": None, "measured": False, "run": 1}])
        self.addCleanup(shutil.rmtree, ws, True)
        line = [r for r in gs.evaluate(ws)["components"]
                if r["component"] == "cost_history"][0]
        self.assertEqual(
            line["state"], gs.UNKNOWN,
            "a history with no measured run reported OK; unmeasured is not "
            "healthy, it is unknown")


class ItComposesRatherThanReimplements(unittest.TestCase):
    """A second copy of a rule is how the rule drifts. Five times, here."""

    def test_every_component_is_invoked_as_a_subprocess(self):
        source = _TOOL.read_text(encoding="utf-8")
        for tool in ("policy-load.py", "baseline-pin.py", "signing-status.py",
                     "cost-history.py"):
            with self.subTest(tool=tool):
                self.assertIn(
                    tool, source,
                    "%s is not referenced; its rule is either missing or has "
                    "been re-implemented here" % tool)
        self.assertIn("sys.executable", source)

    def test_it_does_not_restate_the_measured_predicate(self):
        """record_is_measured lives in efficiency_cost.py and is imported by
        cost-history.py. gate-status must ask cost-history, not re-derive it."""
        source = _TOOL.read_text(encoding="utf-8")
        self.assertNotIn(
            "def record_is_measured", source,
            "the measured-vs-unmeasured predicate was copied into this tool; "
            "that is the drift this repo has paid for repeatedly")


class ItIsReadOnlyAndSaysSo(unittest.TestCase):
    def test_the_output_states_that_it_spends_nothing(self):
        ws = _workspace(policy={"max_usd": 5.0})
        self.addCleanup(shutil.rmtree, ws, True)
        r = _run(ws)
        self.assertIn("spends nothing", r.stdout)
        self.assertIn("contacts no provider", r.stdout)

    def test_it_does_not_execute_the_real_gate(self):
        """ci-gate is the one composed call that is not free, so the
        would-run line is derived from the policy, never by running it."""
        source = _TOOL.read_text(encoding="utf-8")
        self.assertNotIn(
            'os.path.join(_HERE, "ci-gate.py")', source,
            "gate-status resolves ci-gate.py as a runnable path; a status "
            "screen that executes the gate is no longer read-only")

    def test_it_writes_nothing_into_the_workspace(self):
        ws = _workspace(policy={"max_usd": 5.0})
        self.addCleanup(shutil.rmtree, ws, True)
        before = sorted(
            os.path.join(dp, f) for dp, _, fs in os.walk(ws) for f in fs)
        _run(ws)
        after = sorted(
            os.path.join(dp, f) for dp, _, fs in os.walk(ws) for f in fs)
        self.assertEqual(before, after,
                         "a read-only status tool modified the workspace")


class ItObeysTheExitConvention(unittest.TestCase):
    """tests/test_tool_exit_contract.py globs tools/*.py and auto-adopts this
    one. These pin the same contract at the point it is easiest to break."""

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = _run("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("GATE:", r.stdout,
                         "--help issued a verdict about nothing")

    def test_an_unknown_flag_is_a_usage_error_not_a_blind_gate(self):
        """argparse defaults this to 2, which here means 'could not check'.

        A typo would then be indistinguishable from a genuinely blind gate,
        and the operator would go looking for broken instrumentation.
        """
        r = _run(".", "--no-such-flag")
        self.assertEqual(
            r.returncode, gs.EXIT_USAGE,
            "an unknown flag exited %d; 2 means 'could not be checked', so a "
            "typo would be mistaken for a blind gate" % r.returncode)

    def test_an_unknown_flag_is_never_read_as_a_path(self):
        r = _run("--no-such-flag")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("GATE: OK", r.stdout)

    def test_a_nonexistent_workspace_exits_66(self):
        r = _run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, gs.EXIT_MISSING)
        self.assertNotIn("GATE:", r.stdout,
                         "a verdict was issued about a path that is not there")

    def test_it_never_leaks_green_while_saying_it_could_not_check(self):
        """The green-leak rule, asserted here because the shared contract test
        does NOT apply it to this tool.

        tests/test_tool_exit_contract.py auto-adopts tools/*.py, but its gate
        membership matches "-gate." and "gate-status.py" does not contain that
        substring, so it is classed an advisor and exempted from the stricter
        rule. That classification is defensible (this is a status screen, and
        no CI job branches on it today) but it is one rename away from being
        wrong, and it leaves the sharpest rule in the repo unasserted for a
        tool whose name reads like a gate. So it is asserted here instead: if
        the output says the gate could not be verified, the exit code must not
        be 0.
        """
        ws = _workspace()  # nothing configured, so several axes are blind
        self.addCleanup(shutil.rmtree, ws, True)
        r = _run(ws)
        self.assertIn("UNKNOWN", r.stdout,
                      "this workspace has blind axes and none were reported")
        self.assertNotEqual(
            r.returncode, 0,
            "gate-status exited 0 while its own output says UNKNOWN; anything "
            "branching on this exit code would proceed on axes nobody read")

    def test_json_is_parseable_and_carries_the_verdict(self):
        ws = _workspace(policy={"max_usd": 5.0})
        self.addCleanup(shutil.rmtree, ws, True)
        r = _run(ws, "--json")
        payload = json.loads(r.stdout)
        self.assertIn(payload["verdict"], (gs.OK, gs.PROBLEM, gs.UNKNOWN))
        self.assertEqual(payload["exit_code"], r.returncode,
                         "the JSON verdict and the exit code disagree")
        self.assertTrue(payload["read_only"])


if __name__ == "__main__":
    unittest.main()
