"""The verifier must catch a receipt that claims a cost it does not have.

STRATEGIC CONTEXT. The Evidence Receipt is the product's differentiator:
`benchmarks/results/competitor-verify-surface.json` records that of six
installed coding-agent CLIs (opencode, aider, codex, claude, cursor-agent,
loki-mode), **only loki-mode verifies its own output**. That claim is the moat.

A moat with a blind spot is not a moat. The verifier checked the integrity
hash, the diff, the gates and the headline -- and never looked at cost. A
receipt could therefore assert ANY cost, $0.00 or $10,000, and
`loki proof verify` would pass it.

THE PROOF THAT THIS MATTERED. A real FireLater receipt
(.loki/proofs/run-20260801185859-431-8764/proof.json) shipped with:

    "cost": {"usd": 0.0, "input_tokens": 0, ..., "available": true}

a shareable document asserting the run was FREE. Its integrity hash was
VALID -- it passed the old verifier completely. The collector had keyed
availability on a record file existing rather than carrying data (fixed
v8.52.0), and nothing downstream could see the lie.

WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT. It checks INTERNAL
COHERENCE -- the receipt must not contradict itself. It does NOT re-price the
run: that would need the token counts and a price table at verify time, and a
verifier that guesses is worse than one that abstains. Abstention is honest;
a fabricated verdict is the thing being prevented.
"""

import importlib.util
import json
import pathlib
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_SRC = _ROOT / "autonomy" / "lib" / "proof-verify.py"

_spec = importlib.util.spec_from_file_location("proof_verify", _SRC)
_pv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pv)


def _proof(cost):
    return {"verification": {"hash": "deadbeef"}, "cost": cost,
            "facts": {}, "honesty": {}}


class CostCoherenceTests(unittest.TestCase):
    def test_available_true_with_no_data_is_incoherent(self):
        """The exact shape that shipped."""
        r = _pv.verify_integrity(_proof({
            "usd": 0.0, "input_tokens": 0, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_creation_tokens": 0,
            "available": True,
        }))
        self.assertFalse(
            r["cost_coherent"],
            "a receipt claiming available=True with zero everything passed; "
            "that document asserts the run was free")
        # NOT asserted on `reason`: it reports the FIRST failure, and these
        # synthetic fixtures carry a placeholder hash, so the hash mismatch
        # wins. The verdict is the contract; the message ordering is not.

    def test_honest_unknown_passes(self):
        """The post-v8.52.0 shape. Abstaining must not be penalised."""
        r = _pv.verify_integrity(_proof({
            "usd": None, "input_tokens": None, "output_tokens": None,
            "cache_read_tokens": None, "cache_creation_tokens": None,
            "available": False,
        }))
        self.assertTrue(r["cost_coherent"], "an honest 'unknown' was rejected")

    def test_real_measured_run_passes(self):
        """A genuine measurement must not be flagged."""
        r = _pv.verify_integrity(_proof({
            "usd": 0.0187, "input_tokens": 9412, "output_tokens": 23,
            "cache_read_tokens": 11008, "cache_creation_tokens": 0,
            "available": True,
        }))
        self.assertTrue(r["cost_coherent"], "a real measured run was flagged")

    def test_cost_from_nowhere_is_incoherent(self):
        """The inflation direction. Under-reporting is not the only lie."""
        r = _pv.verify_integrity(_proof({
            "usd": 99.0, "input_tokens": 0, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_creation_tokens": 0,
            "available": True,
        }))
        self.assertFalse(
            r["cost_coherent"],
            "a cost with no token basis passed -- a receipt could inflate spend")

    def test_available_false_with_a_number_is_incoherent(self):
        r = _pv.verify_integrity(_proof({
            "usd": 5.0, "input_tokens": 100, "output_tokens": 10,
            "cache_read_tokens": 0, "cache_creation_tokens": 0,
            "available": False,
        }))
        self.assertFalse(r["cost_coherent"])

    def test_absent_cost_block_is_not_a_failure(self):
        """Older receipts predate the cost block; they are not forgeries."""
        p = {"verification": {"hash": "x"}, "facts": {}, "honesty": {}}
        r = _pv.verify_integrity(p)
        self.assertIsNone(
            r["cost_coherent"],
            "a receipt with no cost block must abstain, not fail")

    def test_incoherent_cost_fails_the_overall_verdict(self):
        """WIRING: the check must actually gate `ok`.

        A check computed and never consulted is the half-shipped pattern this
        codebase has paid for repeatedly.
        """
        # The hash must be VALID, or this test passes for the wrong reason.
        # With the default "deadbeef" placeholder, hash_ok is already False, so
        # `ok` is False no matter what the cost gate does -- and deleting the
        # cost line from the `ok` computation left this test GREEN. A
        # mutation probe caught that: the wiring assertion was blind.
        import hashlib as _h
        p = {"cost": {"usd": 0.0, "input_tokens": 0, "output_tokens": 0,
                      "cache_read_tokens": 0, "cache_creation_tokens": 0,
                      "available": True},
             "facts": {}, "honesty": {}}
        digest = _h.sha256(_pv._canonical(p).encode("utf-8")).hexdigest()
        p["verification"] = {"hash": digest}

        r = _pv.verify_integrity(p)
        self.assertTrue(
            r["hash_ok"],
            "the fixture's hash is invalid, so this test cannot isolate the "
            "cost gate: `ok` would be False for the hash alone")
        self.assertFalse(r["cost_coherent"])
        self.assertFalse(r["ok"], "cost_coherent=False did not fail `ok`")


class RealShippedReceiptTest(unittest.TestCase):
    """Replay the actual receipt that motivated this.

    Unit cases prove the rule; the recorded artifact proves the case. This
    receipt's integrity hash is VALID -- it passed the old verifier entirely.
    """

    PATH = pathlib.Path.home() / "git" / "FireLater" / ".loki" / "proofs" / \
        "run-20260801185859-431-8764" / "proof.json"

    def test_the_shipped_receipt_is_now_caught(self):
        if not self.PATH.exists():
            self.skipTest("the motivating receipt is not on this machine")
        proof = json.loads(self.PATH.read_text(encoding="utf-8"))
        r = _pv.verify_integrity(proof)
        self.assertTrue(
            r["hash_ok"],
            "precondition: this receipt's hash is valid, which is why the old "
            "verifier passed it")
        self.assertFalse(
            r["cost_coherent"],
            "the real shipped receipt still passes the cost check")
        self.assertFalse(r["ok"], "a receipt asserting a false cost verified ok")


if __name__ == "__main__":
    unittest.main()
