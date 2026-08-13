import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parents[1]
TOOL = ROOT / "tools/outcome-canary-receipt-verify.py"
CREATOR = ROOT / "tools/outcome-canary-receipt.py"
spec = importlib.util.spec_from_file_location("outcome_canary_receipt_verify", TOOL)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
creator_spec = importlib.util.spec_from_file_location("receipt_creator_for_verify", CREATOR)
creator = importlib.util.module_from_spec(creator_spec)
creator_spec.loader.exec_module(creator)


class TestOutcomeCanaryReceiptVerify(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / "trials.jsonl"
        self.source.write_text("measured trials\n")
        self.report = self.root / "report.json"
        report = {
            "report": "loki-outcome-router/v1",
            "source": str(self.source),
            "source_sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "selected_route": "fast",
            "invalid_observations": [],
            "candidates": [
                {"route": "fast", "trials": 5, "mean_risk": .1,
                 "eligible": True, "refusal_reasons": []},
                {"route": "safe", "trials": 5, "mean_risk": .1,
                 "eligible": True, "refusal_reasons": []},
            ],
        }
        self.report.write_text(json.dumps(report, sort_keys=True))
        evaluator = creator._load_tool(
            "outcome-canary-evaluate.py", "test_receipt_verify_evaluator"
        )
        planner = evaluator._load_planner()
        arms = {"control": [], "canary": []}
        index = 0
        while min(map(len, arms.values())) < 4:
            subject = f"private-subject-{index}"
            plan = planner.plan(str(self.report), subject, "safe", 50, .25, True)
            arm = plan["assignment"]
            if len(arms[arm]) < 4:
                arms[arm].append({
                    "subject": subject,
                    "assignment": arm,
                    "route": plan["route"],
                    "accepted": arm == "canary",
                    "risk": .05 if arm == "canary" else .1,
                })
            index += 1
        self.observations = self.root / "observations.json"
        self.observations.write_text(json.dumps({
            "observations": evaluator.OBSERVATIONS,
            "report_sha256": hashlib.sha256(self.report.read_bytes()).hexdigest(),
            "source_sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "items": arms["control"] + arms["canary"],
        }, sort_keys=True))
        self.receipt = self.root / "receipt.json"
        made = creator.create_receipt(
            str(self.report), str(self.observations), str(self.receipt), "safe",
            canary_percent=50, min_samples=4, enable_receipt=True,
        )
        self.assertEqual(made["status"], "RECORDED")

    def tearDown(self):
        self.temp.cleanup()

    def verify(self, enabled=True):
        return mod.verify_receipt(
            str(self.report), str(self.observations), str(self.receipt), enabled
        )

    def test_verifies_exact_rederived_receipt_without_writes(self):
        before = {path.name: path.read_bytes() for path in self.root.iterdir()}
        result = self.verify()
        after = {path.name: path.read_bytes() for path in self.root.iterdir()}
        self.assertEqual(result["status"], "VERIFIED")
        self.assertEqual(result["verdict"], "PROMOTE")
        self.assertEqual(result["receipt_sha256"], hashlib.sha256(
            self.receipt.read_bytes()).hexdigest())
        self.assertEqual(after, before)

    def test_requires_explicit_verification(self):
        self.assertEqual(
            self.verify(False)["refusal_reason"], "verification_not_enabled"
        )

    def test_refuses_receipt_or_policy_substitution(self):
        body = json.loads(self.receipt.read_text())
        body["verdict"] = "ROLLBACK"
        self.receipt.write_text(json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n")
        self.assertEqual(self.verify()["refusal_reason"], "receipt_mismatch")
        body["verdict"] = "PROMOTE"
        body["policy"]["canary_route"] = "substituted"
        self.receipt.write_text(json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n")
        self.assertEqual(self.verify()["refusal_reason"], "receipt_mismatch")

    def test_refuses_report_observation_and_source_drift(self):
        original = self.report.read_text()
        self.report.write_text(original + " ")
        self.assertEqual(self.verify()["refusal_reason"], "evaluation_refused")
        self.report.write_text(original)
        original = self.observations.read_text()
        self.observations.write_text(original + " ")
        self.assertEqual(self.verify()["refusal_reason"], "receipt_mismatch")
        self.observations.write_text(original)
        sparse = json.loads(original)
        sparse["items"] = sparse["items"][:2]
        self.observations.write_text(json.dumps(sparse, sort_keys=True))
        self.assertEqual(self.verify()["refusal_reason"], "evaluation_refused")
        self.observations.write_text(original)
        self.source.write_text("drifted\n")
        self.assertEqual(self.verify()["refusal_reason"], "evaluation_refused")

    def test_refuses_noncanonical_duplicate_symlink_and_sparse_evidence(self):
        body = json.loads(self.receipt.read_text())
        self.receipt.write_text(json.dumps(body, indent=2))
        self.assertEqual(self.verify()["refusal_reason"], "receipt_noncanonical")
        self.receipt.write_text('{"receipt":"x","receipt":"y"}\n')
        self.assertEqual(self.verify()["refusal_reason"], "unsafe_or_malformed_input")
        self.receipt.unlink()
        linked = self.root / "actual-receipt.json"
        linked.write_text("{}\n")
        self.receipt.symlink_to(linked)
        self.assertEqual(self.verify()["refusal_reason"], "unsafe_or_malformed_input")

    def test_refuses_oversized_receipt(self):
        self.receipt.write_bytes(b"x" * (creator.MAX_BYTES + 1))
        self.assertEqual(self.verify()["refusal_reason"], "input_too_large")

    def test_cli_exit_privacy_missing_and_help_contract(self):
        base = [
            sys.executable, str(TOOL), str(self.report), str(self.observations),
            str(self.receipt), "--json",
        ]
        refused = subprocess.run(base, capture_output=True, text=True)
        self.assertEqual(refused.returncode, mod.REFUSED)
        passed = subprocess.run(
            base + ["--enable-verification"], capture_output=True, text=True
        )
        self.assertEqual(passed.returncode, mod.OK)
        self.assertEqual(json.loads(passed.stdout)["status"], "VERIFIED")
        self.assertNotIn(str(self.root), passed.stdout)
        self.assertNotIn("private-subject", passed.stdout)
        missing = subprocess.run(
            [sys.executable, str(TOOL), str(self.report) + ".missing",
             str(self.observations), str(self.receipt)],
            capture_output=True, text=True,
        )
        self.assertEqual(missing.returncode, mod.NO_INPUT)
        self.assertNotIn(str(self.root), missing.stderr)
        help_result = subprocess.run(
            [sys.executable, str(TOOL), "--help"], capture_output=True, text=True
        )
        self.assertEqual(help_result.returncode, 0)
        self.assertIn("--enable-verification", help_result.stdout)

    def test_cli_can_require_one_exact_verified_verdict(self):
        base = [
            sys.executable, str(TOOL), str(self.report), str(self.observations),
            str(self.receipt), "--enable-verification",
        ]
        matched = subprocess.run(
            base + ["--require-verdict", "PROMOTE", "--json"],
            capture_output=True, text=True,
        )
        self.assertEqual(matched.returncode, mod.OK)
        matched_result = json.loads(matched.stdout)
        self.assertEqual(matched_result["verdict"], "PROMOTE")
        self.assertEqual(matched_result["required_verdict"], "PROMOTE")
        self.assertIs(matched_result["requirement_met"], True)

        mismatched = subprocess.run(
            base + ["--require-verdict", "ROLLBACK", "--json"],
            capture_output=True, text=True,
        )
        self.assertEqual(mismatched.returncode, mod.REFUSED)
        mismatched_result = json.loads(mismatched.stdout)
        self.assertEqual(mismatched_result["status"], "VERIFIED")
        self.assertEqual(mismatched_result["verdict"], "PROMOTE")
        self.assertEqual(mismatched_result["required_verdict"], "ROLLBACK")
        self.assertIs(mismatched_result["requirement_met"], False)

        human = subprocess.run(
            base + ["--require-verdict", "ROLLBACK"],
            capture_output=True, text=True,
        )
        self.assertEqual(human.returncode, mod.REFUSED)
        self.assertIn("Canary decision receipt: VERIFIED (PROMOTE)", human.stdout)
        self.assertIn("required verdict: ROLLBACK (NOT MET)", human.stdout)

        refused = subprocess.run(
            [item for item in base if item != "--enable-verification"]
            + ["--require-verdict", "PROMOTE", "--json"],
            capture_output=True, text=True,
        )
        self.assertEqual(refused.returncode, mod.REFUSED)
        refused_result = json.loads(refused.stdout)
        self.assertEqual(refused_result["status"], "REFUSED")
        self.assertIs(refused_result["requirement_met"], False)

        invalid = subprocess.run(
            base + ["--require-verdict", "promote"], capture_output=True, text=True,
        )
        self.assertEqual(invalid.returncode, mod.USAGE)


if __name__ == "__main__":
    unittest.main()
