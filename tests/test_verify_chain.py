"""A chain is only as strong as the link nobody ran.

WHAT THIS LOCKS DOWN. tools/verify-chain.py composes the verification tools --
receipt-bundle.py, receipt-stats.py, and cost-guard.py when a policy asks for
it -- into ONE verdict. Composition is where aggregation goes wrong, and it
goes wrong in one direction: toward green. The three ways it does so, and which
this file pins:

    silent skip            a stage tool absent from disk is dropped, and the
                           report shows only the stages that ran. This is the
                           worst of the three because it leaves no row to
                           notice: the reader sees green stages and cannot tell
                           whether that is all of them.
    scoring                "2 of 3 stages passed" is a score, not a gate, and
                           it gets CHEAPER to pass the more stages exist
    two states             collapsing "could not evaluate" into "failed" (or
                           worse, into "passed") loses the distinction that
                           decides whether an operator knows what they shipped

THE CENTRAL ASSERTION is the first, and it is deliberately written to fail
under an implementation that skips a missing tool rather than one that merely
mislabels it: it asserts BOTH that the stage is present and reads UNAVAILABLE
AND that the rollup is not OK. Asserting only the rollup would pass for a tool
that hardcodes non-OK; asserting only the row would pass for a tool that files
the row and greenlights anyway. Both, or neither is worth anything.

BOTH DIRECTIONS ARE ASSERTED, and the positive control is the load-bearing
half. "a missing tool sinks the chain" also passes for a tool that can never
report OK at all -- a chain permanently red is not honest, it is broken, and it
would make the whole surface unusable while looking maximally strict. So there
is a case that reaches OK with all three stages genuinely evaluated, and it
requires a REAL git work tree: outside one, proof-verify.py cannot re-derive
the recorded diff and every receipt is honestly UNVERIFIABLE, so no chain could
ever pass and the suite could not tell a working tool from a broken one.

That positive control also covers the over-strict direction on cost: a
genuinely measured cost must survive the whole chain as a real figure, and an
absent POLICY must not be mistaken for an absent TOOL. The first would blank
the cost surface, the second would make the tool exit non-zero on every
workspace that never configured a ceiling, which is most of them.
"""

import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"
_TOOL = _ROOT / "tools" / "verify-chain.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_pv = _load("proof_verify", _LIB / "proof-verify.py")
_vc = _load("verify_chain", _TOOL)


def _git(cwd, *args):
    return subprocess.run(["git"] + list(args), cwd=cwd,
                          capture_output=True, text=True, timeout=30)


def _receipt(base_sha, head_sha, usd=0.42):
    """A receipt every axis can genuinely be checked against."""
    facts = {
        "git": {"base_sha": base_sha, "head_sha": head_sha,
                "diff": {"count": 0, "insertions": 0, "deletions": 0}},
        "tests": {"status": "verified", "command": "pytest -q", "exit_code": 0},
        "execution": {"outcome": "complete", "exit_code": 0},
    }
    proof = {
        # "schema_version" is the key the generator writes
        # (proof-generator.py:1329). This fixture said "schema" and so
        # built a receipt no real run emits -- latent while nothing read
        # the field, and correctly refused once proof-verify.py began
        # enforcing it.
        "schema_version": "1.1",
        "facts": facts,
        "honesty": {"headline": _pv._compute_headline(facts, []),
                    "degraded": []},
        "cost": {"available": True, "usd": usd, "input_tokens": 1000,
                 "output_tokens": 50, "cache_read_tokens": 0,
                 "cache_creation_tokens": 0},
    }
    unsigned = dict(proof)
    unsigned.pop("verification", None)
    proof["verification"] = {
        "hash": hashlib.sha256(
            _pv._canonical(unsigned).encode("utf-8")).hexdigest()}
    return proof


class ChainCase(unittest.TestCase):
    """A real git work tree, so a receipt's drift axis is genuinely checkable."""

    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "t@example.com")
        _git(self.repo, "config", "user.name", "t")
        (pathlib.Path(self.repo) / "seed.txt").write_text("seed\n")
        _git(self.repo, "add", "seed.txt")
        _git(self.repo, "commit", "-q", "-m", "seed")
        self.head = _git(self.repo, "rev-parse", "HEAD").stdout.strip()

    def _efficiency(self, cost_usd=0.42):
        """A measured iteration record. This is what cost-guard reads."""
        eff = pathlib.Path(self.repo) / ".loki" / "metrics" / "efficiency"
        eff.mkdir(parents=True, exist_ok=True)
        (eff / "iteration-1.json").write_text(json.dumps({
            "iteration": 1, "input_tokens": 1000, "output_tokens": 50,
            "cache_read_tokens": 0, "cache_creation_tokens": 0,
            "cost_usd": cost_usd, "model": "x", "duration_ms": 1000,
            "status": "completed"}), encoding="utf-8")

    def _policy(self, body):
        (pathlib.Path(self.repo) / ".loki-policy.json").write_text(
            body, encoding="utf-8")

    def _commit_all(self):
        """Everything but the receipt must be committed BEFORE it is written.

        proof-verify.py re-derives the diff from the recorded base sha, and an
        untracked file counts. A receipt written while the policy file is still
        untracked is honestly UNVERIFIABLE -- the verifier doing its job, but
        it would silently deny this suite its positive control.
        """
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "fixture")
        self.head = _git(self.repo, "rev-parse", "HEAD").stdout.strip()

    def _write_receipt(self, name="r1", usd=0.42):
        d = pathlib.Path(self.repo) / ".loki" / "proofs" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "proof.json").write_text(
            json.dumps(_receipt(self.head, self.head, usd), indent=2),
            encoding="utf-8")

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(_TOOL), self.repo, "--repo-dir", self.repo,
             *args], capture_output=True, text=True, timeout=180)

    def _json(self, *args):
        proc = self._run("--json", *args)
        return json.loads(proc.stdout), proc.returncode

    def _stage(self, report, name):
        for stage in report["stages"]:
            if stage["stage"] == name:
                return stage
        return None


class AMissingStageToolIsNeverSkipped(ChainCase):
    """THE central defect: a stage that never ran, reported as health.

    A chain that drops the link it could not run reports a stronger claim than
    it earned, and does it invisibly. There is no row to notice, so the reader
    sees only stages that passed and has no way to tell that is all of them.
    """

    def test_a_missing_stage_tool_reads_unavailable_and_sinks_the_rollup(self):
        self._efficiency()
        self._commit_all()
        self._write_receipt()

        # Everything else is genuinely fine -- proven by the positive control
        # below, which runs this exact fixture and reaches OK. The ONLY thing
        # different here is that one stage tool is not on disk.
        original = _vc._RECEIPT_STATS
        _vc._RECEIPT_STATS = os.path.join(
            os.path.dirname(original), "no-such-stage-tool.py")
        self.addCleanup(setattr, _vc, "_RECEIPT_STATS", original)

        report = _vc.chain(self.repo, self.repo)
        stage = self._stage(report, "stats")

        # Both halves, and both are load-bearing. The row alone would pass for
        # a tool that files it and greenlights anyway; the rollup alone would
        # pass for a tool that is permanently red.
        self.assertIsNotNone(
            stage,
            "the stats stage vanished from the report entirely -- a skipped "
            "stage leaves no row to notice, which is exactly how a chain "
            "reports health for a link it never ran")
        self.assertEqual(
            stage["state"], _vc.UNAVAILABLE,
            "a stage whose tool is missing from disk was not reported "
            "UNAVAILABLE; the link never ran, which is the absence of "
            "evidence and not evidence of soundness")
        self.assertNotEqual(
            report["verdict"], _vc.PASSED,
            "the chain rolled up to PASSED while one of its stages never "
            "ran -- CI would merge on a link nobody executed")
        self.assertNotIn(
            "OK", report["summary"],
            "the summary says OK for a chain with an unrun link")
        self.assertNotEqual(
            report["exit_code"], 0,
            "exit 0 for a chain with an unrun stage: a caller branching on "
            "the exit code sees success on an axis nobody checked")

    def test_a_configured_budget_with_a_missing_guard_is_blind_not_skipped(self):
        """The seam where the two facts are easiest to merge.

        Budget is the only CONDITIONAL stage, so its function holds both "the
        rule was never requested" (drops out of the rollup, correctly) and "the
        tool is missing from disk" (must sink it) a few lines apart. Merging
        them is a requirement-2 violation that the two unconditional stages
        cannot detect: here a policy DOES ask for the ceiling, so silently
        taking the not-configured path would report health for a rule the
        operator explicitly requested and never got.
        """
        self._efficiency()
        self._policy('{"max_usd": 5.0}')
        self._commit_all()
        self._write_receipt()

        original = _vc._COST_GUARD
        _vc._COST_GUARD = os.path.join(
            os.path.dirname(original), "no-such-cost-guard.py")
        self.addCleanup(setattr, _vc, "_COST_GUARD", original)

        report = _vc.chain(self.repo, self.repo)
        stage = self._stage(report, "budget")
        self.assertIsNotNone(
            stage,
            "a requested budget ceiling whose tool is missing dropped out of "
            "the report as though it had never been configured")
        self.assertEqual(stage["state"], _vc.UNAVAILABLE)
        self.assertNotEqual(
            report["verdict"], _vc.PASSED,
            "the chain passed while the cost ceiling the policy asked for "
            "was never enforced")

    def test_the_missing_tool_is_named_so_the_operator_can_fix_it(self):
        """A blind stage that will not say WHICH tool is a dead end."""
        self._efficiency()
        self._commit_all()
        self._write_receipt()
        original = _vc._RECEIPT_BUNDLE
        _vc._RECEIPT_BUNDLE = os.path.join(
            os.path.dirname(original), "absent-bundle-tool.py")
        self.addCleanup(setattr, _vc, "_RECEIPT_BUNDLE", original)

        report = _vc.chain(self.repo, self.repo)
        stage = self._stage(report, "bundle")
        self.assertEqual(stage["state"], _vc.UNAVAILABLE)
        self.assertIn("absent-bundle-tool.py", stage["reason"])


class TheRollupIsTheWeakestLink(ChainCase):
    """Never a count, never a percentage, never a majority."""

    def test_one_failed_stage_fails_the_whole_chain(self):
        self.assertEqual(
            _vc.rollup([_vc.PASSED, _vc.PASSED, _vc.FAILED]), _vc.FAILED,
            "two passing stages outvoted one failure; any scoring rule makes "
            "a bad stage cheaper to hide the more good ones surround it")

    def test_unavailable_outranks_failed(self):
        """Precedence, and it is not arbitrary.

        With FAILED the operator fixes the named failure, re-runs, sees green,
        and is still blind on the dead link. "Your chain is partly blind"
        outranks "this stage failed".
        """
        self.assertEqual(
            _vc.rollup([_vc.FAILED, _vc.UNAVAILABLE]), _vc.UNAVAILABLE)
        self.assertEqual(
            _vc.rollup([_vc.PASSED, _vc.UNAVAILABLE]), _vc.UNAVAILABLE)

    def test_all_passed_is_the_only_way_to_reach_passed(self):
        self.assertEqual(_vc.rollup([_vc.PASSED, _vc.PASSED]), _vc.PASSED)

    def test_a_chain_is_empty_only_when_every_stage_found_nothing(self):
        """One blind stage among empty ones must not launder itself as 3.

        Exit 3 says "nothing to check here", which an operator reads as benign.
        A broken tool sitting beside two empty stages is not benign.
        """
        self.assertEqual(
            _vc.rollup([_vc.NOTHING, _vc.NOTHING]), _vc.NOTHING)
        self.assertEqual(
            _vc.rollup([_vc.NOTHING, _vc.UNAVAILABLE]), _vc.UNAVAILABLE,
            "a blind stage beside empty ones reported 'nothing to check', so "
            "a broken tool laundered itself as a benign empty workspace")
        self.assertEqual(
            _vc.rollup([_vc.NOTHING, _vc.FAILED]), _vc.FAILED)

    def test_three_states_are_kept_apart(self):
        """Not a boolean. Passed, failed, and could-not-check are three facts."""
        self.assertEqual(
            len({_vc.PASSED, _vc.FAILED, _vc.UNAVAILABLE}), 3)
        self.assertEqual(
            sorted(_vc.EXIT[s] for s in (_vc.PASSED, _vc.FAILED,
                                         _vc.UNAVAILABLE, _vc.NOTHING)),
            [0, 1, 2, 3])


class TheOverStrictDirection(ChainCase):
    """A fix so strict it suppresses genuine data is its own dishonesty.

    Every assertion above pushes toward reporting less. Alone they are
    satisfied by a tool that can never pass anything, which would make the
    whole chain unusable while looking maximally rigorous.
    """

    def test_a_sound_workspace_reaches_ok_with_every_stage_evaluated(self):
        self._efficiency(cost_usd=0.42)
        self._policy('{"max_usd": 5.0}')
        self._commit_all()
        self._write_receipt(usd=0.42)

        report, code = self._json()
        states = {s["stage"]: s["state"] for s in report["stages"]}
        self.assertEqual(
            states, {"bundle": _vc.PASSED, "stats": _vc.PASSED,
                     "budget": _vc.PASSED},
            "a genuinely sound workspace did not pass every stage; a chain "
            "that can never report OK is broken, not strict")
        self.assertEqual(report["verdict"], _vc.PASSED)
        self.assertEqual(code, 0)
        self.assertIn("OK", report["summary"])

    def test_a_measured_cost_survives_the_chain_as_a_real_figure(self):
        """The honesty rule pointed the other way.

        A guard that blanks a measured figure to avoid ever overstating is the
        same lie in reverse, and it would make the cost surface unmeasurable.
        """
        self._efficiency(cost_usd=0.42)
        self._policy('{"max_usd": 5.0}')
        self._commit_all()
        self._write_receipt(usd=0.42)

        report, _ = self._json()
        self.assertIn(
            "0.4200", self._stage(report, "budget")["reason"],
            "the measured cost was suppressed on the way through the chain")

    def test_an_absent_policy_is_not_an_absent_tool(self):
        """Two different facts, and merging them makes the tool useless.

        No policy means the budget rule was never REQUESTED. A missing cost
        guard means a requested rule was never APPLIED. If not-configured sank
        the chain, this would exit non-zero on every workspace without a
        policy, which is most of them, and a gate always red is one nobody
        reads.
        """
        self._efficiency()
        self._commit_all()
        self._write_receipt()

        report, code = self._json()
        self.assertIsNone(
            self._stage(report, "budget"),
            "an unconfigured budget was counted as a chain stage")
        self.assertEqual(report["verdict"], _vc.PASSED)
        self.assertEqual(code, 0)
        self.assertTrue(
            any("not configured" in n for n in report["notes"]),
            "the unconfigured budget rule was dropped silently; a reader "
            "cannot tell that no ceiling was enforced")

    def test_a_policy_that_cannot_be_read_is_blind_not_unconfigured(self):
        """The other side of the same line.

        The operator ASKED for a ceiling and did not get one. That is a blind
        stage, not an absent request.
        """
        self._efficiency()
        self._policy('{"max_usd": "not-a-number"}')
        self._commit_all()
        self._write_receipt()

        report, code = self._json()
        stage = self._stage(report, "budget")
        self.assertIsNotNone(stage)
        self.assertEqual(stage["state"], _vc.UNAVAILABLE)
        self.assertEqual(code, 2)

    def test_a_real_over_budget_run_is_failed_not_unavailable(self):
        """A measured breach is a finding, and must not blur into a blind spot."""
        self._efficiency(cost_usd=0.42)
        self._policy('{"max_usd": 0.01}')
        self._commit_all()
        self._write_receipt(usd=0.42)

        report, code = self._json()
        self.assertEqual(self._stage(report, "budget")["state"], _vc.FAILED)
        self.assertEqual(report["verdict"], _vc.FAILED)
        self.assertEqual(code, 1)


class ComposesRatherThanReimplements(ChainCase):
    """The rule that keeps the honesty rules from drifting into a second copy."""

    def test_every_stage_reason_is_the_childs_own_words(self):
        self._efficiency()
        self._policy('{"max_usd": 5.0}')
        self._commit_all()
        self._write_receipt()

        report, _ = self._json()
        # These sentences exist in the child tools, not in verify-chain.py.
        self.assertIn("VERIFIED", self._stage(report, "bundle")["reason"])
        self.assertIn("WITHIN BUDGET", self._stage(report, "budget")["reason"])

    def test_the_tool_does_not_restate_the_measurement_predicates(self):
        """Composition means the children apply the rule, exactly once."""
        source = _TOOL.read_text(encoding="utf-8")
        body = source.split('"""', 2)[-1]
        for restated in ("def record_is_measured", "def verify(",
                         "def _canonical", "sha256"):
            self.assertNotIn(
                restated, body,
                "verify-chain.py carries its own copy of %r; a second copy of "
                "a rule is how the rule drifts" % restated)


class TheExitContract(ChainCase):
    """The repo-wide convention, asserted here rather than only by the glob."""

    def test_an_empty_workspace_exits_three(self):
        os.makedirs(os.path.join(self.repo, ".loki"), exist_ok=True)
        proc = self._run()
        self.assertEqual(proc.returncode, 3)
        self.assertIn("NOTHING TO CHECK", proc.stdout)

    def test_a_nonexistent_workspace_exits_66_not_3(self):
        """'You pointed me at nothing' is not 'this workspace holds nothing'."""
        proc = subprocess.run(
            [sys.executable, str(_TOOL), "/nonexistent/definitely/not/here"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 66)

    def test_an_unknown_flag_exits_64_not_2(self):
        """2 means 'could not check' here, so a typo must not wear that code."""
        proc = subprocess.run(
            [sys.executable, str(_TOOL), "--no-such-flag"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(
            proc.returncode, 64,
            "a usage error exited %d; argparse's default 2 means 'could not "
            "check' in this repo, so a typo would masquerade as a blind gate"
            % proc.returncode)

    def test_help_exits_zero_and_issues_no_verdict(self):
        proc = subprocess.run(
            [sys.executable, str(_TOOL), "--help"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0)
        for verdict in ("UNAVAILABLE", "NOTHING TO CHECK", "OK --", "FAILED --"):
            self.assertNotIn(verdict, proc.stdout)

    def test_the_output_states_it_is_read_only(self):
        """An operator should not have to read the source to learn this."""
        os.makedirs(os.path.join(self.repo, ".loki"), exist_ok=True)
        self.assertIn("Read-only", self._run().stdout)


if __name__ == "__main__":
    unittest.main()
