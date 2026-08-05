"""A per-class average is where one absent measurement does the most damage.

WHAT THIS GUARDS. cost-per-outcome.py answers the question one blended cost
figure cannot: is a run that ends VERIFIED cheaper or more expensive than one
that ends FAILED, and what are we paying for the runs we cannot verify at all.

WHY THE SPLIT MAKES THE HONESTY RULE SHARPER, not merely repeats it.
receipt-stats.py already refuses to sum an unmeasured receipt as 0 across a
whole archive, and this repo paid for that on four surfaces
(v8.51.0-v8.54.0). Splitting by verdict shrinks the SAMPLE. One fake zero
folded into forty receipts moves the total a little. The same fake zero folded
into the three receipts that happened to FAIL moves that class's mean by a
third, and it moves it in the direction that flatters us: it makes failures
look cheap, which is the specific claim a buyer would use this table to check.

THE MUTATION THIS FILE EXISTS TO CATCH is rule 2 rendered wrong -- a class with
no measured receipts shown as $0.0000 instead of UNKNOWN. It is the single most
tempting line in the tool, because `sum([])` is 0 and `"%.4f" % 0` is a clean
"$0.0000" that looks like a finished report. It says the outcomes we could not
price were free. Two tests below fail on it specifically, one on the structured
value and one on the rendered row.

BOTH DIRECTIONS ARE ASSERTED, because the over-strict fix lands on the SAME
line and is its own dishonesty:

  - written `if not total`, a class whose receipts each genuinely measured
    $0.0000 is blanked to UNKNOWN. That is a real, recorded observation
    reported as an absence. `if measured_n` is where both are decided.
  - a guard that suppressed the class row entirely would read as "no receipt
    landed in that class", which is a DIFFERENT fact from "three landed there
    and none was priced". Every class is asserted present on every run.

Also pinned here, because each is a judgement a later reader could "fix":

  - Zero receipts exits 3 and says so in words. Nothing to split is not a
    clean archive; it is usually the wrong directory.
  - A missing workspace exits 66, NOT 3.
  - An unknown flag exits 64, NOT argparse's default 2. Here 2 means "could
    not be checked", so a typo would masquerade as blind instrumentation.
  - An archive where nothing measured still exits 0. This is an ADVISOR: the
    output says UNKNOWN in words, and forcing it non-zero would train
    operators to ignore a tool that is working.
  - A malformed receipt keeps its own class, separate from UNVERIFIABLE.

NOTE ON PAIRING. This test imports tools/cost-per-outcome.py by path. The two
files ship together or neither ships: without the tool, this module fails at
COLLECTION and takes every other Python test in the job down with it.
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

# A stale .pyc can mask a mutation and make a real probe report a false
# "MUTATION SURVIVED": invalidation is mtime+size, and a probe's restore is
# byte-identical. Set before either loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"
_TOOL = _ROOT / "tools" / "cost-per-outcome.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_pv = _load("proof_verify", _LIB / "proof-verify.py")
_cpo = _load("cost_per_outcome", _TOOL)


def _git(cwd, *args):
    return subprocess.run(["git"] + list(args), cwd=cwd,
                          capture_output=True, text=True, timeout=60)


def _make_repo(path):
    """A real git work tree with one commit. Returns the HEAD sha.

    Load-bearing. Outside a real work tree proof-verify.py cannot re-derive a
    recorded diff, every receipt reads UNVERIFIABLE, and the VERIFIED class
    would be permanently empty -- which would leave this suite unable to tell a
    working tool from one that hardcodes a single class.

    Committer identity is set locally so this passes on a machine with no
    global git config, and `init -q` takes whatever default branch name the
    local git ships with rather than assuming one.
    """
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "t@example.com")
    _git(path, "config", "user.name", "t")
    (pathlib.Path(path) / "seed.txt").write_text("seed\n")
    _git(path, "add", "seed.txt")
    _git(path, "commit", "-q", "-m", "seed")
    return _git(path, "rev-parse", "HEAD").stdout.strip()


def _receipt(sha, usd=0.42, measured=True):
    """A receipt every verification axis can genuinely be checked against.

    measured=False is the HONEST unmeasured shape: available=false and no
    values. It must be EXCLUDED from its class's average, and it must still
    VERIFY -- "this run did not price itself" is a truthful receipt, and a
    class containing one is not thereby forged.

    The DISHONEST shape (available=true with every field zero, what a real run
    shipped before v8.51.0) is deliberately not used: proof-verify.py's own
    cost-coherence check fails it upstream, so it would exercise that rule
    instead of this file's exclude-from-the-average rule.
    """
    facts = {
        "git": {"base_sha": sha, "head_sha": sha,
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


class OutcomeCase(unittest.TestCase):
    """An archive of receipts inside a real git repo, one class at a time."""

    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.head = _make_repo(self.repo)
        self._n = 0

    def _write(self, proof):
        self._n += 1
        d = pathlib.Path(self.repo) / ".loki" / "proofs" / ("run-%02d" % self._n)
        d.mkdir(parents=True, exist_ok=True)
        p = d / "proof.json"
        p.write_text(json.dumps(proof, indent=2) if not isinstance(proof, str)
                     else proof, encoding="utf-8")
        return p

    def verified(self, usd=0.42, measured=True):
        return self._write(_receipt(self.head, usd, measured))

    def failed(self, usd=0.42, measured=True):
        """Facts edited AFTER the hash was computed: hash_ok is False."""
        proof = _receipt(self.head, usd, measured)
        proof["facts"]["tests"]["exit_code"] = 99
        return self._write(proof)

    def report(self):
        return _cpo.cost_per_outcome(self.repo, self.repo)

    def run_tool(self, *args):
        return subprocess.run(
            [sys.executable, str(_TOOL), *args],
            capture_output=True, text=True, timeout=180)


class TheSplitItself(OutcomeCase):
    """The positive control. Without it, 'hardcode UNKNOWN everywhere' passes.

    Every honesty test below asserts an absence reads as UNKNOWN. A suite made
    only of those is satisfied by a tool that reports UNKNOWN unconditionally
    and measures nothing at all, which is the over-strict failure this file
    also exists to catch.
    """

    def test_verified_and_failed_carry_their_own_averages(self):
        for usd in (1.0, 3.0):
            self.verified(usd)
        for usd in (10.0, 20.0):
            self.failed(usd)

        classes = self.report()["classes"]

        self.assertEqual(classes[_cpo.VERIFIED]["mean_usd"], 2.0,
                         "the VERIFIED class must average only its own "
                         "receipts; blending in the failures reports 8.5")
        self.assertEqual(classes[_cpo.FAILED]["mean_usd"], 15.0)
        self.assertEqual(classes[_cpo.VERIFIED]["receipts"], 2)
        self.assertEqual(classes[_cpo.FAILED]["receipts"], 2)

    def test_the_comparison_is_the_headline_the_tool_exists_for(self):
        """A blended figure cannot express this at all."""
        self.verified(1.0)
        self.failed(5.0)
        self.assertAlmostEqual(
            self.report()["comparison"]["ratio_failed_over_verified"], 5.0)


class AnUnmeasuredReceiptNeverEntersAnAverage(OutcomeCase):
    """Rule 1, at the sample size where a fake zero does the most damage.

    Called directly rather than through the CLI: a mutation that CRASHES also
    exits non-zero through a subprocess boundary, so a subprocess assertion
    cannot tell "the mean is wrong" from "the tool died". A direct call yields
    a clean AssertionError naming the two numbers.
    """

    def test_the_failed_mean_ignores_unmeasured_failures(self):
        """Two priced failures at 10 and 20; three that never priced.

        The true mean is 15.0. Fold the three unmeasured ones in as 0.0 and it
        becomes 6.0 -- below EVERY real observation in the class. The fixture
        is built so the wrong answer cannot coincide with the right one.
        """
        self.failed(10.0)
        self.failed(20.0)
        for _ in range(3):
            self.failed(measured=False)

        block = self.report()["classes"][_cpo.FAILED]

        self.assertEqual(
            block["mean_usd"], 15.0,
            "the mean must be taken over MEASURED receipts only; folding "
            "unmeasured failures in as 0.0 drags it below every real "
            "observation and makes failing look cheap")
        self.assertEqual(block["measured_receipts"], 2)
        self.assertEqual(block["unmeasured_receipts"], 3)
        self.assertEqual(block["receipts"], 5)

    def test_the_exclusion_is_counted_on_the_class_row(self):
        """A mean over 1 of 4 is not wrong; shown without the ratio it is."""
        self.failed(42.0)
        for _ in range(3):
            self.failed(measured=False)

        report = self.report()
        self.assertEqual(report["classes"][_cpo.FAILED]["unmeasured_receipts"], 3)

        row = _cpo._class_line(_cpo.FAILED, report["classes"][_cpo.FAILED])
        self.assertIn("EXCLUDED", row)
        self.assertIn("3", row)
        self.assertIn("1 of 4 measured", row)

    def test_tokens_without_a_dollar_figure_is_not_a_cost(self):
        """Measured is necessary but NOT sufficient.

        record_is_measured() is true when ANY of five fields is non-zero, so
        this receipt is honestly measured and still carries no usd. Reading the
        predicate alone and defaulting the amount to 0.0 invents a measurement
        out of a receipt proving only that tokens moved.
        """
        proof = _receipt(self.head)
        proof["cost"] = {"available": True, "usd": None, "input_tokens": 900,
                         "output_tokens": 400, "cache_read_tokens": 0,
                         "cache_creation_tokens": 0}
        unsigned = dict(proof)
        unsigned.pop("verification", None)
        proof["verification"] = {
            "hash": hashlib.sha256(
                _pv._canonical(unsigned).encode("utf-8")).hexdigest()}
        self._write(proof)

        classes = self.report()["classes"]
        priced = [b for b in classes.values() if b["measured_receipts"]]
        self.assertEqual(priced, [],
                         "a receipt with tokens and no usd was priced anyway")


class AClassWithNothingMeasuredReadsUnknown(OutcomeCase):
    """Rule 2. THE mutation target of this file.

    `sum([])` is 0 and `"%.4f" % 0` renders a clean "$0.0000", so the wrong
    answer here looks like a finished report rather than a crash. It says the
    outcomes we could not price were free -- and failures are the most
    expensive thing in an archive, not the cheapest.
    """

    def test_an_unmeasured_class_is_none_not_zero(self):
        """The structured half of the mutation target."""
        self.verified(1.0)
        for _ in range(3):
            self.failed(measured=False)

        block = self.report()["classes"][_cpo.FAILED]

        self.assertIsNone(
            block["mean_usd"],
            "a class where nothing was measured has no mean; reporting 0.0 "
            "says failed outcomes were free when they were merely unpriced")
        self.assertIsNone(block["total_usd"])
        self.assertEqual(block["receipts"], 3,
                         "the receipts are still there and still counted")
        self.assertEqual(block["measured_receipts"], 0)

    def test_the_rendered_row_says_unknown_and_never_a_dollar_figure(self):
        """The rendered half. The table is what an operator actually reads."""
        self.verified(1.0)
        for _ in range(3):
            self.failed(measured=False)

        row = _cpo._class_line(_cpo.FAILED, self.report()["classes"][_cpo.FAILED])

        self.assertIn("UNKNOWN", row)
        self.assertNotIn(
            "$0.0000", row,
            "the FAILED row renders a dollar figure for a class where nothing "
            "was measured; $0.0000 and 'we did not price it' are opposite "
            "claims about what failing costs")
        self.assertIn("0 of 3 measured", row,
                      "the row must carry its own basis, not a bare UNKNOWN")

    def test_every_class_gets_a_row_even_when_empty(self):
        """An OMITTED row reads as 'none of those happened'.

        Different fact from 'some happened and none was priced', and the whole
        point of this table is that those are told apart.
        """
        self.verified(1.0)
        report = self.report()

        for name in (_cpo.VERIFIED, _cpo.FAILED, _cpo.UNVERIFIABLE,
                     _cpo.MALFORMED):
            self.assertIn(name, report["classes"])

        out = self.run_tool(self.repo, "--repo-dir", self.repo).stdout
        for name in (_cpo.VERIFIED, _cpo.FAILED, _cpo.UNVERIFIABLE,
                     _cpo.MALFORMED):
            self.assertIn(name, out,
                          "%s was omitted from the table, which reads as "
                          "'no receipt ended that way'" % name)

    def test_the_formatter_itself_never_turns_an_absence_into_a_figure(self):
        """The mutation named in the brief, tested at the layer it lives on.

        `_amount()` is the ONE line that decides whether an absent number gets
        printed as money. Written `"$%.4f" % (value or 0.0)` it renders
        "$0.0000" for None, which is the whole defect in four characters.

        This is asserted directly rather than only through a rendered row,
        because the row-level guard SHORT-CIRCUITS: on the unpriced path
        _class_line never calls _amount at all, so a probe that breaks only
        _amount survives every row assertion in this file. Verified by running
        that exact probe -- it reported MUTATION SURVIVED until this test
        existed. A test one layer above a defect is not a test of that defect.

        The measured-zero direction is asserted in the same breath: a guard
        that returned "-" for everything would pass the first assertion and is
        the over-strict version of the same bug.
        """
        self.assertEqual(_cpo._amount(None), "-",
                         "an absent cost rendered as money; $0.0000 and 'we "
                         "did not measure it' are opposite claims")
        self.assertNotIn("$", _cpo._amount(None))
        self.assertEqual(_cpo._amount(0.0), "$0.0000",
                         "a MEASURED zero is an observation and must render "
                         "as a figure, not as the absence dash")
        self.assertEqual(_cpo._amount(1.5), "$1.5000")

    def test_an_empty_class_reads_differently_from_an_unpriced_one(self):
        """Three states, and collapsing any two is a claim the data lacks.

        "no run ended this way", "runs ended this way and none was priced", and
        "here is the cost" are three findings. The first two are the pair a
        reader must act on differently: one is a fact about the archive, the
        other about the instrumentation. Both rows print; neither borrows the
        other's sentence.
        """
        self.verified(1.0)
        for _ in range(2):
            self.failed(measured=False)

        classes = self.report()["classes"]
        empty = _cpo._class_line(_cpo.UNVERIFIABLE, classes[_cpo.UNVERIFIABLE])
        unpriced = _cpo._class_line(_cpo.FAILED, classes[_cpo.FAILED])

        # Same VERDICT word on both rows -- an empty class has no measured
        # receipts either, so UNKNOWN is the honest word for it too.
        self.assertIn("UNKNOWN", empty)
        self.assertIn("UNKNOWN", unpriced)
        # Different REASON clause, which is where the distinction lives.
        self.assertIn("no receipt ended with this outcome", empty)
        self.assertNotIn(
            "unmeasured is not free", empty,
            "an EMPTY class borrowed the unpriced sentence; it says the "
            "instrumentation failed on runs that never happened")
        self.assertIn("unmeasured is not free", unpriced)
        self.assertIn("0 of 2 measured", unpriced)
        self.assertNotEqual(empty.split(None, 2)[2], unpriced.split(None, 2)[2])
        self.assertNotIn("$", empty)

    def test_the_row_and_the_summary_use_the_SAME_word_for_a_class(self):
        """One report must not carry two words for one class.

        The row comes from _class_line and the summary from _summary, and they
        branch on DIFFERENT conditions -- `receipts == 0` versus
        `mean_usd is None`. A real drift landed here: the empty-class row read
        "none" while the summary line for that identical class read
        "cost UNKNOWN", in the same invocation. Every other test in this file
        checks one surface at a time and all of them passed through it.

        Asserted across all four classes and across all three states an archive
        can put them in, so it is a property rather than one fixture.
        """
        self.verified(1.0)          # VERIFIED: priced
        for _ in range(2):
            self.failed(measured=False)   # FAILED: present, unpriced
        self._write("{not json")          # MALFORMED: present, unpriced
        # UNVERIFIABLE stays empty.

        report = self.report()
        summary = report["summary"]

        for name in (_cpo.VERIFIED, _cpo.FAILED, _cpo.UNVERIFIABLE,
                     _cpo.MALFORMED):
            block = report["classes"][name]
            row = _cpo._class_line(name, block)
            unknown_in_row = "UNKNOWN" in row
            # The summary renders this class's word from mean_usd alone.
            unknown_in_summary = block["mean_usd"] is None
            self.assertEqual(
                unknown_in_row, unknown_in_summary,
                "%s reads UNKNOWN on one surface and priced on the other; one "
                "report carrying two words for one class is the drift this "
                "tool exists to refuse (row was %r)" % (name, row))
            if unknown_in_summary:
                self.assertIn("%s %d receipt(s) cost UNKNOWN"
                              % (name, block["receipts"]), summary)

    def test_the_comparison_refuses_rather_than_inventing_a_ratio(self):
        """With no measured FAILED cost there is no ratio, and 1.0 is a lie."""
        self.verified(1.0)
        self.failed(measured=False)

        comp = self.report()["comparison"]
        self.assertIsNone(comp["ratio_failed_over_verified"])
        self.assertIn("UNKNOWN", comp["note"])


class AMeasuredZeroIsRealData(OutcomeCase):
    """Rule 3, and the OVER-STRICT direction of the same line of code.

    Written `if not total`, the guard above blanks a class whose receipts each
    genuinely measured $0.0000. That is a recorded observation reported as an
    absence -- erasing a measurement, which is the same dishonesty as inventing
    one, pointed the other way. `if measured_n` decides both.
    """

    def test_a_genuinely_free_class_reports_zero_not_unknown(self):
        for _ in range(3):
            self.verified(0.0)

        block = self.report()["classes"][_cpo.VERIFIED]

        self.assertEqual(
            block["mean_usd"], 0.0,
            "three receipts each measured $0.0000; reporting UNKNOWN discards "
            "a real observation, which is 'if not total' instead of "
            "'if measured_n'")
        self.assertEqual(block["total_usd"], 0.0)
        self.assertEqual(block["measured_receipts"], 3)
        self.assertIsNotNone(block["mean_usd"])

    def test_a_measured_zero_still_renders_as_a_figure(self):
        for _ in range(3):
            self.verified(0.0)
        row = _cpo._class_line(_cpo.VERIFIED, self.report()["classes"][_cpo.VERIFIED])
        self.assertIn("$0.0000", row)
        self.assertNotIn("UNKNOWN", row)

    def test_a_measured_zero_mixed_with_real_costs_lowers_the_mean(self):
        """The zero is a data point, not a skipped row."""
        self.verified(0.0)
        self.verified(4.0)
        self.assertEqual(self.report()["classes"][_cpo.VERIFIED]["mean_usd"], 2.0)

    def test_a_verified_mean_of_exactly_zero_yields_no_ratio(self):
        """Undefined, and said so in words -- not silently 0.0 or a crash."""
        self.verified(0.0)
        self.failed(5.0)
        comp = self.report()["comparison"]
        self.assertIsNone(comp["ratio_failed_over_verified"])
        self.assertIn("UNKNOWN", comp["note"])
        self.assertIn("real data", comp["note"])


class MalformedIsCountedAndKeptApart(OutcomeCase):
    """Rule 4. Unreadable bytes and an unre-derivable diff have different fixes."""

    def test_a_malformed_receipt_is_named_not_dropped(self):
        self.verified(1.0)
        self._write("{not json at all")

        report = self.report()
        self.assertEqual(report["malformed_count"], 1)
        self.assertEqual(report["classes"][_cpo.MALFORMED]["receipts"], 1)
        self.assertEqual(report["classes"][_cpo.UNVERIFIABLE]["receipts"], 0,
                         "an unreadable file inflated the UNVERIFIABLE class")
        self.assertTrue(report["malformed"][0]["reason"])

    def test_a_malformed_row_still_carries_every_key(self):
        """A consumer reading r['cost_usd'] must not KeyError on exactly the
        rows this rule exists to surface."""
        self._write("{not json at all")
        row = self.report()["receipts"][0]
        self.assertEqual(row["class"], _cpo.MALFORMED)
        self.assertIsNone(row["cost_usd"])
        self.assertIn("reason", row)


class TheExitContract(OutcomeCase):
    """Judgements a later reader could 'fix'. Pinned deliberately."""

    def test_an_empty_workspace_exits_three_and_says_so(self):
        empty = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, empty, ignore_errors=True)
        r = self.run_tool(empty)
        self.assertEqual(r.returncode, 3)
        self.assertIn("NO RECEIPTS", r.stdout)

    def test_a_missing_workspace_exits_sixty_six_not_three(self):
        """'You pointed me at nothing' is not 'this archive is empty'."""
        r = self.run_tool("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66)
        self.assertNotEqual(r.returncode, 0)

    def test_an_unknown_flag_exits_sixty_four_not_two(self):
        """2 means 'could not be checked', so a typo must not claim it."""
        r = self.run_tool(self.repo, "--totally-bogus")
        self.assertEqual(
            r.returncode, 64,
            "argparse's default 2 means 'blind instrumentation' here, so a "
            "mistyped flag would masquerade as a broken measurement")

    def test_an_unknown_flag_is_never_read_as_a_path(self):
        r = self.run_tool("--totally-bogus")
        self.assertEqual(r.returncode, 64)
        self.assertNotIn("workspace does not exist", r.stderr)

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = self.run_tool("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("UNKNOWN", r.stdout)
        self.assertNotIn("receipt(s) split by outcome", r.stdout)

    def test_an_archive_where_nothing_measured_still_exits_zero(self):
        """This is an ADVISOR. The honest answer must not look like a failure."""
        for _ in range(2):
            self.verified(measured=False)
        r = self.run_tool(self.repo, "--repo-dir", self.repo)
        self.assertEqual(
            r.returncode, 0,
            "'every receipt is readable and none recorded a cost' is a "
            "complete honest answer; forcing it non-zero trains operators to "
            "ignore the tool")
        self.assertIn("UNKNOWN", r.stdout)

    def test_json_output_is_json(self):
        self.verified(1.0)
        r = self.run_tool(self.repo, "--repo-dir", self.repo, "--json")
        self.assertEqual(r.returncode, 0)
        report = json.loads(r.stdout)
        self.assertEqual(report["report"], "loki-cost-per-outcome/v1")


class ReuseNotRestatement(unittest.TestCase):
    """The predicates are imported, never re-derived.

    A second copy of either is how this rule drifted across four surfaces
    before, so "is it the same function" has to be an assertion, not a comment.

    IDENTITY IS NOT THE CHECK, and that is worth pinning: every load through
    spec_from_file_location builds a FRESH module object, so a second load of
    receipt-diff.py yields a different function object no matter how correct
    the tool is. `assertIs` here fails on working code and would have to be
    deleted, taking the real guarantee with it. What is actually asserted is
    that the function the tool holds was DEFINED in the shared file -- which is
    exactly what a pasted local copy would break.
    """

    def _defined_in(self, fn):
        return os.path.realpath(fn.__code__.co_filename)

    def test_measured_cost_is_defined_in_receipt_diff(self):
        self.assertEqual(
            self._defined_in(_cpo.measured_cost),
            os.path.realpath(str(_ROOT / "tools" / "receipt-diff.py")),
            "measured_cost() is not the shared one; a local copy would drift "
            "from record_is_measured() and re-open the $0.00 hole")

    def test_receipt_state_is_defined_in_receipt_bundle(self):
        self.assertEqual(
            self._defined_in(_cpo.receipt_state),
            os.path.realpath(str(_ROOT / "tools" / "receipt-bundle.py")),
            "receipt_state() is not the shared one; a local copy would drift "
            "from verify() and re-derive the three-state rule")

    def test_the_chain_reaches_the_canonical_predicates(self):
        """The two imports are only honest if THEY reach the originals.

        receipt_state -> verify() in autonomy/lib/proof-verify.py, and
        measured_cost -> record_is_measured() in autonomy/lib/efficiency_cost.py.
        Asserting the first hop alone would pass if receipt-bundle.py had itself
        pasted a copy.
        """
        _rb = _load("receipt_bundle", _ROOT / "tools" / "receipt-bundle.py")
        self.assertEqual(
            self._defined_in(_rb.verify),
            os.path.realpath(str(_LIB / "proof-verify.py")))

        _rd = _load("receipt_diff", _ROOT / "tools" / "receipt-diff.py")
        self.assertEqual(
            self._defined_in(_rd.record_is_measured),
            os.path.realpath(str(_LIB / "efficiency_cost.py")))

    def test_the_tool_does_not_restate_either_predicate(self):
        src = _TOOL.read_text(encoding="utf-8")
        self.assertNotIn("def record_is_measured", src)
        self.assertNotIn("def verify(", src)
        self.assertNotIn("def measured_cost", src)


class RunsOutsideItsOwnTree(unittest.TestCase):
    """A tool that only works where it was built is not shipped.

    The receipt archive is a DIFFERENT tree from the repo holding the tool, and
    the loaders here resolve their siblings from __file__, never from the
    workspace argument. This pins that, because resolving from the workspace
    passes every other test in this file (the fixtures put the archive inside
    a repo) and fails the first time a real operator points it at one that is
    not a checkout of this project.
    """

    def test_the_workspace_is_not_used_to_find_autonomy_lib(self):
        ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, ws, ignore_errors=True)
        os.makedirs(os.path.join(ws, ".loki", "proofs", "r1"))
        with open(os.path.join(ws, ".loki", "proofs", "r1", "proof.json"),
                  "w", encoding="utf-8") as f:
            json.dump({"schema": "1.1", "facts": {},
                       "cost": {"usd": 1.5, "input_tokens": 10,
                                "output_tokens": 5}}, f)

        r = subprocess.run(
            [sys.executable, str(_TOOL), ws, "--json"],
            capture_output=True, text=True, timeout=180, cwd=tempfile.gettempdir())
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(r.stdout)
        self.assertEqual(report["receipt_count"], 1)


if __name__ == "__main__":
    unittest.main()
