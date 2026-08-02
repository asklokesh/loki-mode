"""A delta against an unmeasured value must not become a number.

tools/receipt-diff.py answers the question a single receipt cannot: did this
change make the run cheaper? That answer is worthless -- worse than absent --
if it can invent a saving out of a run that was never measured. "-$0.42"
against an unmeasured baseline is a fabricated number wearing a receipt's
authority.

The symmetric failure is asserted too. A guard strict enough to blank a
genuine, measured "identical cost" finding would make real regressions
invisible, and 0 is falsy, so a lazy `if not delta` does exactly that. Both
directions, or the honesty rule only looks enforced.

Fixtures carry REAL integrity hashes, stamped with the generator's own
canonical form, because a fixture that fails verification would let every
test here pass for the wrong reason.
"""

import importlib.util
import json
import hashlib
import pathlib
import subprocess
import sys
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"
_TOOL = _ROOT / "tools" / "receipt-diff.py"

_spec = importlib.util.spec_from_file_location("receipt_diff", _TOOL)
_rd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rd)

_pvspec = importlib.util.spec_from_file_location(
    "proof_verify_t", _LIB / "proof-verify.py")
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


def receipt(usd=1.0, cache_read=9000, fresh=1000, iterations=3,
            duration=600, gates=(("tests", "passed"),), spec="./prd.md",
            measured=True):
    cost = {
        "usd": usd, "input_tokens": fresh, "output_tokens": 500,
        "cache_read_tokens": cache_read, "cache_creation_tokens": 0,
        "available": True,
    }
    if not measured:
        # The honest unmeasured shape: no numbers, available false. Verified
        # coherent by proof-verify's cost check, so it is refused for being
        # UNMEASURED here, never for being malformed.
        cost = {
            "usd": None, "input_tokens": None, "output_tokens": None,
            "cache_read_tokens": None, "cache_creation_tokens": None,
            "available": False,
        }
    return _stamp({
        "schema_version": "1.1",
        "run_id": "run-test",
        "spec": {"source": spec, "brief": "test"},
        "iterations": {"count": iterations, "succeeded": iterations,
                       "failed": 0},
        "wall_clock_sec": duration,
        "cost": cost,
        "facts": {
            "quality_gates": [
                {"name": n, "status": s} for n, s in gates
            ],
        },
    })


class RealDelta(unittest.TestCase):
    def test_cost_and_ratio_deltas_compute(self):
        a = receipt(usd=10.0, cache_read=5000, fresh=5000)
        b = receipt(usd=4.0, cache_read=9000, fresh=1000)
        d = _rd.compare(a, b)
        self.assertAlmostEqual(d["cost_usd"]["delta"], -6.0)
        # 0.5 -> 0.9 hit ratio, the metric that dominates the cost move.
        self.assertAlmostEqual(d["cache_hit_ratio"]["a"], 0.5)
        self.assertAlmostEqual(d["cache_hit_ratio"]["b"], 0.9)
        self.assertAlmostEqual(d["cache_hit_ratio"]["delta"], 0.4)

    def test_iteration_and_duration_deltas(self):
        d = _rd.compare(receipt(iterations=5, duration=900),
                        receipt(iterations=2, duration=300))
        self.assertEqual(d["iterations"]["delta"], -3)
        self.assertEqual(d["duration_sec"]["delta"], -600)

    def test_gate_changes_are_directional(self):
        a = receipt(gates=(("tests", "passed"), ("lint", "failed")))
        b = receipt(gates=(("tests", "failed"), ("lint", "passed"),
                           ("security", "passed")))
        g = _rd.compare(a, b)["gates"]
        self.assertEqual(g["regressed"],
                         [{"gate": "tests", "from": "passed", "to": "failed"}])
        self.assertEqual(g["fixed"],
                         [{"gate": "lint", "from": "failed", "to": "passed"}])
        # Present only in B: added, NOT a pass that broke.
        self.assertEqual(g["added"],
                         [{"gate": "security", "status": "passed"}])


class UnmeasuredIsUnknown(unittest.TestCase):
    """The rule this file exists for."""

    def test_measured_vs_unmeasured_cost_is_unknown_not_a_number(self):
        d = _rd.compare(receipt(usd=10.0), receipt(measured=False))
        self.assertEqual(d["cost_usd"]["delta"], _rd.UNKNOWN)
        self.assertNotIsInstance(d["cost_usd"]["delta"], (int, float))

    def test_unmeasured_vs_measured_is_also_unknown(self):
        d = _rd.compare(receipt(measured=False), receipt(usd=10.0))
        self.assertEqual(d["cost_usd"]["delta"], _rd.UNKNOWN)

    def test_all_zero_tokens_is_unmeasured_not_free(self):
        # An all-zero cost block: every value present, every value zero. The
        # v8.52.0 defect wore available=true, and verify_integrity now rejects
        # THAT shape outright (asserted below). This is the coherent variant
        # that still reaches us, and it is a failure to measure -- not a free
        # run -- so the delta must be UNKNOWN.
        a = receipt(usd=10.0)
        b = receipt(usd=0, cache_read=0, fresh=0)
        b["cost"]["output_tokens"] = 0
        b["cost"]["available"] = False
        _stamp(b)
        d = _rd.compare(a, b)
        self.assertEqual(d["cost_usd"]["delta"], _rd.UNKNOWN,
                         "an all-zero cost block is unmeasured, not $0.00")

    def test_v8_52_0_lying_available_flag_is_refused_upstream(self):
        # Defence in depth: the exact shipped defect (available=true over an
        # all-zero block) never even reaches the diff, because verify_integrity
        # scores it incoherent. Locks in that we run integrity FIRST.
        b = receipt(usd=0, cache_read=0, fresh=0)
        b["cost"]["output_tokens"] = 0
        b["cost"]["available"] = True
        _stamp(b)
        with self.assertRaises(_rd.NotComparable) as cm:
            _rd.compare(receipt(usd=10.0), b)
        self.assertIn("incoherent", str(cm.exception))

    def test_unknown_fields_explain_themselves(self):
        d = _rd.compare(receipt(usd=10.0), receipt(measured=False))
        fields = {i["field"] for i in d["not_comparable"]}
        self.assertIn("cost", fields)
        for item in d["not_comparable"]:
            self.assertTrue(item["why"].strip(), "every UNKNOWN needs a reason")

    def test_zero_denominator_ratio_is_unknown_not_zero_percent(self):
        a = receipt(cache_read=0, fresh=0, usd=5.0)
        b = receipt(cache_read=0, fresh=0, usd=5.0)
        d = _rd.compare(a, b)
        self.assertEqual(d["cache_hit_ratio"]["delta"], _rd.UNKNOWN)


class MeasuredZeroStaysZero(unittest.TestCase):
    """0 is falsy. A real zero delta is a finding, not an absence."""

    def test_identical_measured_cost_is_zero_not_unknown(self):
        d = _rd.compare(receipt(usd=4.25), receipt(usd=4.25))
        self.assertEqual(d["cost_usd"]["delta"], 0)
        self.assertIsInstance(d["cost_usd"]["delta"], (int, float))

    def test_zero_iteration_and_duration_delta(self):
        d = _rd.compare(receipt(iterations=3, duration=600),
                        receipt(iterations=3, duration=600))
        self.assertEqual(d["iterations"]["delta"], 0)
        self.assertEqual(d["duration_sec"]["delta"], 0)
        self.assertEqual(d["cache_hit_ratio"]["delta"], 0)

    def test_genuine_zero_cost_on_both_sides_is_comparable(self):
        # usd 0.0 but tokens present: measured, and genuinely free.
        a = receipt(usd=0.0, cache_read=100, fresh=100)
        b = receipt(usd=0.0, cache_read=100, fresh=100)
        d = _rd.compare(a, b)
        self.assertEqual(d["cost_usd"]["delta"], 0)

    def test_delta_helper_directly(self):
        self.assertEqual(_rd.delta(0, 0), 0)
        self.assertEqual(_rd.delta(0.0, 5.0), 5.0)
        self.assertEqual(_rd.delta(None, 0), _rd.UNKNOWN)
        self.assertEqual(_rd.delta(0, None), _rd.UNKNOWN)


class Refusals(unittest.TestCase):
    def test_different_specs_are_refused(self):
        a = receipt(spec="./landing-page.md", usd=1.0)
        b = receipt(spec="./compiler.md", usd=9.0)
        with self.assertRaises(_rd.NotComparable) as cm:
            _rd.compare(a, b)
        self.assertIn("different specs", str(cm.exception))

    def test_tampered_receipt_is_refused(self):
        a = receipt(usd=10.0)
        b = receipt(usd=10.0)
        b["cost"]["usd"] = 0.01  # edited AFTER the hash was stamped
        with self.assertRaises(_rd.NotComparable) as cm:
            _rd.compare(a, b)
        self.assertIn("integrity", str(cm.exception))

    def test_receipt_with_no_hash_is_refused(self):
        b = receipt(usd=1.0)
        b.pop("verification")
        with self.assertRaises(_rd.NotComparable):
            _rd.compare(receipt(usd=1.0), b)


class Cli(unittest.TestCase):
    def _write(self, tmp, name, proof):
        p = pathlib.Path(tmp) / name
        p.write_text(json.dumps(proof))
        return str(p)

    def test_json_output_and_exit_codes(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            a = self._write(tmp, "a.json", receipt(usd=10.0))
            b = self._write(tmp, "b.json", receipt(usd=4.0))
            r = subprocess.run(
                [sys.executable, str(_TOOL), a, b, "--json"],
                capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertAlmostEqual(
                json.loads(r.stdout)["cost_usd"]["delta"], -6.0)

    def test_refusal_exits_nonzero_and_says_why(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            a = self._write(tmp, "a.json", receipt(spec="./one.md"))
            b = self._write(tmp, "b.json", receipt(spec="./two.md"))
            r = subprocess.run([sys.executable, str(_TOOL), a, b],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 2)
            self.assertIn("REFUSED", r.stdout)

    def test_unmeasured_renders_as_unknown_not_a_number(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            a = self._write(tmp, "a.json", receipt(usd=10.0))
            b = self._write(tmp, "b.json", receipt(measured=False))
            r = subprocess.run([sys.executable, str(_TOOL), a, b],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("UNKNOWN", r.stdout)
            self.assertNotIn("$10.0000", r.stdout.split("cost")[-1][:60])


if __name__ == "__main__":
    unittest.main()
