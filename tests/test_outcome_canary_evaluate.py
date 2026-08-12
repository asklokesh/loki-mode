import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parents[1]
TOOL = ROOT / "tools/outcome-canary-evaluate.py"
spec = importlib.util.spec_from_file_location("outcome_canary_evaluate", TOOL)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class TestOutcomeCanaryEvaluate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / "trials.jsonl"
        self.source.write_text("measured trials\n")
        self.report = self.root / "report.json"
        body = {
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
        self.report.write_text(json.dumps(body, sort_keys=True))

    def tearDown(self):
        self.temp.cleanup()

    def assigned(self, count=4, canary_accepted=True, control_accepted=False,
                 canary_risk=.05, control_risk=.1, percent=50):
        planner = mod._load_planner()
        arms = {"control": [], "canary": []}
        index = 0
        while min(map(len, arms.values())) < count:
            subject = f"tenant-{index}"
            plan = planner.plan(str(self.report), subject, "safe", percent, .25, True)
            arm = plan["assignment"]
            if len(arms[arm]) < count:
                arms[arm].append({
                    "subject": subject,
                    "assignment": arm,
                    "route": plan["route"],
                    "accepted": canary_accepted if arm == "canary" else control_accepted,
                    "risk": canary_risk if arm == "canary" else control_risk,
                })
            index += 1
        return arms["control"] + arms["canary"]

    def observations(self, items=None, **overrides):
        body = {
            "observations": mod.OBSERVATIONS,
            "report_sha256": hashlib.sha256(self.report.read_bytes()).hexdigest(),
            "source_sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "items": self.assigned() if items is None else items,
        }
        body.update(overrides)
        path = self.root / f"observations-{len(list(self.root.glob('observations-*')))}.json"
        path.write_text(json.dumps(body, sort_keys=True))
        return path

    def evaluate(self, observations=None, **kwargs):
        kwargs.setdefault("enable_evaluation", True)
        kwargs.setdefault("canary_percent", 50)
        kwargs.setdefault("min_samples", 4)
        return mod.evaluate(str(self.report), str(observations or self.observations()), "safe", **kwargs)

    def test_promotes_improved_lower_risk_canary(self):
        result = self.evaluate()
        self.assertEqual(result["verdict"], "PROMOTE")
        self.assertEqual(result["accepted_delta_bps"], 10_000)
        self.assertEqual(result["control"]["trials"], 4)
        self.assertEqual(result["canary"]["trials"], 4)
        self.assertNotIn("report", result)
        self.assertNotIn("observations", result)

    def test_rolls_back_acceptance_regression(self):
        path = self.observations(self.assigned(canary_accepted=False, control_accepted=True))
        self.assertEqual(self.evaluate(path)["verdict"], "ROLLBACK")

    def test_rolls_back_risk_ceiling_breach(self):
        path = self.observations(self.assigned(canary_risk=.3))
        self.assertEqual(self.evaluate(path)["verdict"], "ROLLBACK")

    def test_holds_when_lift_or_relative_risk_is_insufficient(self):
        equal = self.observations(self.assigned(canary_accepted=True, control_accepted=True))
        self.assertEqual(self.evaluate(equal, min_lift_bps=1)["verdict"], "HOLD")
        riskier = self.observations(self.assigned(canary_risk=.2, control_risk=.1))
        self.assertEqual(self.evaluate(riskier)["verdict"], "HOLD")

    def test_requires_explicit_opt_in(self):
        result = self.evaluate(enable_evaluation=False)
        self.assertIsNone(result["verdict"])
        self.assertTrue(any("opt-in" in reason for reason in result["refusal_reasons"]))

    def test_refuses_report_and_source_binding_drift(self):
        path = self.observations()
        body = json.loads(path.read_text())
        body["report_sha256"] = "0" * 64
        path.write_text(json.dumps(body))
        self.assertTrue(any("exact router report" in reason for reason in self.evaluate(path)["refusal_reasons"]))
        path = self.observations(source_sha256="1" * 64)
        self.assertTrue(any("exact evidence source" in reason for reason in self.evaluate(path)["refusal_reasons"]))

    def test_refuses_source_bytes_changed_after_report(self):
        path = self.observations()
        self.source.write_text("drifted")
        result = self.evaluate(path)
        self.assertTrue(any("rebound" in reason for reason in result["refusal_reasons"]))

    def test_refuses_assignment_or_route_mismatch(self):
        items = self.assigned()
        items[0]["assignment"] = "canary" if items[0]["assignment"] == "control" else "control"
        path = self.observations(items)
        self.assertTrue(any("deterministic assignment" in reason for reason in self.evaluate(path)["refusal_reasons"]))
        items = self.assigned()
        items[0]["route"] = "wrong"
        path = self.observations(items)
        self.assertTrue(any("deterministic assignment" in reason for reason in self.evaluate(path)["refusal_reasons"]))

    def test_refuses_duplicate_subject_and_sparse_arm(self):
        items = self.assigned()
        items[1]["subject"] = items[0]["subject"]
        result = self.evaluate(self.observations(items))
        self.assertTrue(any("repeats a subject" in reason for reason in result["refusal_reasons"]))
        sparse = self.observations(self.assigned(count=3))
        self.assertTrue(any("requires at least 4" in reason for reason in self.evaluate(sparse)["refusal_reasons"]))

    def test_refuses_noncanonical_or_invalid_items(self):
        cases = []
        extra = self.assigned(); extra[0]["note"] = "not allowed"; cases.append(extra)
        bad_bool = self.assigned(); bad_bool[0]["accepted"] = 1; cases.append(bad_bool)
        bad_risk = self.assigned(); bad_risk[0]["risk"] = True; cases.append(bad_risk)
        for items in cases:
            result = self.evaluate(self.observations(items))
            self.assertTrue(result["refusal_reasons"])
            self.assertIsNone(result["verdict"])

    def test_refuses_duplicate_json_keys_wrong_version_and_oversize(self):
        duplicate = self.root / "duplicate.json"
        duplicate.write_text('{"observations":"x","observations":"y","items":[]}')
        self.assertTrue(any("duplicate key" in reason for reason in self.evaluate(duplicate)["refusal_reasons"]))
        wrong = self.observations(observations="v2")
        self.assertTrue(any("version" in reason for reason in self.evaluate(wrong)["refusal_reasons"]))
        huge = self.root / "huge.json"
        huge.write_bytes(b" " * (mod.MAX_BYTES + 1))
        self.assertTrue(any("exceeds" in reason for reason in self.evaluate(huge)["refusal_reasons"]))

    def test_refuses_symlinked_report_and_observations_without_path_disclosure(self):
        path = self.observations()
        linked_report = self.root / "linked-report.json"
        linked_report.symlink_to(self.report)
        report_result = mod.evaluate(
            str(linked_report), str(path), "safe",
            canary_percent=50, min_samples=4, enable_evaluation=True,
        )
        self.assertTrue(any("named regular file" in reason for reason in report_result["refusal_reasons"]))

        linked_observations = self.root / "linked-observations.json"
        linked_observations.symlink_to(path)
        observations_result = self.evaluate(linked_observations)
        self.assertTrue(any("named regular file" in reason for reason in observations_result["refusal_reasons"]))

        serialized = json.dumps({"report": report_result, "observations": observations_result})
        self.assertNotIn(str(self.root), serialized)
        for result in (report_result, observations_result):
            self.assertNotIn("report", result)
            self.assertNotIn("observations", result)

    def test_observation_byte_drift_changes_digest(self):
        path = self.observations()
        first = self.evaluate(path)
        path.write_text(path.read_text() + "\n")
        second = self.evaluate(path)
        self.assertEqual(second["verdict"], first["verdict"])
        self.assertNotEqual(second["observations_sha256"], first["observations_sha256"])

    def test_cli_json_human_and_exit_contract(self):
        path = self.observations()
        base = [sys.executable, str(TOOL), str(self.report), str(path), "--enable-evaluation",
                "--control-route", "safe", "--canary-percent", "50", "--min-samples", "4"]
        human = subprocess.run(base, capture_output=True, text=True)
        self.assertEqual(human.returncode, 0)
        self.assertIn("Canary evaluation: PROMOTE", human.stdout)
        machine = subprocess.run(base + ["--json"], capture_output=True, text=True)
        machine_result = json.loads(machine.stdout)
        self.assertEqual(machine_result["verdict"], "PROMOTE")
        self.assertNotIn("report", machine_result)
        self.assertNotIn("observations", machine_result)
        refused = subprocess.run([item for item in base if item != "--enable-evaluation"], capture_output=True, text=True)
        self.assertEqual(refused.returncode, mod.REFUSED)
        missing = subprocess.run([sys.executable, str(TOOL), str(self.report), str(path) + "x",
                                  "--control-route", "safe"], capture_output=True)
        self.assertEqual(missing.returncode, mod.NO_INPUT)
        usage = subprocess.run(base + ["--wat"], capture_output=True)
        self.assertEqual(usage.returncode, mod.USAGE)


if __name__ == "__main__":
    unittest.main()
