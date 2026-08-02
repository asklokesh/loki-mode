"""An unchecked axis must never acquire a credential it did not earn.

WHAT THIS LOCKS DOWN. tools/receipt-attest.py exists to keep three states
apart -- VERIFIED (checked, passed), FAILED (checked, failed), UNVERIFIABLE
(could not be checked here). Every system that ships two of the three has
picked a way to lie:

    UNVERIFIABLE folded into FAILED    an honest receipt read from the wrong
                                       directory looks forged
    UNVERIFIABLE folded into VERIFIED  an axis nobody checked is now attested

The second is the one worth a test suite. An attestation is a credential, and
a credential that covers what was not examined is worse than no credential --
it launders "we could not tell" into "we confirmed". So the central assertion
here is not that a good receipt passes; it is that the drift axis, when it
cannot be re-derived, says UNVERIFIABLE and says WHY.

The positive control is load-bearing and easy to omit. "Outside a git tree ->
UNVERIFIABLE" also passes for an implementation that hardcodes UNVERIFIABLE
and checks nothing at all. It is paired with the same receipt inside a real
git repository, where drift must read VERIFIED. Neither half means much
alone.

Signature gets its own pair for the same reason. _verify_gpg returns the
string "n/a" both for "no signature" and for "signature present, gpg missing",
so a naive reading reports a signed receipt as unsigned on any machine without
gpg -- the same collapse one layer down.
"""

import contextlib
import hashlib
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
_LIB = _ROOT / "autonomy" / "lib"
_TOOL = _ROOT / "tools" / "receipt-attest.py"

_spec = importlib.util.spec_from_file_location(
    "proof_verify", _LIB / "proof-verify.py")
_pv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pv)

_aspec = importlib.util.spec_from_file_location("receipt_attest", _TOOL)
_ra = importlib.util.module_from_spec(_aspec)
_aspec.loader.exec_module(_ra)


def _git(cwd, *args):
    return subprocess.run(["git"] + list(args), cwd=cwd,
                          capture_output=True, text=True, timeout=30)


def _make_repo(path):
    """A real git work tree with one commit. Returns the commit sha."""
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "t@example.com")
    _git(path, "config", "user.name", "t")
    (pathlib.Path(path) / "seed.txt").write_text("seed\n")
    _git(path, "add", "seed.txt")
    _git(path, "commit", "-q", "-m", "seed")
    return _git(path, "rev-parse", "HEAD").stdout.strip()


def _receipt(base_sha, head_sha, signature=None, diff=None, tree=None):
    """A receipt every axis can actually be checked against.

    Drift: recorded diff matches base..HEAD, so drift is genuinely VERIFIED
    rather than merely unchecked. No diff_sha256 and no tree digest, so those
    branches stay out of the way of what is under test.

    Headline and cost blocks are present ON PURPOSE. Omitting them makes both
    axes report UNVERIFIABLE -- correct behaviour, but it would leave the
    positive control unable to reach a VERIFIED verdict, and a suite that
    never sees VERIFIED cannot tell a working tool from one that hardcodes
    UNVERIFIABLE. The headline is re-derived with the module's own function
    rather than hardcoded, so this fixture cannot drift from the generator's
    rules.
    """
    diff = diff or {"count": 0, "insertions": 0, "deletions": 0}
    facts = {
        "git": {
            "base_sha": base_sha,
            "head_sha": head_sha,
            "diff": dict(diff),
        },
        "tests": {"status": "verified", "command": "pytest -q", "exit_code": 0},
        "execution": {"outcome": "complete", "exit_code": 0},
    }
    if tree is not None:
        facts["git"]["tree_sha256"] = tree
    proof = {
        "schema": "1.1",
        "facts": facts,
        "honesty": {"headline": _pv._compute_headline(facts, []),
                    "degraded": []},
        "cost": {
            "available": True,
            "usd": 0.42,
            "input_tokens": 1000,
            "output_tokens": 50,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
        },
    }
    unsigned = dict(proof)
    unsigned.pop("verification", None)
    digest = hashlib.sha256(
        _pv._canonical(unsigned).encode("utf-8")).hexdigest()
    verification = {"hash": digest}
    if signature is not None:
        verification["gpg_signature"] = signature
    proof["verification"] = verification
    return proof


def _write(dirpath, proof, name="proof.json"):
    p = pathlib.Path(dirpath) / name
    p.write_text(json.dumps(proof))
    return str(p)


class _Repo(object):
    """A git work tree plus a SEPARATE directory to hold receipts.

    The receipt must not live inside the tree it attests to. _numstat counts
    untracked files, so a receipt written into its own repo shows up in the
    re-derived diff and the receipt drifts on the mere fact of its own
    existence. That is the verifier behaving correctly, and it is also how a
    positive control accidentally becomes a negative one.
    """

    def __init__(self, stack):
        self.dir = stack.enter_context(tempfile.TemporaryDirectory())
        self.out = stack.enter_context(tempfile.TemporaryDirectory())
        self.sha = _make_repo(self.dir)

    def receipt(self, proof, name="proof.json"):
        return _write(self.out, proof, name)


def _run(proof_path, cwd, json_mode=True):
    """Exercise the real CLI, because the exit-code contract is the product."""
    argv = [sys.executable, str(_TOOL), proof_path]
    if json_mode:
        argv.append("--json")
    out = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                         timeout=120)
    record = json.loads(out.stdout) if json_mode and out.stdout.strip() else {}
    return out.returncode, record, out.stdout


class ValidReceiptAttests(unittest.TestCase):
    def test_valid_receipt_in_its_repo_is_verified(self):
        """The positive control. Every axis checkable here, so VERIFIED and
        exit 0 -- and crucially drift is VERIFIED, not UNVERIFIABLE, which is
        what proves the drift check actually runs."""
        with contextlib.ExitStack() as stack:
            repo = _Repo(stack)
            path = repo.receipt(_receipt(repo.sha, repo.sha))
            code, rec, _ = _run(path, repo.dir)

            self.assertEqual(rec["axes"]["drift"]["state"], "VERIFIED",
                             "drift must be genuinely checked, not skipped")
            self.assertEqual(rec["axes"]["integrity"]["state"], "VERIFIED")
            self.assertEqual(rec["verdict"], "VERIFIED")
            self.assertEqual(code, 0)

            # Exit 0 on an unsigned receipt is only honest if what it does NOT
            # cover is impossible to miss. The caveat must be on the line a
            # human reads, not buried in a field nobody prints.
            self.assertIn("UNSIGNED", rec["summary"])
            self.assertTrue(rec["generator_trusted"])

            # THE CLASS INVARIANT. If this attestation says VERIFIED, the
            # verifier it projects must agree its own ok is True. An
            # attestation is a projection of verify()'s result, and a
            # projection that DROPS an axis reports VERIFIED for a receipt
            # verify() rejected -- which is how tree_drift was missed until a
            # review caught it. Any axis added upstream in future that this
            # file forgets to carry now fails here.
            #
            # One direction only. The converse does not hold and must not be
            # asserted: this tool is deliberately stricter than verify().ok on
            # axes it cannot check (verify() passes an unverifiable headline;
            # this reports UNVERIFIABLE), and that asymmetry is the feature.
            self.assertTrue(
                _pv.verify(path, repo.dir)["ok"],
                "attested VERIFIED while verify() says the receipt is not ok "
                "-- an axis was dropped from the projection")

    def test_verdict_is_not_verified_when_any_axis_is_unchecked(self):
        """The defect this feature exists to prevent, asserted at the top
        level: a receipt with an unchecked axis must not read VERIFIED."""
        with tempfile.TemporaryDirectory() as outside:
            with tempfile.TemporaryDirectory() as repo:
                sha = _make_repo(repo)
                path = _write(outside, _receipt(sha, sha))
                _, rec, _ = _run(path, outside)
                self.assertNotEqual(rec["verdict"], "VERIFIED")
                self.assertEqual(rec["verdict"], "UNVERIFIABLE")


class TamperedReceiptFails(unittest.TestCase):
    def test_tampered_receipt_is_failed_not_unverifiable(self):
        """A checked-and-failed axis must read FAILED. Reporting a detected
        forgery as UNVERIFIABLE would be the mirror-image collapse."""
        with contextlib.ExitStack() as stack:
            repo = _Repo(stack)
            proof = _receipt(repo.sha, repo.sha)
            # Edit a fact AFTER the hash was computed.
            proof["facts"]["git"]["diff"]["insertions"] = 9999
            path = repo.receipt(proof)
            code, rec, _ = _run(path, repo.dir)

            self.assertEqual(rec["axes"]["integrity"]["state"], "FAILED")
            self.assertEqual(rec["verdict"], "FAILED")
            self.assertTrue(rec["axes"]["integrity"]["reason"],
                            "a FAILED axis must say why")
            self.assertEqual(code, 1)


class WorkspaceTreeIsProjected(unittest.TestCase):
    """A regression guard for a real bug this suite could not originally see.

    proof-generator.py:1190 writes facts.git.tree_sha256 on EVERY receipt, and
    verify() scores it. The first version of receipt-attest.py projected
    integrity, drift, headline, cost and signature -- and silently dropped the
    tree axis. A receipt verify() rejected for tree drift therefore attested
    VERIFIED with exit 0. The fixtures had no tree digest, so nothing failed.

    A dropped axis defaults to "passed", which makes forgetting one strictly
    more dangerous than getting one wrong.
    """

    def test_tree_drift_is_failed_not_silently_verified(self):
        with contextlib.ExitStack() as stack:
            repo = _Repo(stack)
            path = repo.receipt(
                _receipt(repo.sha, repo.sha, tree="deadbeef" * 8))
            code, rec, _ = _run(path, repo.dir)

            self.assertIn("tree", rec["axes"],
                          "a recorded tree digest must appear as an axis")
            self.assertEqual(rec["axes"]["tree"]["state"], "FAILED")
            self.assertTrue(rec["axes"]["tree"]["reason"])
            self.assertEqual(rec["verdict"], "FAILED")
            self.assertEqual(code, 1)

    def test_no_recorded_tree_digest_is_not_an_axis(self):
        """Nothing recorded is nothing to check -- it must not manufacture an
        UNVERIFIABLE axis and drag an otherwise clean receipt off VERIFIED."""
        with contextlib.ExitStack() as stack:
            repo = _Repo(stack)
            path = repo.receipt(_receipt(repo.sha, repo.sha))
            code, rec, _ = _run(path, repo.dir)
            self.assertNotIn("tree", rec["axes"])
            self.assertEqual(code, 0)


class DriftUnverifiableOutsideGitTree(unittest.TestCase):
    def test_outside_git_tree_drift_is_unverifiable_with_reason(self):
        """The core requirement. No work tree -> drift cannot be re-derived,
        so it is UNVERIFIABLE and carries the reason. Integrity is still
        VERIFIED, proving the axes are independent rather than one verdict
        smeared across all of them."""
        with tempfile.TemporaryDirectory() as outside:
            with tempfile.TemporaryDirectory() as repo:
                sha = _make_repo(repo)
                path = _write(outside, _receipt(sha, sha))
                code, rec, _ = _run(path, outside)

                self.assertEqual(rec["axes"]["drift"]["state"], "UNVERIFIABLE")
                self.assertIn("git", rec["axes"]["drift"]["reason"].lower(),
                              "the reason must name why it could not check")
                self.assertEqual(rec["axes"]["integrity"]["state"], "VERIFIED",
                                 "an unverifiable axis must not poison a "
                                 "checked one")
                self.assertEqual(code, 2)

    def test_missing_base_sha_is_unverifiable_not_verified(self):
        """A receipt with no recorded base_sha cannot have drift re-derived
        even inside a real repo. Silently passing this is how an unchecked
        axis earns a credential."""
        with contextlib.ExitStack() as stack:
            repo = _Repo(stack)
            proof = _receipt(repo.sha, repo.sha)
            del proof["facts"]["git"]["base_sha"]
            # Re-hash so integrity stays VERIFIED and drift is isolated.
            unsigned = dict(proof)
            unsigned.pop("verification", None)
            proof["verification"]["hash"] = hashlib.sha256(
                _pv._canonical(unsigned).encode("utf-8")).hexdigest()
            path = repo.receipt(proof)
            code, rec, _ = _run(path, repo.dir)

            self.assertEqual(rec["axes"]["integrity"]["state"], "VERIFIED")
            self.assertEqual(rec["axes"]["drift"]["state"], "UNVERIFIABLE")
            self.assertEqual(code, 2)


class SignatureIsThreeStates(unittest.TestCase):
    def test_unsigned_and_signed_invalid_are_distinguishable(self):
        """Never a boolean. Unsigned is UNVERIFIABLE/unsigned (absence of
        evidence); a signature that does not verify is FAILED/signed_invalid
        (evidence of absence). Collapsing them either way is a lie in one
        direction or the other."""
        with contextlib.ExitStack() as stack:
            repo = _Repo(stack)

            unsigned_path = repo.receipt(
                _receipt(repo.sha, repo.sha), "unsigned.json")
            _, unsigned_rec, _ = _run(unsigned_path, repo.dir)

            bad_path = repo.receipt(
                _receipt(repo.sha, repo.sha,
                         signature="-----BEGIN PGP SIGNATURE-----\n"
                                   "not-a-real-signature\n"
                                   "-----END PGP SIGNATURE-----\n"),
                "signed.json")
            _, bad_rec, _ = _run(bad_path, repo.dir)

            self.assertEqual(unsigned_rec["signature"]["status"], "unsigned")
            # "No signature exists" is not "a check I could not run", so it is
            # reported and NOT scored -- matching verify()'s own rollup
            # (gpg_ok in (True, "n/a")). Scoring it would make VERIFIED
            # unreachable for every receipt built without LOKI_PROOF_GPG_KEY,
            # which is the default.
            self.assertFalse(unsigned_rec["signature"]["scored"])
            self.assertNotEqual(unsigned_rec["signature"]["state"], "VERIFIED")

            self.assertNotEqual(bad_rec["signature"]["status"],
                                unsigned_rec["signature"]["status"])
            # gpg present -> signed_invalid/FAILED. gpg absent -> the string
            # "n/a" comes back for a signature that IS recorded, and reporting
            # that as "unsigned" is the collapse. Either way it must not read
            # as unsigned, and must not read as VERIFIED.
            self.assertIn(bad_rec["signature"]["status"],
                          ("signed_invalid", "signed_uncheckable"))
            self.assertNotEqual(bad_rec["signature"]["state"], "VERIFIED")
            self.assertTrue(bad_rec["signature"]["reason"])

            # A RECORDED signature is always scored, whichever way it lands.
            # This is what keeps "nothing to check" (unsigned) apart from
            # "could not check" (signed_uncheckable) -- the collapse that
            # would let a signed receipt pass as unsigned on a box with no
            # gpg, and the reason presence is read from the receipt rather
            # than inferred from gpg_ok's overloaded "n/a".
            self.assertTrue(bad_rec["signature"]["scored"])
            self.assertNotEqual(bad_rec["verdict"], "VERIFIED",
                                "a recorded signature that did not verify "
                                "must not yield a VERIFIED attestation")

    def test_signed_but_uncheckable_never_reports_as_unsigned(self):
        """The collapse this feature exists to prevent, one layer down.

        _verify_gpg returns the string "n/a" for BOTH "no signature recorded"
        and "signature recorded but gpg missing from PATH". A reader that
        trusts gpg_ok alone therefore reports a SIGNED receipt as unsigned on
        any machine without gpg -- quietly discarding the fact that a
        cryptographic claim exists and was not examined.

        This is asserted at the function rather than through the CLI on
        purpose: gpg is installed on this machine, so the "n/a"-despite-a-
        signature branch is unreachable end to end here. Driving gpg_ok
        directly is the only way to cover it, and leaving it uncovered was a
        real gap -- a mutation collapsing this branch into unsigned survived
        the CLI-level tests.
        """
        proof = {"verification": {"hash": "x", "gpg_signature": "SIG"}}
        axis = _ra._signature_axis(proof, "n/a")

        self.assertEqual(axis["status"], "signed_uncheckable")
        self.assertNotEqual(axis["status"], "unsigned")
        self.assertEqual(axis["state"], "UNVERIFIABLE")
        # Scored, unlike unsigned: a recorded-but-unexamined signature is a
        # check we could not run, so it must hold the verdict back.
        self.assertTrue(axis["scored"])
        self.assertTrue(axis["reason"])

        # And the genuinely-unsigned receipt stays distinguishable from it.
        bare = _ra._signature_axis({"verification": {"hash": "x"}}, "n/a")
        self.assertEqual(bare["status"], "unsigned")
        self.assertFalse(bare["scored"])

    def test_unsigned_receipt_never_reports_signature_verified(self):
        """gpg_ok is the truthy string "n/a" on the unsigned path, so any
        `if gpg_ok:` reading calls an unsigned receipt validly signed."""
        with contextlib.ExitStack() as stack:
            repo = _Repo(stack)
            path = repo.receipt(_receipt(repo.sha, repo.sha))
            _, rec, _ = _run(path, repo.dir)
            self.assertNotEqual(rec["signature"]["state"], "VERIFIED")


class ExitCodeContract(unittest.TestCase):
    def test_three_states_map_to_three_exit_codes(self):
        """0 only when nothing failed AND nothing was left unchecked. An
        UNVERIFIABLE axis exiting 0 would let a `&&` chain read "unattested"
        as "attested", re-collapsing the third state at the shell boundary."""
        self.assertEqual(_ra.exit_code({"verdict": "VERIFIED"}), 0)
        self.assertEqual(_ra.exit_code({"verdict": "FAILED"}), 1)
        self.assertEqual(_ra.exit_code({"verdict": "UNVERIFIABLE"}), 2)

    def test_unloadable_receipt_is_unverifiable_not_failed(self):
        """A receipt we could not read is not a receipt we found fault with."""
        with tempfile.TemporaryDirectory() as tmp:
            bad = pathlib.Path(tmp) / "broken.json"
            bad.write_text("{not json")
            code, rec, _ = _run(str(bad), tmp)
            self.assertEqual(rec["verdict"], "UNVERIFIABLE")
            self.assertEqual(code, 2)

    def test_human_output_states_the_verdict(self):
        """The default surface is the one a person reads; it must not be
        silent about which of the three states applies."""
        with tempfile.TemporaryDirectory() as outside:
            with tempfile.TemporaryDirectory() as repo:
                sha = _make_repo(repo)
                path = _write(outside, _receipt(sha, sha))
                _, _, stdout = _run(path, outside, json_mode=False)
                self.assertIn("UNVERIFIABLE", stdout)
                self.assertIn("drift", stdout)



class TheCommandLineIsNotAReceipt(unittest.TestCase):
    """A flag must never be read as a proof path.

    `--help` fell through to the positional slot and produced
    "UNVERIFIABLE -- proof file not found: --help": a verification VERDICT
    about a file the user never named. On the tool whose entire job is issuing
    trustworthy verdicts, answering a question nobody asked is the worst
    possible failure mode -- it is indistinguishable, to a script, from a real
    finding about a real receipt.

    Every sibling tool uses argparse and rejects unknown flags; this one
    hand-rolled its parsing, which is how it drifted alone.
    """

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(_TOOL), *args],
            capture_output=True, text=True, timeout=60)

    def test_help_prints_usage_and_exits_zero(self):
        r = self._run("--help")
        self.assertEqual(r.returncode, 0, r.stderr[:200])
        self.assertIn("usage:", r.stdout)

    def test_help_is_not_treated_as_a_proof_path(self):
        """Assert the DEFECT STRING, not the state names.

        Earlier drafts asserted that "UNVERIFIABLE" never appears. That fails
        on correct output, because the usage text legitimately DEFINES the
        three states. The defect is precise and has its own sentence: the flag
        being reported as a missing proof file.
        """
        r = self._run("--help")
        self.assertNotIn(
            "proof file not found", r.stdout + r.stderr,
            "--help was read as a filename and produced a verdict about it")

    def test_an_unknown_flag_is_an_error_not_a_path(self):
        r = self._run("--jsonn")
        self.assertEqual(r.returncode, 64, r.stdout[:200])
        self.assertIn("unknown option", r.stderr)
        self.assertNotIn(
            "proof file not found", r.stdout + r.stderr,
            "a typo'd flag was read as a proof path")

    def test_a_real_path_still_attests(self):
        """The guard must not block the tool's actual job."""
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "proof.json"
            p.write_text("{}", encoding="utf-8")
            r = self._run(str(p))
            self.assertIn(r.returncode, (0, 1, 2), r.stderr[:200])
            self.assertTrue(r.stdout.strip(), "a real path produced no output")

if __name__ == "__main__":
    unittest.main()
