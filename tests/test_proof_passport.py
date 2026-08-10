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
        # The RESOLVED form too. These differ on macOS (/var -> /private/var),
        # and the attester embeds the UNRESOLVED string, so a redactor built
        # only from resolve() silently missed it: green on Linux, leaking on
        # every developer Mac.
        self.assertNotIn(str(self.path.resolve()), json.dumps(result))

    def test_no_absolute_user_path_of_any_kind_leaks(self):
        """No absolute home/user path may appear anywhere in a passport.

        Asserted on the CLASS of leak rather than the one temp dir the other
        test happens to use: any '/Users/<name>', '/home/<name>', '/var/folders'
        or '/private/var' substring is a machine path escaping into an artifact
        meant to be handed to a third party. The earlier assertion could only
        catch the single root it was given, which is how a resolve()-only
        redactor passed review.
        """
        result = json.dumps(pp.build_passport(self.contract, self.receipt, self.path))
        for marker in ("/Users/", "/home/", "/var/folders", "/private/var"):
            self.assertNotIn(marker, result,
                             "passport leaked an absolute path containing %r" % marker)

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

    def test_markdown_summary_is_portable_and_evidence_bound(self):
        passport = pp.build_passport(self.contract, self.receipt, self.path)
        summary = pp.render_markdown(passport)
        expected = {"VERIFIED": "PASS", "FAILED": "FAIL"}.get(
            passport["verification"]["verdict"], "UNVERIFIABLE")
        self.assertIn(
            f"**{expected}: {passport['verification']['verdict']}**", summary)
        self.assertIn(passport["contract"]["sha256"], summary)
        self.assertIn(passport["receipt"]["sha256"], summary)
        self.assertIn("| Independent verifier | `yes` |", summary)
        self.assertIn("| Passport signature | `unsigned` |", summary)
        self.assertNotIn(str(self.path), summary)
        self.assertNotIn(str(self.path.resolve()), summary)

    def test_cli_writes_markdown_summary(self):
        output = self.path / "passport.json"
        summary = self.path / "summary.md"
        run = subprocess.run([
            "python3", str(TOOL), str(self.contract), str(self.receipt),
            str(output), "--repo-dir", str(self.path),
            "--markdown-output", str(summary)], capture_output=True, text=True)
        passport = json.loads(output.read_text())
        expected_rc = {"VERIFIED": 0, "FAILED": 1, "UNVERIFIABLE": 2}[
            passport["verification"]["verdict"]]
        self.assertEqual(run.returncode, expected_rc, run.stderr)
        self.assertTrue(output.exists())
        self.assertIn(passport["verification"]["verdict"], summary.read_text())

    def test_markdown_conflict_prevents_both_outputs(self):
        output = self.path / "passport.json"
        summary = self.path / "summary.md"
        summary.write_text("keep")
        run = subprocess.run([
            "python3", str(TOOL), str(self.contract), str(self.receipt),
            str(output), "--markdown-output", str(summary)],
            capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertFalse(output.exists())
        self.assertEqual(summary.read_text(), "keep")

    def test_markdown_escapes_untrusted_contract_and_verifier_text(self):
        passport = pp.build_passport(self.contract, self.receipt, self.path)
        passport["contract"]["id"] = "`x` | injected"
        passport["verification"]["summary"] = "ok\n<script>alert(1)</script>"
        summary = pp.render_markdown(passport)
        self.assertNotIn("<script>", summary)
        self.assertNotIn("\n<script>", summary)
        self.assertNotIn("`x` | injected", summary)
        self.assertIn("&lt;script&gt;", summary)


if __name__ == "__main__":
    unittest.main()
