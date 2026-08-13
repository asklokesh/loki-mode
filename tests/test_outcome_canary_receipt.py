import hashlib
import importlib.util
import json
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).parents[1]
TOOL = ROOT / "tools/outcome-canary-receipt.py"
spec = importlib.util.spec_from_file_location("outcome_canary_receipt", TOOL)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class TestOutcomeCanaryReceipt(unittest.TestCase):
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
                {"route": "fast", "trials": 5, "mean_risk": .1, "eligible": True, "refusal_reasons": []},
                {"route": "safe", "trials": 5, "mean_risk": .1, "eligible": True, "refusal_reasons": []},
            ],
        }
        self.report.write_text(json.dumps(report, sort_keys=True))
        self.observations = self.root / "observations.json"
        evaluator = mod._load_tool("outcome-canary-evaluate.py", "test_receipt_evaluator")
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
        body = {
            "observations": evaluator.OBSERVATIONS,
            "report_sha256": hashlib.sha256(self.report.read_bytes()).hexdigest(),
            "source_sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "items": arms["control"] + arms["canary"],
        }
        self.observations.write_text(json.dumps(body, sort_keys=True))
        self.receipt = self.root / "decision-receipt.json"

    def tearDown(self):
        self.temp.cleanup()

    def create(self, **kwargs):
        kwargs.setdefault("enable_receipt", True)
        kwargs.setdefault("canary_percent", 50)
        kwargs.setdefault("min_samples", 4)
        return mod.create_receipt(
            str(self.report), str(self.observations), str(self.receipt), "safe", **kwargs
        )

    def test_creates_canonical_portable_bound_receipt(self):
        result = self.create()
        self.assertEqual(result["status"], "RECORDED")
        self.assertEqual(result["verdict"], "PROMOTE")
        payload = self.receipt.read_bytes()
        self.assertEqual(result["receipt_sha256"], hashlib.sha256(payload).hexdigest())
        body = json.loads(payload)
        self.assertEqual(body["receipt"], mod.DOMAIN)
        self.assertEqual(body["verdict"], "PROMOTE")
        self.assertEqual(body["policy"]["control_route"], "safe")
        self.assertEqual(body["policy"]["canary_route"], "fast")
        self.assertEqual(body["control"]["trials"], 4)
        self.assertEqual(stat.S_IMODE(self.receipt.stat().st_mode), 0o600)
        serialized = payload.decode()
        self.assertNotIn("private-subject", serialized)
        self.assertNotIn(str(self.root), serialized)
        self.assertNotIn("source", body)

    def test_requires_opt_in_and_refuses_existing_or_symlink_target(self):
        self.assertEqual(self.create(enable_receipt=False)["refusal_reason"], "receipt_not_enabled")
        self.assertFalse(self.receipt.exists())
        self.receipt.write_text("keep")
        self.assertEqual(self.create()["refusal_reason"], "target_exists")
        self.assertEqual(self.receipt.read_text(), "keep")
        self.receipt.unlink()
        target = self.root / "elsewhere"
        target.write_text("keep")
        self.receipt.symlink_to(target)
        self.assertEqual(self.create()["refusal_reason"], "target_exists")
        self.assertEqual(target.read_text(), "keep")

    def test_records_hold_and_rollback_verdicts(self):
        body = json.loads(self.observations.read_text())
        for item in body["items"]:
            item["accepted"] = True
        self.observations.write_text(json.dumps(body, sort_keys=True))
        self.assertEqual(self.create()["verdict"], "HOLD")
        self.receipt.unlink()
        for item in body["items"]:
            item["accepted"] = item["assignment"] == "control"
        self.observations.write_text(json.dumps(body, sort_keys=True))
        self.assertEqual(self.create()["verdict"], "ROLLBACK")

    def test_refuses_sparse_evidence_without_writing(self):
        body = json.loads(self.observations.read_text())
        body["items"] = body["items"][:2]
        self.observations.write_text(json.dumps(body))
        self.assertEqual(self.create()["refusal_reason"], "evaluation_refused")
        self.assertFalse(self.receipt.exists())

    def test_refuses_source_drift_without_writing(self):
        self.source.write_text("drifted")
        self.assertEqual(self.create()["refusal_reason"], "evaluation_refused")
        self.assertFalse(self.receipt.exists())

    def test_refuses_symlinked_inputs_and_concurrent_target_creation(self):
        linked = self.root / "linked-observations.json"
        linked.symlink_to(self.observations)
        result = mod.create_receipt(
            str(self.report), str(linked), str(self.receipt), "safe",
            canary_percent=50, min_samples=4, enable_receipt=True,
        )
        self.assertEqual(result["refusal_reason"], "evaluation_refused")
        original_publish = mod._publish_create_only

        def race(path, payload):
            pathlib.Path(path).write_text("racer")
            return original_publish(path, payload)

        with mock.patch.object(mod, "_publish_create_only", side_effect=race):
            raced = self.create()
        self.assertEqual(raced["refusal_reason"], "target_exists")
        self.assertEqual(self.receipt.read_text(), "racer")

    def test_cli_privacy_exit_and_help_contract(self):
        base = [
            sys.executable, str(TOOL), str(self.report), str(self.observations),
            str(self.receipt), "--control-route", "safe", "--canary-percent", "50",
            "--min-samples", "4", "--json",
        ]
        refused = subprocess.run(base, capture_output=True, text=True)
        self.assertEqual(refused.returncode, mod.REFUSED)
        recorded = subprocess.run(base + ["--enable-receipt"], capture_output=True, text=True)
        self.assertEqual(recorded.returncode, mod.OK)
        output = json.loads(recorded.stdout)
        self.assertEqual(output["status"], "RECORDED")
        self.assertNotIn(str(self.root), recorded.stdout)
        self.assertNotIn("private-subject", recorded.stdout)
        help_result = subprocess.run([sys.executable, str(TOOL), "--help"], capture_output=True, text=True)
        self.assertEqual(help_result.returncode, 0)
        self.assertIn("--enable-receipt", help_result.stdout)

    def test_cli_requires_exact_verdict_before_publishing(self):
        base = [
            sys.executable, str(TOOL), str(self.report), str(self.observations),
            str(self.receipt), "--control-route", "safe", "--canary-percent", "50",
            "--min-samples", "4", "--enable-receipt", "--json",
        ]
        mismatch = subprocess.run(
            base + ["--require-verdict", "ROLLBACK"],
            capture_output=True, text=True,
        )
        self.assertEqual(mismatch.returncode, mod.REFUSED)
        mismatch_result = json.loads(mismatch.stdout)
        self.assertEqual(mismatch_result["status"], "REFUSED")
        self.assertEqual(mismatch_result["verdict"], "PROMOTE")
        self.assertEqual(mismatch_result["required_verdict"], "ROLLBACK")
        self.assertIs(mismatch_result["requirement_met"], False)
        self.assertEqual(mismatch_result["refusal_reason"], "verdict_mismatch")
        self.assertFalse(self.receipt.exists())

        matched = subprocess.run(
            base + ["--require-verdict", "PROMOTE"],
            capture_output=True, text=True,
        )
        self.assertEqual(matched.returncode, mod.OK)
        matched_result = json.loads(matched.stdout)
        self.assertEqual(matched_result["status"], "RECORDED")
        self.assertEqual(matched_result["verdict"], "PROMOTE")
        self.assertEqual(matched_result["required_verdict"], "PROMOTE")
        self.assertIs(matched_result["requirement_met"], True)
        self.assertTrue(self.receipt.exists())

        invalid = subprocess.run(
            base + ["--require-verdict", "promote"],
            capture_output=True, text=True,
        )
        self.assertEqual(invalid.returncode, mod.USAGE)

    def test_cli_human_mismatch_reports_actual_verdict_without_writing(self):
        result = subprocess.run([
            sys.executable, str(TOOL), str(self.report), str(self.observations),
            str(self.receipt), "--control-route", "safe", "--canary-percent", "50",
            "--min-samples", "4", "--enable-receipt",
            "--require-verdict", "ROLLBACK",
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, mod.REFUSED)
        self.assertIn("REFUSED (verdict_mismatch)", result.stdout)
        self.assertIn("actual verdict: PROMOTE", result.stdout)
        self.assertIn("required verdict: ROLLBACK (NOT MET)", result.stdout)
        self.assertFalse(self.receipt.exists())


if __name__ == "__main__":
    unittest.main()
