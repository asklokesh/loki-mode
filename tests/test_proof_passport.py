import hashlib
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "proof-passport.py"
spec = importlib.util.spec_from_file_location("proof_passport", TOOL)
pp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pp)


class ProofPassportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.tmp.name)
        self.contract = self.path / "contract.json"
        self.receipt = self.path / "proof.json"
        self.contract.write_text(json.dumps({
            "schema": "autonomi-outcome-contract/v0.1", "id": "x",
            "intent": "Resolve issue", "acceptance": ["Tests pass"],
            "executor": {"id": "codex", "kind": "agent"},
            "verifier": {"id": "autonomi-verify", "kind": "service"}}))
        source = ROOT / "skills" / "fixtures" / "demo-receipt" / "proof.json"
        self.receipt.write_bytes(source.read_bytes())

    def tearDown(self):
        self.tmp.cleanup()

    def test_binds_exact_receipt_and_discloses_unsigned_limit(self):
        result = pp.build_passport(self.contract, self.receipt, self.path)
        self.assertEqual(result["receipt"]["sha256"],
                         hashlib.sha256(self.receipt.read_bytes()).hexdigest())
        self.assertTrue(result["parties"]["independent"])
        self.assertEqual(result["passport_signature"]["status"], "unsigned")
        self.assertIn("receipt_signature", result["verification"])
        self.assertEqual(result["contract"]["digest"]["algorithm"], "sha256")
        self.assertIn("canonical-json", result["contract"]["digest"]["canonicalization"])
        self.assertIn("raw file bytes", result["receipt"]["digest"]["canonicalization"])
        self.assertNotIn(str(self.path), json.dumps(result))

    def test_missing_generator_trust_is_not_invented(self):
        original = pp._load_attester
        class Attester:
            @staticmethod
            def attest(*_args):
                return {"verdict": "UNVERIFIABLE", "summary": "missing",
                        "axes": {}, "signature": {"status": "unsigned"}}
        pp._load_attester = lambda: Attester
        try:
            result = pp.build_passport(self.contract, self.receipt, self.path)
        finally:
            pp._load_attester = original
        self.assertIsNone(result["verification"]["generator_trusted"])

    def test_tamper_is_failed(self):
        proof = json.loads(self.receipt.read_text())
        proof["run_id"] = "tampered"
        self.receipt.write_text(json.dumps(proof))
        result = pp.build_passport(self.contract, self.receipt, self.path)
        self.assertEqual(result["verification"]["verdict"], "FAILED")

    def test_missing_evidence_is_unverifiable(self):
        empty_digest = hashlib.sha256(b"{}").hexdigest()
        self.receipt.write_text(json.dumps({"verification": {"hash": empty_digest}}))
        result = pp.build_passport(self.contract, self.receipt, self.path)
        self.assertEqual(result["verification"]["verdict"], "UNVERIFIABLE")

    def test_refuses_overwrite_without_force(self):
        output = self.path / "passport.json"
        output.write_text("keep")
        run = subprocess.run(["python3", str(TOOL), str(self.contract),
                              str(self.receipt), str(output)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertEqual(output.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
