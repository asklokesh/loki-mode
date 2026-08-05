"""A policy simulation must never count a run it could not simulate as a pass.

WHAT THIS TOOL IS FOR. tools/gate-simulate.py answers one question an operator
asks before adopting a merge policy: "would this have blocked my last N runs?"
The answer is a number, the number drives an adoption decision, and a number
with a broken denominator drives that decision wrong while looking authoritative.

THE DEFECT THIS FILE EXISTS TO CATCH, stated as the output it would produce:

    0 of 5 runs would have been blocked

...over a history where THREE of the five never recorded a cost. Nothing in
that sentence is false-looking. It is derived from two data points, it reads as
a green light, and it is produced by exactly one mistake -- letting an
unmeasured run fall through into the "would not have blocked" pile. That is
the same absence-rendered-as-compliance the rest of this repo has paid for
across seventeen surfaces: a receipt that said {"usd": 0.0, "available": true},
a prompt that told the agent its work was free, four detectors missing from the
shipped package, a tarball assertion that passed on "6 or more" of 6.

So the two directions, and BOTH are asserted here because fixing one by
breaking the other is not a fix:

  UnmeasuredIsNeverAPass      an unsimulatable run is UNEVALUABLE, excluded
                              from the block count, and forces a non-zero exit.
  GenuineDataStillSimulates   an over-strict guard that filed real runs under
                              "cannot evaluate" would make every simulation
                              read blind, which is its own dishonesty. A
                              measured $0.0000 is the sharp case: zero is falsy,
                              so a truthiness guard silently reclassifies the
                              cheapest real runs as unmeasurable.

THE FILE IS ALSO A GATE by name, so tests/test_tool_exit_contract.py adopts it
automatically and holds it to the strictest rule in that file. GateContract
below pins the same rule locally, where a failure names the behaviour rather
than the glob.

BOTH FILES SHIP TOGETHER. This test imports tools/gate-simulate.py; without the
tool it fails at COLLECTION, which takes down every Python job rather than one
test.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "gate-simulate.py"

_spec = importlib.util.spec_from_file_location("gate_simulate", _TOOL)
_gs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gs)


def _row(usd, measured=None, workspace="/tmp/does-not-matter"):
    """One cost-history row in the shape cost-history.py actually writes."""
    row = {"ts": 1.0, "workspace": workspace, "usd": usd, "model": "m"}
    if measured is not None:
        row["measured"] = measured
    return row


def _write(directory, name, rows):
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    return path


def _policy(directory, obj, name="policy.json"):
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(obj, handle)
    return path


def _run(*args):
    return subprocess.run(
        [sys.executable, str(_TOOL), *args],
        capture_output=True, text=True, timeout=120)


class UnmeasuredIsNeverAPass(unittest.TestCase):
    """The direction that would ship a false green light.

    Every assertion here is about the same run: one whose cost was never
    recorded. It must be counted in NEITHER the blocked nor the would-pass
    column, and its presence must be visible in the exit code.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        # Two measured runs (one over the ceiling, one under) and three that
        # were never measured. The shape that produces "0 of 5 blocked" when
        # the defect is present and the ceiling is high.
        self.mixed = _write(self.dir, "mixed.jsonl", [
            _row(0.50, True), _row(9.00, True),
            _row(None, False), _row(None, False), _row(None, False),
        ])
        self.policy = _policy(self.dir, {"max_usd": 5.0})

    def test_unmeasured_runs_are_excluded_from_the_block_count(self):
        """The count and its denominator, which is the whole product.

        THE ASSERTION THE MUTATION PROBE TARGETS. Flipping simulate_cost's
        unmeasured branch from CANNOT to PASS lands here: evaluable becomes 5
        instead of 2, and would_pass absorbs the three blind runs.
        """
        d = _gs.simulate(self.policy, self.mixed)
        self.assertEqual(d["runs"], 5)
        self.assertEqual(
            d["unevaluable"], 3,
            "three runs recorded no cost and cannot be simulated against a "
            "ceiling; counting them anywhere else invents data")
        self.assertEqual(
            d["evaluable"], 2,
            "only two runs carried a measured cost, so every count in this "
            "report is out of 2 -- reporting them out of 5 is the lie")
        self.assertEqual(d["blocked"], 1)
        self.assertEqual(
            d["would_pass"], 1,
            "an unmeasured run must never land in the would-pass column; that "
            "is the exact 'it was free' error, one level up")
        self.assertEqual(
            d["blocked"] + d["would_pass"] + d["unevaluable"], d["runs"],
            "every run must be accounted for in exactly one column")

    def test_an_unevaluable_run_forces_a_non_zero_exit(self):
        """gate-* means CI branches on this, so blindness cannot read green."""
        d = _gs.simulate(self.policy, self.mixed)
        self.assertEqual(d["exit_code"], _gs.CANNOT)
        self.assertNotEqual(
            d["exit_code"], _gs.PASS,
            "a simulation that could not evaluate 3 of 5 runs must not tell "
            "an operator the policy is safe to adopt")

    def test_blind_outranks_blocked(self):
        """Precedence, inherited from ci-gate.py and asserted rather than assumed.

        This history has BOTH a blocked run and unevaluable ones. Exiting 1
        would send the operator to raise the ceiling; they would re-run, see
        the block clear, and still be blind on three runs.
        """
        d = _gs.simulate(self.policy, self.mixed)
        self.assertGreater(d["blocked"], 0, "fixture must contain a real block")
        self.assertGreater(d["unevaluable"], 0)
        self.assertEqual(
            d["exit_code"], _gs.CANNOT,
            "a partly blind simulation reports blind, not blocked")

    def test_the_basis_is_stated_on_the_output_not_hidden(self):
        """A basis behind --verbose is a basis nobody reads."""
        r = _run(self.dir, "--policy", self.policy, "--file", self.mixed)
        self.assertIn("2 of 5", r.stdout,
                      "the count must carry its denominator on stdout")
        self.assertIn("UNEVALUABLE", r.stdout)
        self.assertEqual(r.returncode, _gs.CANNOT)

    def test_an_unmeasured_cost_never_renders_as_a_dollar_figure(self):
        """UNKNOWN, never $0.00. Absent is not zero."""
        r = _run(self.dir, "--policy", self.policy, "--file", self.mixed)
        self.assertIn("UNKNOWN", r.stdout)
        self.assertNotIn(
            "$0.0000", r.stdout,
            "no run in this fixture cost zero; a $0.0000 here means an "
            "unmeasured run was rendered as free")

    def test_a_history_of_only_unmeasured_runs_is_blind_not_empty(self):
        """Five things you tried and could not check is not 'nothing to check'.

        Exit 3 would say the history was empty, which is a different fact and
        sends the operator to record runs they have already recorded.
        """
        blind = _write(self.dir, "blind.jsonl", [_row(None, False)] * 5)
        d = _gs.simulate(self.policy, blind)
        self.assertEqual(d["runs"], 5)
        self.assertEqual(d["evaluable"], 0)
        self.assertEqual(d["exit_code"], _gs.CANNOT)
        self.assertNotEqual(
            d["exit_code"], _gs.NOTHING,
            "five unmeasurable runs is a blind instrument, not an empty file")

    def test_a_legacy_row_with_no_measured_flag_is_still_judged_honestly(self):
        """Rows written before the flag existed must not default to a pass."""
        legacy = _write(self.dir, "legacy.jsonl", [_row(None)])
        d = _gs.simulate(self.policy, legacy)
        self.assertEqual(d["unevaluable"], 1)
        self.assertEqual(d["would_pass"], 0)


class GenuineDataStillSimulates(unittest.TestCase):
    """The opposite error: an over-strict guard blanks the whole surface.

    A tool that answers UNEVALUABLE for everything is trivially never wrong and
    entirely useless, and it hides real policy consequences behind a permanent
    shrug. These assertions fail if the honesty guard is tightened into one.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.policy = _policy(self.dir, {"max_usd": 5.0})

    def test_a_measured_zero_survives_as_zero(self):
        """THE SHARP CASE. Zero is falsy; `if usd:` would drop a real run.

        A cached or free-tier run genuinely cost $0.0000. That is a
        measurement, it clears any ceiling, and filing it under "cannot
        evaluate" would make a perfectly instrumented free-tier history read
        as completely blind.
        """
        path = _write(self.dir, "zero.jsonl", [_row(0.0, True)])
        d = _gs.simulate(self.policy, path)
        self.assertEqual(
            d["unevaluable"], 0,
            "a measured $0.0000 is data, not an absent measurement")
        self.assertEqual(d["evaluable"], 1)
        self.assertEqual(d["would_pass"], 1)
        self.assertEqual(d["exit_code"], _gs.PASS)
        self.assertEqual(
            d["results"][0]["usd"], 0.0,
            "the measured zero must survive into the report as 0.0, not None")

    def test_a_measured_zero_renders_as_a_dollar_figure(self):
        path = _write(self.dir, "zero.jsonl", [_row(0.0, True)])
        r = _run(self.dir, "--policy", self.policy, "--file", path)
        self.assertIn("$0.0000", r.stdout)
        self.assertNotIn(
            "UNKNOWN", r.stdout,
            "a measured zero rendered as UNKNOWN erases a real observation")
        self.assertEqual(r.returncode, _gs.PASS)

    def test_a_policy_that_blocks_nothing_says_so_and_exits_zero(self):
        """The honest green. Without it the tool can never approve a policy."""
        path = _write(self.dir, "cheap.jsonl",
                      [_row(0.10, True), _row(0.20, True)])
        d = _gs.simulate(self.policy, path)
        self.assertEqual(d["blocked"], 0)
        self.assertEqual(d["evaluable"], 2)
        self.assertEqual(d["exit_code"], _gs.PASS)

    def test_a_real_block_is_reported_as_a_block(self):
        path = _write(self.dir, "pricey.jsonl",
                      [_row(0.10, True), _row(50.0, True)])
        d = _gs.simulate(self.policy, path)
        self.assertEqual(d["blocked"], 1)
        self.assertEqual(d["unevaluable"], 0)
        self.assertEqual(
            d["exit_code"], _gs.BLOCKED,
            "a fully measured history with a run over the ceiling is a "
            "definite answer, not a shrug")

    def test_the_ceiling_boundary_is_not_a_block(self):
        """Exactly at the ceiling passes: the gate is `>`, not `>=`."""
        path = _write(self.dir, "edge.jsonl", [_row(5.0, True)])
        d = _gs.simulate(self.policy, path)
        self.assertEqual(d["blocked"], 0)
        self.assertEqual(d["exit_code"], _gs.PASS)


class PolicyIsValidatedByPolicyLoad(unittest.TestCase):
    """The schema is policy-load.py's, decided by policy-load.py.

    A second validator drifts, and the drift surfaces as a policy this tool
    approved and the real gate then rejected.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.history = _write(self.dir, "h.jsonl", [_row(0.5, True)])

    def test_an_invalid_policy_is_refused_naming_the_file(self):
        bad = _policy(self.dir, {"max_usd_": 5.0})
        r = _run(self.dir, "--policy", bad, "--file", self.history)
        self.assertNotEqual(r.returncode, _gs.PASS)
        self.assertIn(bad, r.stdout + r.stderr,
                      "a refusal that does not name the file is a refusal the "
                      "operator cannot act on")

    def test_a_negative_ceiling_is_refused_rather_than_simulated(self):
        """-1 passes every run, so a simulation of it would report a clean 0."""
        bad = _policy(self.dir, {"max_usd": -1})
        d = _gs.simulate(bad, self.history)
        self.assertEqual(d["status"], "policy_refused")
        self.assertNotEqual(d["exit_code"], _gs.PASS)
        self.assertEqual(
            d["blocked"], 0, "a refused policy reports no counts at all")

    def test_a_missing_policy_file_is_input_missing_not_a_blind_gate(self):
        d = _gs.simulate(os.path.join(self.dir, "absent.json"), self.history)
        self.assertEqual(d["exit_code"], _gs.NO_INPUT)

    def test_a_valid_policy_is_actually_used(self):
        """Guards against a refusal path so eager nothing is ever simulated."""
        good = _policy(self.dir, {"max_usd": 5.0}, "good.json")
        d = _gs.simulate(good, self.history)
        self.assertEqual(d["policy"], {"max_usd": 5.0})
        self.assertEqual(d["evaluable"], 1)


class NoHistoryIsNotACleanResult(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.policy = _policy(self.dir, {"max_usd": 5.0})

    def test_an_absent_history_exits_non_zero(self):
        d = _gs.simulate(self.policy, os.path.join(self.dir, "nope.jsonl"))
        self.assertNotEqual(d["exit_code"], _gs.PASS)
        self.assertEqual(d["exit_code"], _gs.NO_INPUT)
        self.assertEqual(d["blocked"], 0)

    def test_an_empty_history_is_nothing_to_check_not_a_pass(self):
        """Zero runs blocked out of zero runs is not evidence of anything."""
        empty = _write(self.dir, "empty.jsonl", [])
        d = _gs.simulate(self.policy, empty)
        self.assertEqual(d["exit_code"], _gs.NOTHING)
        self.assertNotEqual(
            d["exit_code"], _gs.PASS,
            "a policy simulated against no runs blocks nothing, and that is "
            "not evidence it is safe to adopt")

    def test_corrupt_lines_are_counted_and_reported_never_dropped(self):
        """A history that quietly loses rows simulates a tidier past."""
        path = os.path.join(self.dir, "torn.jsonl")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(_row(0.5, True)) + "\n")
            handle.write("{not json\n")
            handle.write('{"ts": 3}\n')  # object, but carries no usd
        d = _gs.simulate(self.policy, path)
        self.assertEqual(d["corrupt_lines"], 2)
        self.assertEqual(d["runs"], 1)
        r = _run(self.dir, "--policy", self.policy, "--file", path)
        self.assertIn("CORRUPT", r.stdout)


class GateContract(unittest.TestCase):
    """The exit-code convention, pinned where a failure names the behaviour.

    tests/test_tool_exit_contract.py globs tools/*.py and adopts this tool
    automatically, which is the real enforcement. These restate the two rules
    most specific to this file so a regression reads as "the gate leaked green"
    rather than "the glob failed".
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.policy = _policy(self.dir, {"max_usd": 5.0})

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = _run("--help")
        self.assertEqual(r.returncode, 0)
        for token in ("WOULD BLOCK", "WOULD PASS", "UNEVALUABLE"):
            self.assertNotIn(token, r.stdout,
                             "--help answered a question nobody asked")

    def test_an_unknown_flag_is_a_usage_error_not_a_blind_gate(self):
        """64, never argparse's default 2, which here means 'could not check'.

        Left at the default, a typo'd flag reads to CI as a gate that went
        blind, and the operator hunts for instrumentation that was never
        missing.
        """
        r = _run(self.dir, "--policy", self.policy, "--bogus")
        self.assertEqual(r.returncode, _gs.USAGE)

    def test_an_unknown_flag_is_never_read_as_a_path(self):
        r = _run("--bogus")
        self.assertEqual(r.returncode, _gs.USAGE)
        self.assertNotIn("--bogus/.loki", r.stdout + r.stderr,
                         "a flag was treated as a workspace path")

    def test_a_nonexistent_workspace_never_reports_success(self):
        r = _run("/nonexistent/definitely/not/here", "--policy", self.policy)
        self.assertNotEqual(r.returncode, 0)

    def test_the_gate_never_exits_zero_while_saying_it_could_not_evaluate(self):
        """THE SHARPEST RULE. Scanned the way the contract test scans it.

        Runs every reachable shape and asserts that any output containing a
        cannot-evaluate token came with a non-zero exit. This is what stops a
        future edit adding an UNKNOWN column to a green report.
        """
        tokens = ("UNKNOWN", "UNEVALUABLE", "CANNOT", "not measured",
                  "NO BASIS", "UNMEASURED")
        cases = [
            ("mixed", [_row(0.5, True), _row(None, False)]),
            ("blind", [_row(None, False)]),
            ("clean", [_row(0.5, True)]),
            ("zero", [_row(0.0, True)]),
            ("blocked", [_row(99.0, True)]),
            ("empty", []),
        ]
        for name, rows in cases:
            path = _write(self.dir, name + ".jsonl", rows)
            with self.subTest(case=name):
                r = _run(self.dir, "--policy", self.policy, "--file", path)
                said = [t for t in tokens if t in (r.stdout + r.stderr)]
                if not said:
                    continue
                self.assertNotEqual(
                    r.returncode, 0,
                    "exited 0 while its own output says %r -- an operator "
                    "would adopt this policy on an axis nobody checked"
                    % said[0])

    def test_json_stays_json_on_every_path_including_refusals(self):
        """Fixed once already in this repo (9b879986). Diagnostics to stderr."""
        good = _write(self.dir, "ok.jsonl", [_row(0.5, True)])
        bad_policy = _policy(self.dir, {"nope": 1}, "bad.json")
        cases = [
            ("normal", [self.dir, "--policy", self.policy, "--file", good]),
            ("bad policy", [self.dir, "--policy", bad_policy, "--file", good]),
            ("missing policy", [self.dir, "--policy",
                                os.path.join(self.dir, "gone.json")]),
            ("missing history", [self.dir, "--policy", self.policy,
                                 "--file", os.path.join(self.dir, "gone.jsonl")]),
        ]
        for name, args in cases:
            with self.subTest(case=name):
                r = _run(*args, "--json")
                try:
                    parsed = json.loads(r.stdout)
                except ValueError as exc:
                    self.fail("--json emitted non-JSON on the %s path: %s"
                              % (name, exc))
                self.assertIn("exit_code", parsed)


class BothAxesAreSimulated(unittest.TestCase):
    """A policy key that is silently ignored is a vacuously green report.

    require_receipt is half of policy-load's schema. Simulating only max_usd
    would headline "0 would be blocked" for a policy whose other axis was never
    looked at.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.policy = _policy(self.dir, {"require_receipt": True})

    def test_a_vanished_workspace_is_unevaluable_not_a_pass(self):
        """It may well have had a receipt; a deleted directory is an absence.

        Scoring it as a block would manufacture an adoption objection out of
        nothing, which is the same dishonesty pointed the other way.
        """
        path = _write(self.dir, "gone.jsonl",
                      [_row(0.5, True, workspace="/nonexistent/gone")])
        d = _gs.simulate(self.policy, path)
        self.assertEqual(d["unevaluable"], 1)
        self.assertEqual(d["would_pass"], 0)
        self.assertEqual(d["blocked"], 0)
        self.assertEqual(d["exit_code"], _gs.CANNOT)

    def test_a_workspace_with_no_receipt_is_a_block_not_a_blind_spot(self):
        """Checked, and the answer is no. Same call ci-gate.py makes."""
        ws = os.path.join(self.dir, "ws")
        os.makedirs(os.path.join(ws, ".loki"), exist_ok=True)
        path = _write(self.dir, "noreceipt.jsonl",
                      [_row(0.5, True, workspace=ws)])
        d = _gs.simulate(self.policy, path)
        self.assertEqual(
            d["blocked"], 1,
            "an existing workspace with no receipt was genuinely checked")
        self.assertEqual(d["unevaluable"], 0)

    def test_a_tampered_receipt_is_blocked_via_the_shared_verifier(self):
        """verify() decides, never a re-implementation here."""
        ws = os.path.join(self.dir, "ws2")
        proof_dir = os.path.join(ws, ".loki", "proofs", "p1")
        os.makedirs(proof_dir, exist_ok=True)
        with open(os.path.join(proof_dir, "proof.json"), "w",
                  encoding="utf-8") as handle:
            json.dump({"verification": {"hash": "tampered"}, "cost": {},
                       "facts": {}, "honesty": {}}, handle)
        path = _write(self.dir, "tampered.jsonl",
                      [_row(0.5, True, workspace=ws)])
        d = _gs.simulate(self.policy, path)
        self.assertEqual(d["blocked"], 1)
        self.assertNotEqual(d["exit_code"], _gs.PASS)

    def test_an_intact_receipt_in_an_unresolvable_repo_is_unevaluable(self):
        """verify()'s verdict is not consumed whole, and this is why.

        verify() collapses "could not re-check against the repo"
        (diff_drift=None) into ok=False BY DESIGN -- correct for its question,
        "is this receipt verified?". This tool asks a different one: "would the
        policy have blocked this run?". A historical run whose branch was since
        deleted comes back hash_ok=True, diff_drift=None. Reporting that as
        WOULD BLOCK invents an adoption objection out of a missing measurement,
        which is the same dishonesty as inventing a pass.

        Asserted at the seam. Building a receipt with a valid integrity hash
        and a deliberately broken git ref is a rabbit hole that would test
        proof-verify rather than this file.
        """
        ws = os.path.join(self.dir, "ws3")
        proof_dir = os.path.join(ws, ".loki", "proofs", "p1")
        os.makedirs(proof_dir, exist_ok=True)
        with open(os.path.join(proof_dir, "proof.json"), "w",
                  encoding="utf-8") as handle:
            json.dump({"verification": {"hash": "x"}, "cost": {},
                       "facts": {}, "honesty": {}}, handle)
        path = _write(self.dir, "unresolvable.jsonl",
                      [_row(0.5, True, workspace=ws)])

        saved = _gs._pv.verify
        try:
            _gs._pv.verify = lambda *a, **k: {
                "ok": False, "hash_ok": True, "diff_drift": None,
                "reason": "could not resolve recorded git refs"}
            d = _gs.simulate(self.policy, path)
        finally:
            _gs._pv.verify = saved

        self.assertEqual(
            d["unevaluable"], 1,
            "an intact receipt that could not be re-checked is a missing "
            "measurement, not a policy violation")
        self.assertEqual(
            d["blocked"], 0,
            "reporting it as blocked manufactures an adoption objection")
        self.assertEqual(d["would_pass"], 0)
        self.assertEqual(d["exit_code"], _gs.CANNOT)

    def test_an_unsimulatable_policy_key_is_refused_naming_the_key(self):
        """If policy-load grows a key, silence is the failure, not the fix."""
        history = _write(self.dir, "h.jsonl", [_row(0.5, True)])
        # Simulate the future: a policy carrying a key this tool cannot replay.
        saved = _gs.SIMULATABLE_KEYS
        try:
            _gs.SIMULATABLE_KEYS = ("require_receipt",)
            policy = _policy(self.dir, {"max_usd": 5.0}, "future.json")
            out = _gs.simulate(policy, history)
        finally:
            _gs.SIMULATABLE_KEYS = saved
        self.assertEqual(out["status"], "policy_unsimulatable")
        self.assertNotEqual(out["exit_code"], _gs.PASS)
        self.assertIn("max_usd", out["why"],
                      "the refusal must name the key it cannot replay")


class ReusesSharedPredicatesRatherThanRestatingThem(unittest.TestCase):
    """A second copy of an honesty rule is how the honesty rule drifts."""

    def test_row_usd_defers_to_the_shared_measured_predicate(self):
        """A legacy row with no flag is adjudicated by record_is_measured()."""
        self.assertIs(_gs.record_is_measured,
                      __import__("efficiency_cost").record_is_measured)

    def test_row_usd_keeps_a_measured_zero_and_drops_an_absent_one(self):
        """The two rows that look identical to a truthiness check."""
        self.assertEqual(_gs.row_usd({"usd": 0.0, "measured": True}), 0.0)
        self.assertIsNone(_gs.row_usd({"usd": None, "measured": False}))

    def test_a_bool_is_not_a_cost(self):
        """True is an int in Python and would float to a $1.00 measurement."""
        self.assertIsNone(_gs.row_usd({"usd": True, "measured": True}))

    def test_the_verifier_is_the_shared_one(self):
        self.assertTrue(hasattr(_gs._pv, "verify"))


if __name__ == "__main__":
    unittest.main()
