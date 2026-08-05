"""A bad run must not be able to hide inside a crowd of good ones.

WHAT THIS LOCKS DOWN. tools/receipt-bundle.py rolls a SEQUENCE of receipts up
into one verdict, which is the artifact a buyer actually hands a compliance
reviewer. Every way that rollup can flatter itself is a way the whole product
line stops meaning anything:

    averaging / scoring        one forged run among nine good ones reads
                               "90% verified", and gets CHEAPER to hide the
                               larger the bundle grows
    dropping the unreadable    a receipt that could not be checked vanishes,
                               and the report shows only receipts that passed
    summing every receipt      a total over 3 measured of 10 wears the label
                               of all 10
    zero-as-free               nothing measured reads $0.00 rather than
                               UNKNOWN
    vacuous pass               an empty workspace certifies clean, so the
                               audit is passed by deleting the evidence

The central assertion is the first one, and it needs THREE receipts, not two.
With one good and one bad, a majority rule (bad > n/2) already returns
not-VERIFIED, so the suite would pass an implementation that averages -- and a
mutation probe against it would report a false catch. Two good plus one bad
fails under weakest-link and passes under every averaging or majority variant,
so it separates them.

The all-VERIFIED positive control is equally load-bearing and easy to omit.
"one bad receipt -> FAILED" also passes for a tool that hardcodes FAILED and
checks nothing. It only means something paired with a bundle that reaches
VERIFIED, and reaching VERIFIED requires a REAL git work tree -- outside one,
proof-verify.py cannot re-derive the recorded diff and every receipt is
honestly UNVERIFIABLE.
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
_TOOL = _ROOT / "tools" / "receipt-bundle.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_pv = _load("proof_verify", _LIB / "proof-verify.py")
_rb = _load("receipt_bundle", _TOOL)


def _git(cwd, *args):
    return subprocess.run(["git"] + list(args), cwd=cwd,
                          capture_output=True, text=True, timeout=30)


def _make_repo(path):
    """A real git work tree with one commit. Returns the commit sha.

    Without this the drift axis is unverifiable and NO bundle can ever read
    VERIFIED, which would leave the suite unable to tell a working tool from
    one that hardcodes a failing verdict.
    """
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "t@example.com")
    _git(path, "config", "user.name", "t")
    (pathlib.Path(path) / "seed.txt").write_text("seed\n")
    _git(path, "add", "seed.txt")
    _git(path, "commit", "-q", "-m", "seed")
    return _git(path, "rev-parse", "HEAD").stdout.strip()


def _receipt(base_sha, head_sha, usd=0.42, measured=True):
    """A receipt every axis can genuinely be checked against.

    measured=False is the HONEST unmeasured shape: available=false and no
    values. It must not contribute to the bundle total, and it must still
    VERIFY -- "this run did not measure cost" is a truthful receipt, and a
    bundle containing one is not thereby forged.

    The DISHONEST shape (available=true, every value zero -- what a real
    FireLater run shipped before v8.51.0) is deliberately not used here: the
    verifier's own cost-coherence check already fails it upstream, so it would
    exercise that rule rather than this file's sum-only-measured rule.
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


class BundleCase(unittest.TestCase):
    """A workspace of receipts inside a real git repo."""

    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.head = _make_repo(self.repo)

    def _write(self, name, proof):
        d = pathlib.Path(self.repo) / ".loki" / "proofs" / name
        d.mkdir(parents=True, exist_ok=True)
        path = d / "proof.json"
        path.write_text(json.dumps(proof, indent=2), encoding="utf-8")
        return path

    def _good(self, name, usd=0.42, measured=True):
        return self._write(name, _receipt(self.head, self.head, usd, measured))

    def _tampered(self, name):
        """A receipt whose facts were edited after the hash was computed."""
        proof = _receipt(self.head, self.head)
        proof["facts"]["tests"]["exit_code"] = 99
        return self._write(name, proof)

    def _bundle(self):
        return _rb.bundle(self.repo, self.repo)


class WeakestLinkNotAverage(BundleCase):
    """The rule the whole feature exists for."""

    def test_all_good_bundle_verifies(self):
        """Positive control. Without it, 'hardcode FAILED' passes the suite."""
        for i in range(3):
            self._good("run-%d" % i)
        report = self._bundle()
        self.assertEqual(report["verdict"], _rb.VERIFIED, report["summary"])
        self.assertEqual(report["counts"][_rb.VERIFIED], 3)
        self.assertEqual(report["not_verified"], [])

    def test_one_bad_receipt_fails_the_whole_bundle(self):
        """2 good + 1 bad. A majority or averaging rollup would call this
        clean; weakest-link is the only rule that fails it."""
        self._good("run-0")
        self._good("run-1")
        bad = self._tampered("run-2")

        report = self._bundle()
        self.assertEqual(
            report["verdict"], _rb.FAILED,
            "a forged receipt hid behind two good ones: %s" % report["summary"])
        self.assertNotIn("%", report["summary"],
                         "the rollup reported a percentage, which lets a bad "
                         "run hide behind good ones")
        self.assertIn(str(bad), [r["path"] for r in report["not_verified"]])

    def test_bad_receipt_still_sinks_a_large_bundle(self):
        """Averaging gets cheaper to pass as the bundle grows. This is the
        same assertion at a ratio where any threshold rule would pass."""
        for i in range(9):
            self._good("run-%d" % i)
        self._tampered("run-bad")
        report = self._bundle()
        self.assertEqual(report["verdict"], _rb.FAILED,
                         "9 good receipts laundered 1 bad one")

    def test_rollup_is_order_independent(self):
        """min() over a worst-first order, not first-wins or last-wins."""
        self.assertEqual(_rb.rollup([_rb.VERIFIED, _rb.FAILED]), _rb.FAILED)
        self.assertEqual(_rb.rollup([_rb.FAILED, _rb.VERIFIED]), _rb.FAILED)
        self.assertEqual(
            _rb.rollup([_rb.VERIFIED, _rb.UNVERIFIABLE, _rb.FAILED]),
            _rb.FAILED, "FAILED must outrank UNVERIFIABLE")
        self.assertEqual(_rb.rollup([_rb.VERIFIED, _rb.UNVERIFIABLE]),
                         _rb.UNVERIFIABLE)


class UpstreamFailureIsNotUpgradedToPass(BundleCase):
    """A verify() axis this file does not enumerate must not arrive as a pass.

    receipt_state() names four failure axes explicitly (hash, drift, gpg,
    headline) and then falls back on verify()'s own `ok`. That fallback is the
    only thing standing between "proof-verify.py grew a new check" and "the
    bundle silently certifies receipts failing it" -- a rollup that upgrades an
    unrecognised failure to VERIFIED is the weakest-link rule defeated from
    below rather than by averaging.

    cost_coherent is exactly such an axis: it sinks verify()'s `ok` (proof-
    verify.py:666) and appears in NONE of the four explicit branches, so it
    reaches FAILED only through the fallback. Without this test the fallback is
    decorative -- deleting it leaves the suite green.
    """

    def _incoherent(self, name):
        """The dishonest cost shape a real run shipped before v8.51.0:
        available=true with every value zero. It claims a measurement it does
        not have, and the verifier refuses it."""
        proof = _receipt(self.head, self.head)
        proof["cost"] = {"available": True, "usd": 0, "input_tokens": 0,
                         "output_tokens": 0, "cache_read_tokens": 0,
                         "cache_creation_tokens": 0}
        unsigned = dict(proof)
        unsigned.pop("verification", None)
        proof["verification"] = {
            "hash": hashlib.sha256(
                _pv._canonical(unsigned).encode("utf-8")).hexdigest()}
        return self._write(name, proof)

    def test_unenumerated_failure_axis_still_fails_the_bundle(self):
        bad = self._incoherent("run-bad")
        # The hash is valid, so this is NOT caught by the hash_ok branch.
        state, reason = _rb.receipt_state(bad, self.repo)
        self.assertEqual(state, _rb.FAILED,
                         "a receipt verify() rejected was upgraded to a pass "
                         "because this file does not enumerate its axis")
        self.assertIn("cost", reason.lower(),
                      "the failure was reported without its reason")

    def test_unenumerated_failure_sinks_the_rollup(self):
        self._good("run-0")
        self._good("run-1")
        self._incoherent("run-bad")
        report = self._bundle()
        self.assertEqual(report["verdict"], _rb.FAILED, report["summary"])
        self.assertEqual(len(report["not_verified"]), 1)


class UnverifiableIsNamedNotDropped(BundleCase):
    """Absent is not clean."""

    def test_unloadable_receipt_is_counted_named_and_explained(self):
        self._good("run-0")
        broken = self._write_raw("run-bad", "{ this is not json")

        report = self._bundle()
        paths = [r["path"] for r in report["receipts"]]
        self.assertIn(str(broken), paths,
                      "an unreadable receipt was silently dropped from the "
                      "bundle, so the report covers less than it claims")

        named = [r for r in report["not_verified"] if r["path"] == str(broken)]
        self.assertEqual(len(named), 1, "the bad receipt was not named")
        self.assertTrue(named[0]["reason"].strip(),
                        "the bad receipt was named without a reason")
        self.assertNotEqual(report["verdict"], _rb.VERIFIED,
                            "a receipt nobody could check did not hold the "
                            "bundle back")

    def test_unverifiable_receipt_outside_a_git_tree(self):
        """The honest UNVERIFIABLE path: a real receipt checked from a
        directory where its diff cannot be re-derived."""
        self._good("run-0")
        outside = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)

        report = _rb.bundle(self.repo, outside)
        self.assertEqual(report["verdict"], _rb.UNVERIFIABLE, report["summary"])
        self.assertEqual(len(report["not_verified"]), 1)
        self.assertTrue(report["not_verified"][0]["reason"].strip())

    def _write_raw(self, name, text):
        d = pathlib.Path(self.repo) / ".loki" / "proofs" / name
        d.mkdir(parents=True, exist_ok=True)
        path = d / "proof.json"
        path.write_text(text, encoding="utf-8")
        return path


class CostSumsOnlyMeasured(BundleCase):
    """A partial total must not wear the label of the whole."""

    def test_total_sums_only_measured_and_reports_the_ratio(self):
        self._good("run-0", usd=1.00)
        self._good("run-1", usd=0.50)
        self._good("run-2", measured=False)

        report = self._bundle()
        cost = report["cost"]
        self.assertAlmostEqual(cost["total_usd"], 1.50, places=6,
                               msg="an unmeasured receipt contributed to the "
                                   "bundle total")
        self.assertEqual(cost["measured_receipts"], 2)
        self.assertEqual(cost["total_receipts"], 3)
        self.assertIn("2 of 3", report["summary"],
                      "the total was reported without saying how many "
                      "receipts it actually covers")

    def test_nothing_measured_reads_unknown_never_zero(self):
        self._good("run-0", measured=False)
        self._good("run-1", measured=False)

        report = self._bundle()
        self.assertIsNone(report["cost"]["total_usd"],
                          "an unmeasured bundle claimed a cost total")
        self.assertIn("UNKNOWN", report["summary"])
        self.assertNotIn("$0.00", report["summary"],
                         "unmeasured was reported as free")

    def test_measured_zero_survives_as_a_number(self):
        """The opposite dishonesty. A guard on the falsy TOTAL rather than on
        the measured COUNT would erase a genuine $0.00 observation."""
        self._good("run-0", usd=0.0)
        report = self._bundle()
        # usd=0 with nonzero token counts is genuinely measured.
        self.assertEqual(report["cost"]["measured_receipts"], 1)
        self.assertEqual(report["cost"]["total_usd"], 0.0)
        self.assertNotIn("UNKNOWN", report["summary"])


class EmptyIsNotAPassingAudit(BundleCase):
    """Vacuous truth is the cheapest false green there is."""

    def test_empty_workspace_does_not_read_clean(self):
        report = self._bundle()
        self.assertEqual(report["verdict"], _rb.EMPTY)
        self.assertNotEqual(report["verdict"], _rb.VERIFIED)
        self.assertEqual(report["receipts"], [])
        self.assertIn("not a passing audit", report["summary"].lower())

    def test_empty_workspace_exits_nonzero(self):
        """A CI step gating on the exit code must not be passed by deleting
        every receipt."""
        proc = subprocess.run(
            [sys.executable, str(_TOOL), self.repo, "--json"],
            capture_output=True, text=True, timeout=120)
        self.assertNotEqual(proc.returncode, 0,
                            "an empty workspace exited 0, so the audit is "
                            "passed by removing the evidence")
        self.assertEqual(json.loads(proc.stdout)["verdict"], _rb.EMPTY)

    def test_empty_rollup_is_empty_not_verified(self):
        self.assertEqual(_rb.rollup([]), _rb.EMPTY)


class CliContract(BundleCase):
    """Exit codes are the machine-readable half of the verdict."""

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(_TOOL), self.repo, "--repo-dir", self.repo]
            + list(args), capture_output=True, text=True, timeout=120)

    def test_exit_zero_only_when_every_receipt_verified(self):
        self._good("run-0")
        self._good("run-1")
        self.assertEqual(self._run().returncode, 0)

    def test_exit_one_when_any_receipt_failed(self):
        self._good("run-0")
        self._tampered("run-1")
        proc = self._run()
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertIn("FAILED", proc.stdout)


if __name__ == "__main__":
    unittest.main()
