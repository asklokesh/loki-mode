"""A baseline you cannot verify is worse than no baseline at all.

cost-guard.py will happily compare a run against any --baseline file handed to
it. baseline-pin.py is what decides WHICH file that is, so it is the last place
an unverifiable or unmeasured run can be stopped from becoming the number every
future PR is measured against. Once pinned, a bad baseline is invisible: every
comparison against it still renders as a confident percentage.

Four properties, each asserted here:

  1. An unverifiable receipt is REFUSED, and named as an integrity failure.
  2. An unmeasured receipt is REFUSED, and named as a measurement failure --
     a different message, because the operator's next move is different.
  3. A receipt edited AFTER pinning is detected by re-hashing, and `path`
     refuses to emit it. Silently emitting it would poison every downstream
     comparison while still looking green.
  4. No pin exits non-zero. An empty success would read as "baseline fine".

The fixtures carry genuine integrity hashes (same _stamp() discipline as
tests/test_receipt_diff.py), so a refusal in test 1 can only come from the
tampering, never from a fixture that was never valid to begin with.
"""

import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"
_TOOL = _ROOT / "tools" / "baseline-pin.py"

_pvspec = importlib.util.spec_from_file_location(
    "proof_verify_bp", _LIB / "proof-verify.py")
_pv = importlib.util.module_from_spec(_pvspec)
_pvspec.loader.exec_module(_pv)


def _stamp(proof):
    """Give a receipt a genuine integrity hash, the way the generator does."""
    unsigned = dict(proof)
    unsigned.pop("verification", None)
    proof["verification"] = {
        "hash": hashlib.sha256(
            _pv._canonical(unsigned).encode("utf-8")).hexdigest(),
        "algo": "sha256",
        "scope": "integrity",
    }
    return proof


def receipt(usd=1.25, measured=True):
    cost = {
        "usd": usd, "input_tokens": 1000, "output_tokens": 500,
        "cache_read_tokens": 9000, "cache_creation_tokens": 0,
        "available": True,
    }
    if not measured:
        # The honest unmeasured shape: no numbers, available false. Coherent
        # to the verifier, so it is refused for being UNMEASURED, never for
        # being malformed.
        cost = {
            "usd": None, "input_tokens": None, "output_tokens": None,
            "cache_read_tokens": None, "cache_creation_tokens": None,
            "available": False,
        }
    return _stamp({
        "schema_version": "1.1",
        "run_id": "run-test",
        "spec": {"source": "./prd.md", "brief": "test"},
        "iterations": {"count": 3, "succeeded": 3, "failed": 0},
        "wall_clock_sec": 600,
        "cost": cost,
        "facts": {"quality_gates": [{"name": "tests", "status": "passed"}]},
    })


def workspace(proof):
    """A workspace whose .loki/proofs/<id>/proof.json holds `proof`."""
    root = pathlib.Path(tempfile.mkdtemp())
    d = root / ".loki" / "proofs" / "run-test"
    d.mkdir(parents=True)
    (d / "proof.json").write_text(json.dumps(proof, indent=2),
                                  encoding="utf-8")
    return root


def run(*args):
    return subprocess.run([sys.executable, str(_TOOL)] + list(args),
                          capture_output=True, text=True, timeout=60)


class RoundTrip(unittest.TestCase):
    def test_set_then_show_reports_what_was_pinned(self):
        ws = workspace(receipt(usd=1.25))
        pin = pathlib.Path(tempfile.mkdtemp()) / "baseline.json"

        s = run("set", str(ws), "--file", str(pin))
        self.assertEqual(s.returncode, 0, s.stderr)

        # REQUIREMENT: the pin records WHAT it pinned, not only a path.
        rec = json.loads(pin.read_text(encoding="utf-8"))
        self.assertEqual(rec["cost_usd"], 1.25)
        self.assertTrue(rec["receipt_sha256"])
        self.assertTrue(rec["pinned_at"])
        self.assertTrue(rec["proof_path"].endswith("proof.json"))

        sh = run("show", "--file", str(pin), "--json")
        self.assertEqual(sh.returncode, 0, sh.stderr)
        out = json.loads(sh.stdout)
        self.assertEqual(out["state"], "intact")
        self.assertEqual(out["cost_usd"], 1.25)


class RefusesToPinWhatCannotBeTrusted(unittest.TestCase):
    def test_refuses_an_unverifiable_receipt(self):
        """A tampered receipt must never become the baseline."""
        ws = workspace(receipt(usd=1.25))
        proof = ws / ".loki" / "proofs" / "run-test" / "proof.json"
        doc = json.loads(proof.read_text(encoding="utf-8"))
        # Edited after hashing: the recorded verification.hash no longer
        # matches the bytes. Exactly the shape verify_integrity exists to see.
        doc["cost"]["usd"] = 0.01
        proof.write_text(json.dumps(doc, indent=2), encoding="utf-8")

        pin = pathlib.Path(tempfile.mkdtemp()) / "baseline.json"
        r = run("set", str(ws), "--file", str(pin))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        # Named as an INTEGRITY failure specifically, not a generic refusal:
        # the operator's next move differs from the unmeasured case.
        self.assertIn("integrity", r.stderr.lower())
        self.assertFalse(pin.exists(), "refused pin must not be written")

    def test_refuses_an_unmeasured_receipt(self):
        """No measured cost means every later percentage is undefined."""
        ws = workspace(receipt(measured=False))
        pin = pathlib.Path(tempfile.mkdtemp()) / "baseline.json"
        r = run("set", str(ws), "--file", str(pin))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("no measured cost", r.stderr.lower())
        # A DIFFERENT diagnosis from the integrity case, so the two refusals
        # cannot be collapsed into one unusable-baseline string.
        self.assertNotIn("integrity", r.stderr.lower())
        self.assertFalse(pin.exists())


class DetectsDriftAfterPinning(unittest.TestCase):
    def test_show_reports_a_receipt_changed_since_pinning(self):
        ws = workspace(receipt(usd=1.25))
        pin = pathlib.Path(tempfile.mkdtemp()) / "baseline.json"
        self.assertEqual(run("set", str(ws), "--file", str(pin)).returncode, 0)

        proof = ws / ".loki" / "proofs" / "run-test" / "proof.json"
        doc = json.loads(proof.read_text(encoding="utf-8"))
        doc["cost"]["usd"] = 99.0
        proof.write_text(json.dumps(doc, indent=2), encoding="utf-8")

        sh = run("show", "--file", str(pin), "--json")
        self.assertEqual(sh.returncode, 1, sh.stdout)
        self.assertEqual(json.loads(sh.stdout)["state"], "changed")
        self.assertIn("CHANGED", sh.stderr)

    def test_an_edit_confined_to_the_verification_block_is_still_a_change(self):
        """The pin hashes RAW BYTES, not the canonical verification-stripped
        digest the receipt hashes itself with. That digest is blind to any
        edit inside verification -- swap the whole block and it is identical.
        """
        ws = workspace(receipt(usd=1.25))
        pin = pathlib.Path(tempfile.mkdtemp()) / "baseline.json"
        self.assertEqual(run("set", str(ws), "--file", str(pin)).returncode, 0)

        proof = ws / ".loki" / "proofs" / "run-test" / "proof.json"
        doc = json.loads(proof.read_text(encoding="utf-8"))
        doc["verification"]["signature"] = "forged"
        proof.write_text(json.dumps(doc, indent=2), encoding="utf-8")

        sh = run("show", "--file", str(pin), "--json")
        self.assertEqual(sh.returncode, 1, sh.stdout)
        self.assertEqual(json.loads(sh.stdout)["state"], "changed")


class NoPinIsNotSuccess(unittest.TestCase):
    def test_show_without_a_pin_exits_non_zero(self):
        missing = pathlib.Path(tempfile.mkdtemp()) / "nope.json"
        r = run("show", "--file", str(missing))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no baseline", r.stderr.lower())
        self.assertEqual(r.stdout.strip(), "")

    def test_path_without_a_pin_exits_non_zero(self):
        missing = pathlib.Path(tempfile.mkdtemp()) / "nope.json"
        r = run("path", "--file", str(missing))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")


class PathComposes(unittest.TestCase):
    def test_path_prints_only_the_path_with_diagnostics_on_stderr(self):
        ws = workspace(receipt(usd=1.25))
        pin = pathlib.Path(tempfile.mkdtemp()) / "baseline.json"
        s = run("set", str(ws), "--file", str(pin))
        self.assertEqual(s.returncode, 0, s.stderr)
        # The `set` diagnostic went to stderr, never stdout.
        self.assertTrue(s.stderr.strip())
        self.assertEqual(s.stdout, "")

        expected = json.loads(pin.read_text(encoding="utf-8"))["proof_path"]
        p = run("path", "--file", str(pin))
        self.assertEqual(p.returncode, 0, p.stderr)
        # BARE path, nothing else: this is substituted into
        # cost-guard.py --baseline "$(...)".
        self.assertEqual(p.stdout, expected + "\n")

    def test_path_refuses_to_emit_a_drifted_baseline(self):
        """A drifted baseline composed into --baseline silently poisons the
        comparison while still looking like a green gate."""
        ws = workspace(receipt(usd=1.25))
        pin = pathlib.Path(tempfile.mkdtemp()) / "baseline.json"
        self.assertEqual(run("set", str(ws), "--file", str(pin)).returncode, 0)

        proof = ws / ".loki" / "proofs" / "run-test" / "proof.json"
        proof.write_text(proof.read_text(encoding="utf-8") + "\n",
                         encoding="utf-8")

        p = run("path", "--file", str(pin))
        self.assertEqual(p.returncode, 1)
        self.assertEqual(p.stdout, "")
        self.assertIn("CHANGED", p.stderr)


if __name__ == "__main__":
    unittest.main()
