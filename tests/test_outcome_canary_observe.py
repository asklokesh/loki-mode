import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).parents[1]
TOOL = ROOT / "tools/outcome-canary-observe.py"
spec = importlib.util.spec_from_file_location("outcome_canary_observe", TOOL)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class TestOutcomeCanaryObserve(unittest.TestCase):
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
        self.observations = self.root / "observations.json"

    def tearDown(self):
        self.temp.cleanup()

    def record(self, subject="tenant-1", accepted=True, risk=.1, **kwargs):
        kwargs.setdefault("enable_recording", True)
        kwargs.setdefault("canary_percent", 50)
        return mod.record(
            str(self.report), str(self.observations), subject, accepted, risk, "safe", **kwargs
        )

    def test_creates_and_appends_canonical_bound_observations(self):
        first = self.record()
        self.assertEqual(first["status"], "RECORDED")
        second = self.record("tenant-2", accepted=False, risk=.2)
        self.assertEqual(second["observation_count"], 2)
        body = json.loads(self.observations.read_text())
        self.assertEqual(body["observations"], mod.OBSERVATIONS)
        self.assertEqual(body["report_sha256"], hashlib.sha256(self.report.read_bytes()).hexdigest())
        self.assertEqual(body["source_sha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual([item["subject"] for item in body["items"]], ["tenant-1", "tenant-2"])
        self.assertEqual(first["observations_sha256"], hashlib.sha256(
            (json.dumps({**body, "items": body["items"][:1]}, sort_keys=True, separators=(",", ":")) + "\n").encode()
        ).hexdigest())

    def test_reproduces_assignment_and_route(self):
        result = self.record("opaque-subject")
        planner = mod._load_tool("outcome-canary.py", "test_observe_planner")
        plan = planner.plan(str(self.report), "opaque-subject", "safe", 50, .25, True)
        self.assertEqual((result["assignment"], result["route"]), (plan["assignment"], plan["route"]))

    def test_requires_opt_in_without_creating_observations(self):
        result = self.record(enable_recording=False)
        self.assertEqual(result["refusal_reason"], "recording_not_enabled")
        self.assertFalse(self.observations.exists())

    def test_refuses_duplicate_subject_without_changing_bytes(self):
        self.record()
        before = self.observations.read_bytes()
        result = self.record()
        self.assertEqual(result["refusal_reason"], "duplicate_subject")
        self.assertEqual(self.observations.read_bytes(), before)

    def test_refuses_symlinked_report_or_observations(self):
        linked_report = self.root / "linked-report.json"
        linked_report.symlink_to(self.report)
        result = mod.record(
            str(linked_report), str(self.observations), "tenant", True, .1, "safe", 50, .25, True
        )
        self.assertEqual(result["refusal_reason"], "not_named_regular_file")
        target = self.root / "target.json"
        target.write_text("{}")
        self.observations.symlink_to(target)
        self.assertEqual(self.record()["refusal_reason"], "not_named_regular_file")

    def test_refuses_binding_and_existing_assignment_drift(self):
        self.record()
        original = json.loads(self.observations.read_text())
        for mutate, reason in (
            (lambda body: body.update(report_sha256="0" * 64), "binding_mismatch"),
            (lambda body: body["items"][0].update(route="wrong"), "existing_assignment_mismatch"),
        ):
            self.observations.write_text(json.dumps(original))
            mutate_body = json.loads(self.observations.read_text())
            mutate(mutate_body)
            self.observations.write_text(json.dumps(mutate_body))
            before = self.observations.read_bytes()
            self.assertEqual(self.record("tenant-2")["refusal_reason"], reason)
            self.assertEqual(self.observations.read_bytes(), before)

    def test_refuses_malformed_oversized_or_source_drift(self):
        self.observations.write_text('{"items":[],"items":[]}')
        self.assertEqual(self.record()["refusal_reason"], "unsafe_or_malformed_input")
        self.observations.write_bytes(b" " * (mod.MAX_BYTES + 1))
        self.assertEqual(self.record()["refusal_reason"], "unsafe_or_malformed_input")
        self.observations.unlink()
        self.source.write_text("drifted")
        self.assertEqual(self.record()["refusal_reason"], "plan_refused")

    def test_refuses_invalid_values_and_item_limit(self):
        self.assertEqual(self.record(subject=" ")["refusal_reason"], "invalid_subject")
        self.assertEqual(self.record(accepted=1)["refusal_reason"], "invalid_measured_value")
        self.assertEqual(self.record(risk=float("nan"))["refusal_reason"], "invalid_measured_value")
        old_limit = mod.MAX_ITEMS
        mod.MAX_ITEMS = 0
        try:
            self.assertEqual(self.record()["refusal_reason"], "item_limit")
        finally:
            mod.MAX_ITEMS = old_limit

    def test_cli_exit_output_privacy_and_installed_help(self):
        base = [
            sys.executable, str(TOOL), str(self.report), str(self.observations),
            "--subject", "private-subject", "--accepted", "--risk", "0.1",
            "--control-route", "safe", "--canary-percent", "50",
        ]
        refused = subprocess.run(base, capture_output=True, text=True)
        self.assertEqual(refused.returncode, mod.REFUSED)
        self.assertFalse(self.observations.exists())
        recorded = subprocess.run(base + ["--enable-recording", "--json"], capture_output=True, text=True)
        self.assertEqual(recorded.returncode, 0)
        output = json.loads(recorded.stdout)
        self.assertEqual(output["status"], "RECORDED")
        serialized = json.dumps(output)
        self.assertNotIn("private-subject", serialized)
        self.assertNotIn(str(self.root), serialized)
        usage = subprocess.run([sys.executable, str(TOOL), "--help"], capture_output=True, text=True)
        self.assertEqual(usage.returncode, 0)
        self.assertIn("--enable-recording", usage.stdout)


if __name__ == "__main__":
    unittest.main()
