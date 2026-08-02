"""A failed verification must say WHY, in terms a user can act on.

STRATEGIC CONTEXT. `benchmarks/results/competitor-verify-surface.json` records
that of six installed coding-agent CLIs (opencode, aider, codex, claude,
cursor-agent, loki-mode), only loki-mode verifies its own output. The Evidence
Receipt is the moat, so its verifier has to be unimpeachable -- and a verifier
that says "verification failed" and nothing else is not.

WHAT THIS LOCKS DOWN. `verify_integrity()` and `verify()` return `reasons`: a
list naming EVERY check that failed, not just the first. Three properties, and
all three are load-bearing:

  1. Every failure mode produces its own specific, actionable reason. A generic
     "verification failed" is the defect being fixed.
  2. A PASSING receipt produces an EMPTY list. A verifier that invents a
     complaint about a clean receipt is lying in the other direction, and the
     Evidence Receipt is worth nothing if it can certify either lie.
  3. The pass/fail VERDICTS are unchanged. This explains the verdict, it does
     not relax it. Asserted in both directions below: a valid receipt still
     passes, an incoherent-cost receipt still fails.

`reason` (singular, first-wins) keeps its exact meaning and precedence -- other
tests and callers read it. `reasons` is additive.
"""

import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_SRC = _ROOT / "autonomy" / "lib" / "proof-verify.py"

_spec = importlib.util.spec_from_file_location("proof_verify", _SRC)
_pv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pv)

_MEASURED_COST = {
    "usd": 0.42, "input_tokens": 9412, "output_tokens": 23,
    "cache_read_tokens": 11008, "cache_creation_tokens": 0,
    "available": True,
}

# The exact shape that shipped in a real FireLater receipt: a shareable
# document asserting the run was FREE, with a VALID integrity hash.
_UNMEASURED_COST = {
    "usd": 0.0, "input_tokens": 0, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "available": True,
}


def _sealed(cost=None, **extra):
    """A receipt with a genuinely valid integrity hash.

    Hashes the canonical form the way the generator does, so this fixture
    PASSES verify_integrity -- the only honest baseline for "a clean receipt
    reports no reasons".
    """
    proof = {"schema_version": "1.1", "run_id": "run-test", "facts": {},
             "honesty": {}}
    if cost is not None:
        proof["cost"] = cost
    proof.update(extra)
    digest = _pv.hashlib.sha256(
        _pv._canonical(proof).encode("utf-8")).hexdigest()
    proof["verification"] = {"hash": digest, "algo": "sha256",
                             "scope": "integrity"}
    return proof


def _joined(result):
    return "\n".join(result["reasons"])


class PassingReceiptTests(unittest.TestCase):
    """Property 2 + the pass half of property 3."""

    def test_valid_receipt_still_passes(self):
        """VERDICT UNCHANGED: a clean receipt verifies."""
        r = _pv.verify_integrity(_sealed(cost=_MEASURED_COST))
        self.assertTrue(r["ok"], "a valid receipt stopped passing: %s" % r)
        self.assertTrue(r["cost_coherent"])

    def test_passing_receipt_reports_no_reasons(self):
        """A verifier must not invent a complaint about a clean receipt."""
        r = _pv.verify_integrity(_sealed(cost=_MEASURED_COST))
        self.assertEqual(
            r["reasons"], [],
            "a PASSING receipt reported reasons; a fabricated complaint is "
            "its own dishonesty")

    def test_reasons_key_is_always_a_list(self):
        """Type stability: callers may iterate without a guard."""
        for proof in (_sealed(cost=_MEASURED_COST), _sealed(), "not-a-dict",
                      {"verification": {}}):
            self.assertIsInstance(_pv.verify_integrity(proof)["reasons"], list)


class SpecificReasonTests(unittest.TestCase):
    """Property 1: each failure names itself, distinctly."""

    def test_cost_incoherence_names_the_free_claim(self):
        """The moat-breaking defect must be explained, not just flagged."""
        r = _pv.verify_integrity(_sealed(cost=_UNMEASURED_COST))
        self.assertFalse(r["ok"])
        text = _joined(r)
        self.assertIn("cost", text.lower())
        self.assertIn(
            "unmeasured", text.lower(),
            "the cost reason must state the honesty rule (unmeasured is not "
            "free), not merely that a check failed; got: %r" % text)

    def test_missing_hash_says_the_hash_is_missing(self):
        r = _pv.verify_integrity({"facts": {}, "honesty": {}})
        self.assertFalse(r["ok"])
        self.assertIn("integrity hash missing", _joined(r))

    def test_hash_mismatch_reports_both_hashes(self):
        """Actionable means showing recorded AND computed."""
        proof = _sealed(cost=_MEASURED_COST)
        recorded = proof["verification"]["hash"]
        proof["run_id"] = "edited-after-signing"
        r = _pv.verify_integrity(proof)
        self.assertFalse(r["hash_ok"])
        text = _joined(r)
        self.assertIn("hash mismatch", text)
        self.assertIn(recorded, text, "the recorded hash was not reported")

    def test_non_dict_root_is_explained(self):
        r = _pv.verify_integrity("not-a-proof")
        self.assertFalse(r["ok"])
        self.assertIn("JSON object", _joined(r))

    def test_no_failed_verdict_is_ever_unexplained(self):
        """The whole point: ok=False with an empty list is the bug."""
        for proof in ("not-a-dict", {}, {"verification": {"hash": "nope"}},
                      _sealed(cost=_UNMEASURED_COST)):
            r = _pv.verify_integrity(proof)
            self.assertFalse(r["ok"])
            self.assertTrue(
                r["reasons"],
                "a FAILED verdict carried no reason at all: %r" % proof)

    def test_every_reason_is_a_sentence_not_a_code(self):
        """Human-readable means prose, not an enum a user must look up."""
        r = _pv.verify_integrity(_sealed(cost=_UNMEASURED_COST))
        for reason in r["reasons"]:
            self.assertGreater(len(reason), 30, "too terse to act on: %r" % reason)
            self.assertIn(" ", reason.strip())


class MultipleFailureTests(unittest.TestCase):
    """`reasons` exists because `reason` reports only the first failure."""

    def test_two_failures_both_appear(self):
        proof = _sealed(cost=_UNMEASURED_COST)
        proof["run_id"] = "tampered"  # now hash mismatch AND cost incoherence
        r = _pv.verify_integrity(proof)
        text = _joined(r)
        self.assertIn("hash mismatch", text)
        self.assertIn("cost", text.lower())
        self.assertGreaterEqual(
            len(r["reasons"]), 2,
            "two independent checks failed but only one was reported -- that "
            "is the first-wins behaviour `reasons` exists to fix")

    def test_reason_singular_keeps_first_wins_precedence(self):
        """BACKWARD COMPAT: `reason` is unchanged for existing callers."""
        proof = _sealed(cost=_UNMEASURED_COST)
        proof["run_id"] = "tampered"
        r = _pv.verify_integrity(proof)
        self.assertIn("integrity hash mismatch", r["reason"])
        self.assertIsInstance(r["reason"], str)


class VerdictUnchangedTests(unittest.TestCase):
    """Property 3, both directions. A fail-closed gate stays fail-closed."""

    def test_incoherent_cost_still_fails(self):
        r = _pv.verify_integrity(_sealed(cost=_UNMEASURED_COST))
        self.assertFalse(
            r["cost_coherent"],
            "the $0.00-as-free receipt started passing; that is the moat "
            "breaking")
        self.assertFalse(r["ok"])

    def test_available_false_with_a_number_still_fails(self):
        r = _pv.verify_integrity(_sealed(cost={
            "usd": 1.5, "input_tokens": 0, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_creation_tokens": 0,
            "available": False}))
        self.assertFalse(r["cost_coherent"])

    def test_usd_without_tokens_still_fails(self):
        r = _pv.verify_integrity(_sealed(cost={"usd": 3.0, "available": True}))
        self.assertFalse(r["cost_coherent"])

    def test_absent_cost_block_still_abstains(self):
        """No cost recorded is not a failure -- abstention stays honest."""
        r = _pv.verify_integrity(_sealed())
        self.assertIsNone(r["cost_coherent"])
        self.assertTrue(r["ok"])
        self.assertEqual(r["reasons"], [])


class RenderingTests(unittest.TestCase):
    """A human has to be able to read the verdict."""

    def test_failing_render_lists_the_reasons(self):
        r = _pv.verify_integrity(_sealed(cost=_UNMEASURED_COST))
        out = _pv.render_reasons(r)
        self.assertIn("FAILED", out)
        for reason in r["reasons"]:
            self.assertIn(reason, out)

    def test_passing_render_states_the_verdict_alone(self):
        out = _pv.render_reasons(_pv.verify_integrity(_sealed(cost=_MEASURED_COST)))
        self.assertEqual(out.strip(), "VERIFIED")


class DriftReasonTests(unittest.TestCase):
    """verify() adds failures of its own, and they need reasons too.

    A receipt with a VALID hash but a drifted diff fails in verify(), not in
    verify_integrity(). If the list were built only in the latter, this case
    would return ok=False with an EMPTY list -- the generic-failure bug simply
    relocated. These assert it is not.
    """

    def setUp(self):
        """A disposable repo with two commits.

        The receipt must be verified against a repo whose base..HEAD diff is
        real and FIXED. Verifying against this checkout instead would make the
        assertion depend on whatever is uncommitted at the time -- a test that
        passes or fails on ambient state proves nothing.
        """
        self.repo = tempfile.mkdtemp()
        run = lambda *a: subprocess.run(
            ["git", "-C", self.repo] + list(a),
            capture_output=True, text=True, check=True)
        run("init", "-q")
        run("config", "user.email", "t@example.com")
        run("config", "user.name", "t")
        (pathlib.Path(self.repo) / "a.txt").write_text("one\n")
        run("add", "a.txt")
        run("commit", "-qm", "base")
        self.base = run("rev-parse", "HEAD").stdout.strip()
        (pathlib.Path(self.repo) / "a.txt").write_text("one\ntwo\nthree\n")
        run("commit", "-qam", "head")

    def _drifted_proof(self, repo=None):
        body = {
            "schema_version": "1.1", "run_id": "drift", "honesty": {},
            "cost": _MEASURED_COST,
            # Counts the real base..HEAD diff (1 file / +2 / -0) cannot match,
            # so drift is certain and independent of ambient repo state.
            "facts": {"git": {"base_sha": self.base, "head_sha": self.base,
                              "diff": {"count": 99, "insertions": 4242,
                                       "deletions": 1717}}},
        }
        body["verification"] = {
            "hash": _pv.hashlib.sha256(
                _pv._canonical(body).encode("utf-8")).hexdigest(),
            "algo": "sha256", "scope": "integrity"}
        fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(body, fh)
        fh.close()
        return fh.name

    def test_diff_drift_reports_recorded_and_current_counts(self):
        path = self._drifted_proof()
        r = _pv.verify(path, self.repo)
        self.assertTrue(r["hash_ok"], "fixture should have a VALID hash")
        self.assertFalse(r["ok"])
        self.assertTrue(
            r["reasons"],
            "a drift failure produced NO reason -- the generic-failure bug "
            "relocated from verify_integrity() into verify()")
        text = _joined(r)
        self.assertIn("drift", text.lower())
        self.assertIn("99", text, "the recorded count was not reported")

    def test_clean_receipt_passes_verify_with_no_reasons(self):
        """The pass direction on the verify() path, not just integrity.

        `reasons` is COPIED into verify(), appended to by six drift/tree
        sites, then cleared when ok. Only a receipt that survives the whole
        path proves the clear actually happens -- and that a clean receipt is
        never handed a fabricated complaint.
        """
        stat = _pv._numstat(self.repo, self.base, "HEAD")
        self.assertIsNotNone(stat, "fixture repo produced no diff")
        body = {
            "schema_version": "1.1", "run_id": "clean", "honesty": {},
            "cost": _MEASURED_COST,
            # The REAL base..HEAD counts, so there is no drift to report.
            "facts": {"git": {"base_sha": self.base, "head_sha": self.base,
                              "diff": {"count": stat["count"],
                                       "insertions": stat["insertions"],
                                       "deletions": stat["deletions"]}}},
        }
        body["verification"] = {
            "hash": _pv.hashlib.sha256(
                _pv._canonical(body).encode("utf-8")).hexdigest(),
            "algo": "sha256", "scope": "integrity"}
        fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(body, fh)
        fh.close()

        r = _pv.verify(fh.name, self.repo)
        self.assertTrue(r["ok"], "a clean receipt failed verify(): %s" % r["reasons"])
        self.assertEqual(
            r["reasons"], [],
            "a PASSING receipt carried reasons through verify()")
        self.assertEqual(r["reason"], "")
        self.assertEqual(_pv.render_reasons(r).strip(), "VERIFIED")

    def test_non_git_dir_explains_why_drift_is_unverifiable(self):
        path = self._drifted_proof()
        r = _pv.verify(path, tempfile.mkdtemp())
        self.assertFalse(r["ok"])
        self.assertIn("not a git work tree", _joined(r))


class CliTests(unittest.TestCase):
    """The CLI is what proof.ts pipes through; its contract must hold."""

    def _write(self, proof):
        fh = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False)
        json.dump(proof, fh)
        fh.close()
        return fh.name

    def _run(self, args):
        return subprocess.run(
            [sys.executable, str(_SRC)] + args,
            capture_output=True, text=True, timeout=60)

    def test_default_stdout_is_still_json_with_reasons(self):
        """proof.ts pipes stdout verbatim -- it must stay parseable JSON."""
        path = self._write(_sealed(cost=_UNMEASURED_COST))
        out = self._run([path, str(_ROOT)])
        parsed = json.loads(out.stdout)
        self.assertEqual(out.returncode, 1)
        self.assertFalse(parsed["ok"])
        self.assertTrue(parsed["reasons"])

    def test_human_flag_does_not_shift_repo_dir(self):
        """--human must be stripped before positional parsing."""
        path = self._write(_sealed(cost=_UNMEASURED_COST))
        flagged = self._run(["--human", path, str(_ROOT)])
        self.assertEqual(flagged.returncode, 1)
        self.assertIn("FAILED", flagged.stdout)
        self.assertNotIn("{", flagged.stdout)


if __name__ == "__main__":
    unittest.main()
