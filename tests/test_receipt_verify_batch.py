"""A receipt that is NOT THERE must sink the batch, not vanish from it.

THE DEFECT THIS FILE EXISTS TO CATCH. receipt-verify-batch takes an EXPLICIT
list because a PR touches a known set of receipts. The failure mode unique to
that shape is an absence: a path in the list that is not on disk. The tempting
implementation skips it --

    for p in paths:
        if not os.path.exists(p):
            continue          # <-- the whole bug
        ...

-- and the result is a batch that reports VERIFIED while saying nothing about
the receipt the reviewer actually asked about. It is the worst possible shape
of dishonesty here, because it is loudest (a confident green) at exactly the
moment its input was wrong. `MissingIsCountedAndNamed` is the direction that
catches it, and the mutation probe drives that specific edit.

BOTH DIRECTIONS ARE ASSERTED, because a fix that over-corrects is its own
dishonesty:

  * the defect direction -- absence, failure and unverifiability each sink the
    batch and are named in the output.
  * the over-strict direction -- a batch of genuinely good receipts still reads
    VERIFIED and exits 0, a genuinely measured $0.00 still survives as 0.0
    rather than being erased into UNKNOWN, and an honestly unmeasured receipt
    still verifies. A tool that can only say FAILED is not a gate, it is a
    broken gate, and it would make the cost surface unreadable again.

THREE STATES ARE NEVER COLLAPSED. verify()'s `ok` is False both for a tampered
receipt and for an honest one checked from the wrong directory. A batch that
reports those identically cannot be acted on: one is a forgery, the other is a
re-run from the right repo. So FAILED, UNVERIFIABLE and MISSING are asserted
distinct, not merely non-zero.

WEAKEST LINK, NEVER AN AVERAGE. Asserted with many good receipts around one
bad one, which is the arrangement any averaging rule passes and the weakest
link rule fails.
"""

import hashlib
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

# A stale .pyc for a hyphenated module loaded by path makes a mutation probe
# report a FALSE pass: the probe edits the source, the loader serves the old
# bytecode. Must be set before any loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"
_TOOL = _ROOT / "tools" / "receipt-verify-batch.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_pv = _load("proof_verify", _LIB / "proof-verify.py")
_rvb = _load("receipt_verify_batch", _TOOL)


def _git(cwd, *args):
    return subprocess.run(["git"] + list(args), cwd=cwd,
                          capture_output=True, text=True, timeout=30)


def _make_repo(path):
    """A real git work tree with one commit. Returns the commit sha.

    Without a real repo the drift axis is unverifiable and NO receipt can ever
    read VERIFIED, which would leave this suite unable to tell a working tool
    from one that hardcodes a failing verdict. The positive control is what
    makes the negative assertions mean anything.
    """
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "t@example.com")
    _git(path, "config", "user.name", "t")
    # A global commit.gpgsign=true makes the seed commit fail SILENTLY here:
    # rev-parse returns empty, every receipt gets base_sha="", the drift axis
    # goes unverifiable, and every positive control in this file collapses at
    # once. That reproduces on one developer's machine and not another, which
    # is the most expensive shape of test failure there is.
    _git(path, "config", "commit.gpgsign", "false")
    (pathlib.Path(path) / "seed.txt").write_text("seed\n")
    _git(path, "add", "seed.txt")
    _git(path, "commit", "-q", "-m", "seed")
    return _git(path, "rev-parse", "HEAD").stdout.strip()


def _receipt(base_sha, head_sha, usd=0.42, measured=True):
    """A receipt every axis can genuinely be checked against.

    measured=False is the HONEST unmeasured shape: available=false, no values.
    It must not contribute to the batch total and it must still VERIFY -- "this
    run did not measure cost" is a truthful receipt, and a batch containing one
    is not thereby forged.
    """
    facts = {
        "git": {"base_sha": base_sha, "head_sha": head_sha,
                "diff": {"count": 0, "insertions": 0, "deletions": 0}},
        "tests": {"status": "verified", "command": "pytest -q", "exit_code": 0},
        "execution": {"outcome": "complete", "exit_code": 0},
    }
    cost = ({"available": True, "usd": usd, "input_tokens": 1000,
             "output_tokens": 50, "cache_read_tokens": 0,
             "cache_creation_tokens": 0}
            if measured else
            {"available": False, "usd": None, "input_tokens": 0,
             "output_tokens": 0, "cache_read_tokens": 0,
             "cache_creation_tokens": 0})
    proof = {
        "schema": "1.1",
        "facts": facts,
        "honesty": {"headline": _pv._compute_headline(facts, []),
                    "degraded": []},
        "cost": cost,
    }
    unsigned = dict(proof)
    unsigned.pop("verification", None)
    proof["verification"] = {
        "hash": hashlib.sha256(
            _pv._canonical(unsigned).encode("utf-8")).hexdigest()}
    return proof


class BatchCase(unittest.TestCase):
    """A set of receipts inside a real git repo, verified as an explicit list."""

    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.head = _make_repo(self.repo)

    def _write(self, name, proof):
        d = pathlib.Path(self.repo) / ".loki" / "proofs" / name
        d.mkdir(parents=True, exist_ok=True)
        path = d / "proof.json"
        path.write_text(json.dumps(proof, indent=2), encoding="utf-8")
        return str(path)

    def _good(self, name, usd=0.42, measured=True):
        return self._write(name, _receipt(self.head, self.head, usd, measured))

    def _tampered(self, name):
        """Facts edited after the hash was computed. A checked FAILURE."""
        proof = _receipt(self.head, self.head)
        proof["facts"]["tests"]["exit_code"] = 99
        return self._write(name, proof)

    def _missing(self, name="never-generated"):
        """A path in the list that was never written. Not a file on disk."""
        return str(pathlib.Path(self.repo) / ".loki" / "proofs" / name
                   / "proof.json")

    def _batch(self, paths, repo_dir=None):
        return _rvb.batch(paths, repo_dir or self.repo)

    def _run(self, *args, stdin=None):
        return subprocess.run(
            [sys.executable, str(_TOOL), *args],
            capture_output=True, text=True, timeout=120,
            input=stdin, cwd=self.repo)


class MissingIsCountedAndNamed(BatchCase):
    """THE defect direction. A path that is not there must never vanish.

    Every assertion here fails if the implementation skips a nonexistent path,
    and they fail in DIFFERENT ways on purpose: the count, the naming, and the
    verdict are three independent observations of the same absence. A partial
    fix that names the path but still lets the batch pass is caught by the
    verdict assertion alone.
    """

    def test_a_missing_path_sinks_an_otherwise_perfect_batch(self):
        """The exact arrangement a silent skip would report as VERIFIED.

        Three genuinely good receipts and one absent one. Skipping the absent
        path leaves three VERIFIED, and the weakest-link rollup over three
        VERIFIED is VERIFIED. This is the assertion the mutation probe drives.
        """
        paths = [self._good("run-%d" % i) for i in range(3)]
        paths.append(self._missing())
        report = self._batch(paths)
        self.assertEqual(
            report["verdict"], _rvb.MISSING,
            "a receipt that is not on disk was skipped, so the batch certified "
            "a set that is not the set it was asked about")

    def test_the_missing_path_is_counted_not_dropped(self):
        """The list is a claim about a SET. Its length must survive."""
        paths = [self._good("run-0"), self._missing()]
        report = self._batch(paths)
        self.assertEqual(
            len(report["receipts"]), 2,
            "the batch reported on fewer receipts than it was given; an "
            "absence was dropped rather than counted")
        self.assertEqual(report["counts"][_rvb.MISSING], 1)

    def test_the_missing_path_is_named_in_the_output(self):
        """Counted but anonymous is not actionable. Say WHICH one."""
        gone = self._missing("gone-forever")
        report = self._batch([self._good("run-0"), gone])
        self.assertIn(gone, report["missing"])
        self.assertIn(
            gone, [r["path"] for r in report["not_verified"]],
            "the absent receipt is not in not_verified, so a reader scanning "
            "that list would believe every listed receipt was checked")
        entry = [r for r in report["receipts"] if r["path"] == gone][0]
        self.assertIn(
            "gone-forever", entry["reason"],
            "the reason does not name the path, so an operator cannot tell "
            "which receipt of the batch is absent")

    def test_missing_exits_66_not_zero(self):
        """The CLI surface. CI branches on this number, not on the prose."""
        r = self._run(self._good("run-0"), self._missing())
        self.assertEqual(
            r.returncode, 66,
            "a batch with an absent receipt exited %d; CI would merge having "
            "verified a different set than it asked about" % r.returncode)

    def test_a_directory_is_missing_not_a_crash(self):
        """`.loki/proofs/run-0` is a plausible typo for the receipt inside it."""
        good = self._good("run-0")
        as_dir = str(pathlib.Path(good).parent)
        report = self._batch([as_dir])
        self.assertEqual(report["verdict"], _rvb.MISSING)
        self.assertIn("directory", report["receipts"][0]["reason"])


class ThreeStatesNeverCollapse(BatchCase):
    """FAILED, UNVERIFIABLE and MISSING are different facts about the world.

    All three are non-passing, so a tool that returns any non-zero code looks
    correct from a distance. They are asserted DISTINCT because the remedies
    differ: a forgery, a wrong working directory, and a receipt that was never
    generated are three different things to go do.
    """

    def test_a_tampered_receipt_is_failed_not_unverifiable(self):
        report = self._batch([self._tampered("bad")])
        self.assertEqual(report["receipts"][0]["state"], _rvb.FAILED)
        self.assertEqual(report["verdict"], _rvb.FAILED)

    def test_a_receipt_checked_from_a_non_repo_is_unverifiable_not_failed(self):
        """The honest receipt read from the wrong directory.

        verify()'s `ok` is False here exactly as it is for the tampered
        receipt. Reading `ok` alone -- the tempting shortcut -- collapses these
        two and tells the operator their receipt is forged when it is fine.
        """
        elsewhere = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, elsewhere, ignore_errors=True)
        report = self._batch([self._good("run-0")], repo_dir=elsewhere)
        self.assertEqual(
            report["receipts"][0]["state"], _rvb.UNVERIFIABLE,
            "an honest receipt checked from a non-repo was reported as FAILED, "
            "sending the operator hunting a forgery that does not exist")
        self.assertTrue(
            report["receipts"][0]["reason"],
            "UNVERIFIABLE without a reason is not actionable")

    def test_unverifiable_exits_2_and_missing_exits_66(self):
        """Distinct exit codes, so a script can tell them apart too."""
        elsewhere = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, elsewhere, ignore_errors=True)
        r = self._run(self._good("run-0"), "--repo-dir", elsewhere)
        self.assertEqual(r.returncode, 2)
        r = self._run(self._missing())
        self.assertEqual(r.returncode, 66)

    def test_a_failed_receipt_is_never_reported_as_verified(self):
        report = self._batch([self._tampered("bad")])
        self.assertNotIn(
            _rvb.VERIFIED, [r["state"] for r in report["receipts"]])


class WeakestLinkNotAverage(BatchCase):
    """One bad receipt sinks the batch regardless of how many good ones."""

    def test_one_failure_among_many_good_sinks_the_batch(self):
        """The arrangement every averaging rule passes."""
        paths = [self._good("run-%d" % i) for i in range(9)]
        paths.append(self._tampered("bad"))
        report = self._batch(paths)
        self.assertEqual(
            report["verdict"], _rvb.FAILED,
            "9 of 10 verified was treated as a score; a gate is weakest-link, "
            "and a bad receipt must not get cheaper to hide as good ones are "
            "added around it")

    def test_missing_outranks_failed(self):
        """Fix the input before reading the output.

        With both present, MISSING wins: every other verdict in the report is a
        statement about a different set than the one asked about.
        """
        report = self._batch([self._tampered("bad"), self._missing()])
        self.assertEqual(report["verdict"], _rvb.MISSING)

    def test_failed_outranks_unverifiable(self):
        elsewhere = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, elsewhere, ignore_errors=True)
        states = [_rvb.UNVERIFIABLE, _rvb.VERIFIED, _rvb.FAILED]
        self.assertEqual(_rvb.rollup(states), _rvb.FAILED)

    def test_rollup_is_order_independent(self):
        """A weakest-link rule cannot depend on argument order."""
        base = [_rvb.VERIFIED, _rvb.UNVERIFIABLE, _rvb.FAILED, _rvb.MISSING]
        self.assertEqual(_rvb.rollup(base), _rvb.MISSING)
        self.assertEqual(_rvb.rollup(list(reversed(base))), _rvb.MISSING)


class EmptyIsNotAPass(BatchCase):
    """Verifying nothing and finding nothing wrong are different claims."""

    def test_no_paths_is_empty_not_verified(self):
        report = self._batch([])
        self.assertEqual(report["verdict"], _rvb.EMPTY)
        self.assertNotEqual(report["verdict"], _rvb.VERIFIED)

    def test_no_paths_exits_non_zero(self):
        r = self._run()
        self.assertNotEqual(
            r.returncode, 0,
            "an empty batch exited 0; a CI glob that matched zero receipts "
            "would read as a passing audit")
        self.assertEqual(r.returncode, 3)

    def test_empty_stdin_exits_non_zero(self):
        """The pipe route has the same hole and needs the same assertion."""
        r = self._run("--stdin", stdin="")
        self.assertEqual(r.returncode, 3)

    def test_the_empty_summary_says_nothing_was_checked(self):
        report = self._batch([])
        self.assertIn("not a pass", report["summary"].lower())


class GoodReceiptsStillPass(BatchCase):
    """The over-strict direction. A gate that only says no is a broken gate.

    Without these, every assertion above is satisfied by `return FAILED`, and
    the tool would be useless in the way that is hardest to notice: it would
    look maximally rigorous.
    """

    def test_all_good_batch_verifies_and_exits_zero(self):
        paths = [self._good("run-%d" % i) for i in range(3)]
        report = self._batch(paths)
        self.assertEqual(
            report["verdict"], _rvb.VERIFIED,
            "genuinely good receipts did not verify; the tool cannot "
            "distinguish sound evidence from forged evidence")
        r = self._run(*paths, "--repo-dir", self.repo)
        self.assertEqual(r.returncode, 0)

    def test_a_verified_receipt_carries_no_fabricated_reason(self):
        report = self._batch([self._good("run-0")])
        self.assertEqual(report["receipts"][0]["reason"], "")
        self.assertEqual(report["not_verified"], [])

    def test_stdin_route_matches_the_argv_route(self):
        paths = [self._good("run-%d" % i) for i in range(2)]
        r = self._run("--stdin", "--repo-dir", self.repo,
                      stdin="\n".join(paths) + "\n")
        self.assertEqual(r.returncode, 0)
        for p in paths:
            self.assertIn(p, r.stdout)

    def test_blank_stdin_lines_are_not_missing_receipts(self):
        """A trailing newline is not a receipt that failed to exist."""
        paths = [self._good("run-0")]
        r = self._run("--stdin", "--repo-dir", self.repo,
                      stdin="\n\n" + paths[0] + "\n\n")
        self.assertEqual(
            r.returncode, 0,
            "a blank line was read as a receipt path, so ordinary pipe "
            "whitespace would fail every batch")


class MeasuredZeroSurvives(BatchCase):
    """Absent is not zero, and a measured zero is not absent.

    Both halves are load-bearing and they pull in opposite directions, which is
    why they are asserted together: a guard written with truthiness satisfies
    one and violates the other.
    """

    def test_unmeasured_cost_reads_unknown_never_zero(self):
        report = self._batch([self._good("run-0", measured=False)])
        self.assertIsNone(
            report["cost"]["total_usd"],
            "an unmeasured batch reported a number; unmeasured must read "
            "UNKNOWN, never $0.00")
        self.assertEqual(report["cost"]["measured_receipts"], 0)
        self.assertIn("UNKNOWN", report["summary"])

    def test_a_genuinely_measured_zero_survives_as_zero(self):
        """`if not total` would erase this into UNKNOWN. `is None` does not."""
        report = self._batch([self._good("run-0", usd=0.0)])
        self.assertIsNotNone(
            report["cost"]["total_usd"],
            "a receipt that genuinely measured $0.00 was erased into "
            "UNKNOWN; a measured zero is an observation, not an absence")
        self.assertEqual(report["cost"]["total_usd"], 0.0)
        self.assertEqual(report["cost"]["measured_receipts"], 1)

    def test_an_honestly_unmeasured_receipt_still_verifies(self):
        """Not measuring cost is truthful. It is not a verification failure."""
        report = self._batch([self._good("run-0", measured=False)])
        self.assertEqual(report["verdict"], _rvb.VERIFIED)

    def test_a_missing_receipt_contributes_no_cost(self):
        report = self._batch([self._good("run-0", usd=1.25), self._missing()])
        self.assertEqual(report["cost"]["measured_receipts"], 1)
        self.assertEqual(report["cost"]["total_usd"], 1.25)


class ExitContract(BatchCase):
    """The repo-wide convention, asserted here rather than only by the glob."""

    def test_help_exits_zero_and_emits_no_verdict(self):
        """receipt-attest read `--help` as a proof path and judged it.

        To a script parsing the output, a verdict about a nonexistent file is
        indistinguishable from a real finding about a real receipt.
        """
        r = self._run("--help")
        self.assertEqual(r.returncode, 0)
        out = r.stdout + r.stderr
        for word in (_rvb.VERIFIED, _rvb.FAILED, _rvb.UNVERIFIABLE,
                     "no such receipt"):
            self.assertNotIn(
                word, out,
                "--help emitted %r; a help request is not a question about a "
                "receipt" % word)

    def test_an_unknown_flag_is_a_usage_error_not_a_path(self):
        """64, never 2. A typo must not masquerade as an honest inability.

        argparse defaults to 2, which in this repo means "could not be
        checked" -- so a mistyped flag would be indistinguishable from a gate
        that ran and found itself blind.
        """
        r = self._run("--no-such-flag")
        self.assertEqual(
            r.returncode, 64,
            "an unknown flag exited %d; 2 would read as 'could not check' and "
            "a typo would masquerade as a blind gate" % r.returncode)

    def test_a_flag_is_never_treated_as_a_receipt_path(self):
        r = self._run("--no-such-flag")
        self.assertNotIn("no such receipt", (r.stdout + r.stderr).lower())

    def test_json_route_is_parseable_on_the_failure_path(self):
        """--json must emit JSON even when the verdict is bad."""
        r = self._run("--json", self._tampered("bad"), "--repo-dir", self.repo)
        self.assertEqual(r.returncode, 1)
        parsed = json.loads(r.stdout)
        self.assertEqual(parsed["verdict"], _rvb.FAILED)


class ReusesRatherThanReimplements(unittest.TestCase):
    """The classifier is imported, not restated.

    A second copy of the three-state rule is how the honesty rule drifts: the
    four surfaces that once rendered an unmeasured run as "$0.00" each had
    their own idea of what counted as measured. This asserts the shared
    definition is the one in use, so a fix upstream reaches this tool.
    """

    def test_receipt_state_is_the_bundle_definition(self):
        """Asserted by ORIGIN, not by object identity.

        Two `exec_module` calls on the same file produce equal-but-distinct
        code objects, so `assertIs` would fail against a correct tool. What
        actually matters is that the function the batch runs was DEFINED in
        receipt-bundle.py -- a local copy would report this file instead, and
        that is the drift being guarded.
        """
        self.assertEqual(
            pathlib.Path(_rvb.receipt_state.__code__.co_filename).name,
            "receipt-bundle.py",
            "receipt_state is defined locally rather than imported; a second "
            "copy of the three-state rule will drift from the first")

    def test_rollup_is_not_a_copy_of_a_scoring_rule(self):
        """The weakest-link rule stays weakest-link under a longer list.

        rollup() IS redefined here (MISSING is a state receipt-bundle has no
        concept of), so unlike receipt_state it cannot be asserted by origin.
        This asserts the property instead.
        """
        for bad in (_rvb.MISSING, _rvb.FAILED, _rvb.UNVERIFIABLE):
            states = [_rvb.VERIFIED] * 50 + [bad]
            self.assertEqual(
                _rvb.rollup(states), bad,
                "50 good receipts diluted one %s; that is a score, not a "
                "gate" % bad)

    def test_verify_is_reached_through_the_shared_chain(self):
        """The chain is asserted by BEHAVIOUR, not by grepping the source.

        A source-text assertion ("hashlib does not appear") constrains prose --
        a future docstring mentioning it would fail -- and detects no actual
        reimplementation. This patches the shared verify() instead and asserts
        the batch route observes the change. If the tool ever grew its own
        verification, this call would not be seen and the state would stay
        VERIFIED, which is exactly the drift being guarded.
        """
        sentinel = "SENTINEL-REACHED-THROUGH-SHARED-VERIFY"
        # The module the TOOL holds, not a fresh copy. Loading receipt-bundle
        # again would build a separate module object and patching that one
        # reaches nothing -- the assertion would fail against a correct tool.
        _rb = _rvb._rb
        original = _rb.verify

        def _boom(*a, **k):
            raise RuntimeError(sentinel)

        try:
            _rb.verify = _boom
            report = _rvb.batch([str(_TOOL)], ".")
        finally:
            _rb.verify = original
        self.assertIn(
            sentinel, report["receipts"][0]["reason"],
            "the batch did not route through the shared verify(); a local "
            "copy of verification will drift from proof-verify.py")


if __name__ == "__main__":
    unittest.main()
