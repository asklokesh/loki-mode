"""UNKNOWN must never be laundered into FRESH, and the scan must find things.

THE DEFECT THIS FILE EXISTS TO CATCH. A freshness sweep has one tempting
implementation and it is dishonest:

    if result.get("diff_drift"):      # <-- the whole bug
        return STALE
    return FRESH

`diff_drift` is THREE-valued. None means the axis could not be checked -- no
recorded base sha, the base commit absent from this repo, not a git work tree at
all. Truthiness reads None as "no drift" and reports FRESH, so a receipt nobody
could check reads as one that was checked and passed. That is the loudest
possible lie: a confident green at exactly the moment the measurement was
missing. `UnknownIsNeverFresh` is the direction that catches it.

THE VACUITY GUARD, which every other assertion in this file depends on. A scan
that matches nothing trivially satisfies "no stale receipts found". So
`ScanIsNotVacuous` runs first in spirit and `_assert_found()` is called before
any freshness assertion is trusted: it asserts the exact number of receipts the
fixture wrote AND that at least one reads FRESH. Without the positive control a
tool hardcoded to return an empty report, or one that can never say FRESH, would
pass every negative assertion here.

BOTH DIRECTIONS ARE ASSERTED, because a fix that over-corrects is its own
dishonesty:

  * the defect direction -- unknown and stale each sink the sweep and are named
    in their OWN list, never merged.
  * the over-strict direction -- genuinely fresh receipts still read FRESH and
    exit 0. A tool that can only say STALE is not a freshness report, it is a
    broken one, and it would train operators to regenerate evidence that was
    never out of date.

THREE STATES ARE NEVER COLLAPSED, and they are asserted DISTINCT rather than
merely non-zero: FRESH/STALE/UNKNOWN carry different remedies (nothing,
regenerate, investigate) and a report that renders two of them identically
cannot be acted on.
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

# A stale .pyc for a hyphenated module loaded by path makes a mutation probe
# report a FALSE pass: the probe edits the source, the loader serves the old
# bytecode. Must be set before any loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"
_TOOL = _ROOT / "tools" / "evidence-freshness.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_pv = _load("proof_verify", _LIB / "proof-verify.py")
_ef = _load("evidence_freshness", _TOOL)


def _git(cwd, *args):
    return subprocess.run(["git"] + list(args), cwd=cwd,
                          capture_output=True, text=True, timeout=30)


def _make_repo(path):
    """A real git work tree with one commit. Returns the commit sha.

    Without a real repo the drift axis is unverifiable and NO receipt can ever
    read FRESH, which would leave this suite unable to tell a working tool from
    one hardcoded to say UNKNOWN. The positive control is what makes the
    negative assertions mean anything.
    """
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "t@example.com")
    _git(path, "config", "user.name", "t")
    # A global commit.gpgsign=true makes the seed commit fail SILENTLY here:
    # rev-parse returns empty, every receipt gets base_sha="", the drift axis
    # goes unverifiable, and every positive control in this file collapses at
    # once. That reproduces on one machine and not another, which is the most
    # expensive shape of test failure there is.
    _git(path, "config", "commit.gpgsign", "false")
    (pathlib.Path(path) / "seed.txt").write_text("seed\n")
    _git(path, "add", "seed.txt")
    _git(path, "commit", "-q", "-m", "seed")
    return _git(path, "rev-parse", "HEAD").stdout.strip()


def _receipt(base_sha, head_sha, count=0, insertions=0, deletions=0):
    """A receipt whose freshness axis can genuinely be checked.

    The diff stat is a parameter so a STALE receipt can be built by recording a
    diff that does not match the tree -- which is what real staleness looks
    like: the numbers were true when written and the tree moved past them.
    """
    facts = {
        "git": {"base_sha": base_sha, "head_sha": head_sha,
                "diff": {"count": count, "insertions": insertions,
                         "deletions": deletions}},
        "tests": {"status": "verified", "command": "pytest -q", "exit_code": 0},
        "execution": {"outcome": "complete", "exit_code": 0},
    }
    proof = {
        "schema": "1.1",
        "facts": facts,
        "honesty": {"headline": _pv._compute_headline(facts, []),
                    "degraded": []},
    }
    unsigned = dict(proof)
    unsigned.pop("verification", None)
    proof["verification"] = {
        "hash": hashlib.sha256(
            _pv._canonical(unsigned).encode("utf-8")).hexdigest()}
    return proof


class FreshnessCase(unittest.TestCase):
    """A directory of receipts inside a real git repo, swept for freshness."""

    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.head = _make_repo(self.repo)
        self.evidence = pathlib.Path(self.repo) / ".loki" / "proofs"

    def _write(self, name, proof):
        d = self.evidence / name
        d.mkdir(parents=True, exist_ok=True)
        path = d / "proof.json"
        path.write_text(json.dumps(proof, indent=2), encoding="utf-8")
        return str(path)

    def _fresh(self, name):
        """Records the diff the tree actually has right now: zero changes."""
        return self._write(name, _receipt(self.head, self.head))

    def _stale(self, name):
        """Records a diff the tree does NOT have. The checked-and-moved case."""
        return self._write(name, _receipt(self.head, self.head,
                                          count=7, insertions=99, deletions=3))

    def _unknown(self, name):
        """No recorded base sha, so there is no point to compare the tree to.

        This is the honest UNKNOWN shape: a schema v1.0 receipt records no
        base_sha at all, so drift is unverifiable rather than absent.
        """
        return self._write(name, _receipt("", ""))

    def _tampered(self, name):
        """Facts edited after the hash was computed.

        Reads UNKNOWN here, NOT STALE and NOT FRESH -- its recorded base sha is
        untrustworthy input, so no freshness claim can be made in either
        direction. The integrity finding belongs to receipt-bundle.py.
        """
        proof = _receipt(self.head, self.head)
        proof["facts"]["tests"]["exit_code"] = 99
        return self._write(name, proof)

    def _scan(self, directory=None, repo_dir=None):
        return _ef.scan(str(directory or self.evidence), repo_dir or self.repo)

    def _assert_found(self, report, expected_n):
        """THE VACUITY GUARD. Nothing below this is trustworthy without it.

        A scan matching zero receipts makes "no stale receipts" trivially true,
        and a tool that can never emit FRESH makes every negative assertion
        pass for the wrong reason. Both are checked: the exact count the
        fixture wrote, and a live positive control.
        """
        self.assertEqual(
            len(report["receipts"]), expected_n,
            "the scan found %d receipts but the fixture wrote %d; every "
            "freshness assertion below this point would be vacuous"
            % (len(report["receipts"]), expected_n))
        self.assertGreater(
            report["counts"][_ef.FRESH], 0,
            "no receipt in this fixture read FRESH, so the tool may be unable "
            "to emit FRESH at all; the negative assertions would then pass "
            "against a hardcoded verdict")

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(_TOOL), *args],
            capture_output=True, text=True, timeout=120, cwd=self.repo)


class ScanIsNotVacuous(FreshnessCase):
    """The guard itself, asserted directly rather than only used.

    If this class fails, no other result in this file means anything.
    """

    def test_the_scan_actually_finds_the_receipts_written(self):
        for name in ("run-a", "run-b", "run-c"):
            self._fresh(name)
        report = self._scan()
        self.assertEqual(
            len(report["receipts"]), 3,
            "the walk found %d of 3 written receipts; a scan that matches "
            "nothing reports 'no stale receipts' trivially"
            % len(report["receipts"]))
        self.assertEqual(report["counts"][_ef.FRESH], 3)

    def test_an_empty_directory_is_not_a_fresh_sweep(self):
        """Zero receipts is EMPTY, never FRESH. Vacuous truth is a false green."""
        empty = pathlib.Path(self.repo) / "no-evidence-here"
        empty.mkdir()
        report = self._scan(empty)
        self.assertEqual(report["verdict"], _ef.EMPTY)
        self.assertNotEqual(
            report["verdict"], _ef.FRESH,
            "an empty directory reported FRESH; the sweep can then be passed "
            "by deleting the evidence")
        self.assertEqual(_ef.EXIT[report["verdict"]], 3)


class UnknownIsNeverFresh(FreshnessCase):
    """THE defect direction. An unchecked axis must not read as a passed one.

    Every assertion here fails if `diff_drift` is read truthily, and they fail
    in DIFFERENT ways on purpose: the state, the count, the named list and the
    verdict are four independent observations of the same laundering. A partial
    fix that counts the receipt but still lets the sweep read FRESH is caught
    by the verdict assertion alone.
    """

    def test_an_unverifiable_receipt_sinks_an_otherwise_fresh_sweep(self):
        """The exact arrangement truthiness would report as FRESH.

        Three genuinely fresh receipts and one whose freshness cannot be
        determined. Reading None as "no drift" gives four FRESH and a FRESH
        rollup. This is the assertion the mutation probe drives.
        """
        for name in ("run-a", "run-b", "run-c"):
            self._fresh(name)
        self._unknown("run-unknown")

        report = self._scan()
        self._assert_found(report, 4)

        self.assertEqual(
            report["verdict"], _ef.UNKNOWN,
            "a receipt whose freshness could not be determined did not sink "
            "the sweep; three fresh receipts made an unchecked one read green")
        self.assertEqual(report["counts"][_ef.UNKNOWN], 1)
        self.assertEqual(report["counts"][_ef.FRESH], 3)

    def test_unknown_is_counted_separately_and_never_as_stale(self):
        """Its own count and its own list. Folding either way misleads.

        Into FRESH is a false green. Into STALE sends an operator regenerating
        receipts that were never shown to be out of date.
        """
        self._fresh("run-a")
        self._unknown("run-unknown")
        report = self._scan()
        self._assert_found(report, 2)

        self.assertEqual(report["counts"][_ef.STALE], 0,
                         "an undeterminable receipt was counted as STALE")
        self.assertEqual(report["counts"][_ef.UNKNOWN], 1)
        self.assertEqual(report["stale"], [],
                         "an undeterminable receipt appeared in the stale list")
        self.assertEqual(len(report["unknown"]), 1)
        self.assertIn("run-unknown", report["unknown"][0]["path"])

    def test_an_unknown_receipt_is_named_with_a_reason(self):
        """Counted is not enough; the operator needs to know WHICH and WHY."""
        self._fresh("run-a")
        self._unknown("run-unknown")
        report = self._scan()
        self._assert_found(report, 2)
        entry = report["unknown"][0]
        self.assertTrue(entry["reason"].strip(),
                        "an UNKNOWN receipt carried no reason, so nobody can "
                        "act on it")

    def test_a_tampered_receipt_reads_unknown_not_fresh_and_not_stale(self):
        """The judgement this tool makes, pinned so nobody 'fixes' it.

        A tampered receipt's recorded base sha is untrustworthy input, so its
        freshness genuinely cannot be determined -- the tree may not have moved
        at all. It is UNKNOWN with the integrity problem NAMED, never dropped
        and never silently upgraded. receipt-bundle.py is the integrity gate.
        """
        self._fresh("run-a")
        self._tampered("run-tampered")
        report = self._scan()
        self._assert_found(report, 2)

        bad = [r for r in report["receipts"] if "run-tampered" in r["path"]][0]
        self.assertEqual(
            bad["state"], _ef.UNKNOWN,
            "a tampered receipt read %s; freshness cannot be determined from a "
            "receipt whose recorded facts are untrustworthy" % bad["state"])
        self.assertNotEqual(bad["state"], _ef.FRESH)
        self.assertIn("integrity", bad["reason"].lower())
        self.assertIn(
            "receipt-bundle", bad["reason"],
            "an integrity finding surfaced as UNKNOWN must point at the tool "
            "that actually judges integrity, or it reads as laundering")

    def test_a_directory_outside_the_repo_is_unknown_not_fresh(self):
        """Checked from somewhere the base commit does not exist.

        The receipts are honest and the tree may be identical; we simply cannot
        tell from here. Reporting FRESH would certify from a position with no
        evidence.
        """
        self._fresh("run-a")
        elsewhere = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, elsewhere, ignore_errors=True)
        report = self._scan(repo_dir=elsewhere)
        self.assertEqual(len(report["receipts"]), 1)
        self.assertEqual(report["verdict"], _ef.UNKNOWN)
        self.assertEqual(report["counts"][_ef.FRESH], 0)


class StaleIsCheckedAndReported(FreshnessCase):
    """The other half: a receipt the tree really has moved past."""

    def test_one_stale_receipt_sinks_the_whole_sweep(self):
        """Weakest link, never an average.

        Many good receipts around one bad one is the arrangement any averaging
        rule passes and the weakest-link rule fails.
        """
        for name in ("run-a", "run-b", "run-c", "run-d"):
            self._fresh(name)
        self._stale("run-stale")

        report = self._scan()
        self._assert_found(report, 5)

        self.assertEqual(report["verdict"], _ef.STALE)
        self.assertEqual(report["counts"][_ef.STALE], 1)
        self.assertEqual(len(report["stale"]), 1)
        self.assertIn("run-stale", report["stale"][0]["path"])
        self.assertEqual(_ef.EXIT[report["verdict"]], 1)

    def test_stale_outranks_unknown_in_the_rollup(self):
        """A proven finding is reported over an unproven one.

        An operator holding both should act on the one that is known, so the
        headline verdict must be STALE (exit 1), not UNKNOWN (exit 2).
        """
        self._fresh("run-a")
        self._stale("run-stale")
        self._unknown("run-unknown")
        report = self._scan()
        self._assert_found(report, 3)
        self.assertEqual(report["verdict"], _ef.STALE)
        self.assertEqual(report["counts"][_ef.UNKNOWN], 1,
                         "the unknown receipt was dropped once a stale one "
                         "outranked it")

    def test_a_moved_tree_turns_a_fresh_receipt_stale(self):
        """End to end: the receipt was true when written, then the tree moved.

        This is the question the tool exists to answer, exercised through the
        real signal rather than a hand-built mismatched stat.
        """
        self._fresh("run-a")
        before = self._scan()
        self._assert_found(before, 1)
        self.assertEqual(before["verdict"], _ef.FRESH)

        (pathlib.Path(self.repo) / "new-work.txt").write_text("moved\n")

        after = self._scan()
        self.assertEqual(
            after["verdict"], _ef.STALE,
            "the worktree gained a file and the receipt still read FRESH; the "
            "evidence no longer describes this tree")


class FreshStaysFresh(FreshnessCase):
    """The over-strict direction. A tool that only says STALE is broken too."""

    def test_all_fresh_receipts_verdict_fresh_and_exit_zero(self):
        for name in ("run-a", "run-b", "run-c"):
            self._fresh(name)
        report = self._scan()
        self._assert_found(report, 3)
        self.assertEqual(report["verdict"], _ef.FRESH)
        self.assertEqual(report["counts"][_ef.STALE], 0)
        self.assertEqual(report["counts"][_ef.UNKNOWN], 0)
        self.assertEqual(report["stale"], [])
        self.assertEqual(report["unknown"], [])
        self.assertEqual(_ef.EXIT[report["verdict"]], 0)


class ExitCodesFollowTheConvention(FreshnessCase):
    """The codes a CI caller branches on, exercised through the real CLI."""

    def test_all_fresh_exits_zero(self):
        self._fresh("run-a")
        r = self._run(str(self.evidence), "--repo-dir", self.repo)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("FRESH", r.stdout)

    def test_a_stale_receipt_exits_one(self):
        self._fresh("run-a")
        self._stale("run-stale")
        r = self._run(str(self.evidence), "--repo-dir", self.repo)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)

    def test_an_unknown_receipt_exits_two(self):
        self._fresh("run-a")
        self._unknown("run-unknown")
        r = self._run(str(self.evidence), "--repo-dir", self.repo)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)

    def test_an_empty_directory_exits_three(self):
        empty = pathlib.Path(self.repo) / "no-evidence-here"
        empty.mkdir()
        r = self._run(str(empty), "--repo-dir", self.repo)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)

    def test_an_unknown_flag_exits_64(self):
        """argparse defaults to 2, which here means 'could not check'."""
        r = self._run("--zzz-not-a-real-flag")
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)

    def test_a_nonexistent_directory_exits_66_not_3(self):
        """A mistyped path is not an empty evidence folder.

        Falling through to the scan gives an empty result and exit 3, telling
        the operator their evidence directory is empty when it is elsewhere.
        """
        r = self._run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66, r.stdout + r.stderr)
        self.assertNotEqual(r.returncode, 3)

    def test_help_exits_zero_and_issues_no_verdict(self):
        r = self._run("--help")
        self.assertEqual(r.returncode, 0)
        for word in ("FRESH", "STALE", "UNKNOWN"):
            self.assertNotIn(
                "\n%s " % word, r.stdout,
                "--help emitted a verdict line about a path nobody named")

    def test_json_output_is_parseable(self):
        self._fresh("run-a")
        r = self._run(str(self.evidence), "--json", "--repo-dir", self.repo)
        report = json.loads(r.stdout)
        self.assertEqual(report["verdict"], "FRESH")
        self.assertEqual(len(report["receipts"]), 1)


class NothingIsReimplemented(FreshnessCase):
    """The walk and the verification come from the existing single sources.

    Asserted by PROVENANCE (which file the function object was defined in),
    not by identity: `_load()` executes a fresh module object on every call, so
    two loads of the same file yield non-identical functions and an `assertIs`
    can never hold no matter how correct the tool is. Provenance is the
    property that actually matters -- a re-implemented copy would be defined in
    evidence-freshness.py, and that is what this catches.
    """

    def test_the_walk_is_the_shared_one(self):
        self.assertEqual(
            os.path.basename(_ef.find_receipts.__code__.co_filename),
            "receipt-bundle.py",
            "the receipt walk is defined in %s rather than imported from "
            "receipt-bundle.py; a second copy is exactly how these tools drift "
            "apart" % _ef.find_receipts.__code__.co_filename)

    def test_verification_is_proof_verify(self):
        self.assertEqual(
            os.path.basename(_ef.verify.__code__.co_filename),
            "proof-verify.py",
            "verification is defined in %s rather than imported from "
            "proof-verify.py" % _ef.verify.__code__.co_filename)


if __name__ == "__main__":
    unittest.main()
