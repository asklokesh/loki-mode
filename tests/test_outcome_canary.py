import hashlib, importlib.util, json, os, pathlib, subprocess, sys, tempfile, unittest
ROOT = pathlib.Path(__file__).parents[1]; TOOL = ROOT / "tools/outcome-canary.py"
spec = importlib.util.spec_from_file_location("outcome_canary", TOOL); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)

class TestOutcomeCanary(unittest.TestCase):
    def source(self, text="trials\n"):
        f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False); f.write(text); f.close()
        return f.name

    def report(self, primary="fast", control="safe", primary_trials=5, control_trials=5,
               primary_risk=.1, control_risk=.1, control_eligible=True, source=None, **over):
        src = source if source is not None else self.source()
        body = {"report": "loki-outcome-router/v1", "source": src,
                "source_sha256": hashlib.sha256(pathlib.Path(src).read_bytes()).hexdigest(),
                "selected_route": primary, "invalid_observations": [],
                "candidates": [
                    {"route": primary, "trials": primary_trials, "mean_risk": primary_risk,
                     "eligible": True, "refusal_reasons": []},
                    {"route": control, "trials": control_trials, "mean_risk": control_risk,
                     "eligible": control_eligible, "refusal_reasons": []}]}
        body.update(over)
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(body, f); f.close(); return f.name

    def plan(self, report=None, subject="tenant-1", control="safe", **kw):
        kw.setdefault("enable_canary", True)
        return mod.plan(report or self.report(), subject, control, **kw)

    # opt-in
    def test_canary_requires_explicit_opt_in(self):
        r = self.plan(enable_canary=False)
        self.assertIsNone(r["assignment"])
        self.assertIn("canary is opt-in; pass --enable-canary", r["refusal_reasons"])
        self.assertEqual(self.plan()["refusal_reasons"], [])

    # deterministic assignment
    def test_assignment_is_stable_for_a_subject(self):
        path = self.report()
        first = self.plan(path); second = self.plan(path)
        self.assertEqual(first["evidence_digest"], second["evidence_digest"])
        self.assertEqual(first["assignment"], second["assignment"])
        self.assertIn(first["assignment"], ("control", "canary"))

    def test_differing_subjects_reach_both_arms(self):
        path = self.report()
        seen = {self.plan(path, subject=f"tenant-{i}", canary_percent=50)["assignment"] for i in range(40)}
        self.assertEqual(seen, {"control", "canary"})

    def test_percent_bounds_are_total(self):
        path = self.report()
        for i in range(8):
            self.assertEqual(self.plan(path, subject=f"s{i}", canary_percent=0)["assignment"], "control")
            self.assertEqual(self.plan(path, subject=f"s{i}", canary_percent=100)["assignment"], "canary")

    def test_subject_changes_the_digest(self):
        path = self.report()
        self.assertNotEqual(self.plan(path, subject="a")["evidence_digest"],
                            self.plan(path, subject="b")["evidence_digest"])

    def test_report_bytes_are_bound_to_plan_and_assignment_digest(self):
        path = self.report()
        before = self.plan(path)
        self.assertEqual(before["report_sha256"], hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest())
        body = json.loads(pathlib.Path(path).read_text())
        body["review_note"] = "changed after review"
        pathlib.Path(path).write_text(json.dumps(body))
        after = self.plan(path)
        self.assertEqual(after["refusal_reasons"], [])
        self.assertNotEqual(after["report_sha256"], before["report_sha256"])
        self.assertNotEqual(after["evidence_digest"], before["evidence_digest"])

    # evidence integrity
    def test_malformed_and_wrong_version_reports_refuse(self):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); f.write("{"); f.close()
        self.assertTrue(any("malformed" in x for x in self.plan(f.name)["refusal_reasons"]))
        bad = self.report(report="loki-outcome-router/v2")
        self.assertTrue(any("report version" in x for x in self.plan(bad)["refusal_reasons"]))

    def test_nonfinite_and_bool_measures_refuse(self):
        for value in ("NaN", "Infinity", "true"):
            src = self.source()
            body = json.loads(pathlib.Path(self.report(source=src)).read_text())
            body["candidates"][0]["mean_risk"] = json.loads(value)
            f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
            json.dump(body, f); f.close()
            r = self.plan(f.name)
            self.assertIsNone(r["assignment"], value)
            self.assertTrue(any("invalid measured values" in x for x in r["refusal_reasons"]), value)
        body = json.loads(pathlib.Path(self.report()).read_text())
        body["candidates"][0]["trials"] = True
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(body, f); f.close()
        self.assertTrue(any("invalid measured values" in x for x in self.plan(f.name)["refusal_reasons"]))

    def test_source_drift_and_absent_source_refuse(self):
        src = self.source(); path = self.report(source=src)
        with open(src, "a") as handle: handle.write("drifted\n")
        self.assertTrue(any("drifted" in x for x in self.plan(path)["refusal_reasons"]))
        src2 = self.source(); path2 = self.report(source=src2); os.unlink(src2)
        r = self.plan(path2)
        self.assertTrue(r["source_missing"])
        self.assertTrue(any("absent" in x for x in r["refusal_reasons"]))

    def test_missing_digest_key_refuses(self):
        body = json.loads(pathlib.Path(self.report()).read_text()); del body["source_sha256"]
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(body, f); f.close()
        self.assertTrue(any("source_sha256" in x for x in self.plan(f.name)["refusal_reasons"]))

    # policy
    def test_matched_trials_required(self):
        r = self.plan(self.report(primary_trials=9, control_trials=4))
        self.assertIsNone(r["assignment"])
        self.assertTrue(any("unmatched" in x for x in r["refusal_reasons"]))

    def test_either_route_over_risk_ceiling_refuses(self):
        self.assertTrue(any("mean risk" in x for x in self.plan(self.report(primary_risk=.9))["refusal_reasons"]))
        self.assertTrue(any("mean risk" in x for x in self.plan(self.report(control_risk=.9))["refusal_reasons"]))

    def test_absent_ineligible_and_identical_routes_refuse(self):
        self.assertTrue(any("absent from the report" in x for x in self.plan(control="nope")["refusal_reasons"]))
        self.assertTrue(any("not eligible" in x for x in self.plan(self.report(control_eligible=False))["refusal_reasons"]))
        self.assertTrue(any("must differ" in x for x in self.plan(control="fast")["refusal_reasons"]))
        no_primary = self.report(selected_route=None)
        self.assertTrue(any("selected no primary" in x for x in self.plan(no_primary)["refusal_reasons"]))

    def test_invalid_percentage_refuses(self):
        for bad in (-1, 101, float("nan"), True):
            r = self.plan(canary_percent=bad)
            self.assertIsNone(r["assignment"], bad)
            self.assertTrue(any("canary percent" in x for x in r["refusal_reasons"]), bad)

    # rollback + side effects
    def test_rollback_metadata_assigns_control(self):
        r = self.plan()
        self.assertTrue(r["reversible"])
        self.assertEqual(r["rollback"]["assignment"], "control")
        self.assertEqual(r["rollback"]["route"], "safe")
        self.assertIn("--canary-percent 0", r["rollback"]["command"])
        rolled = self.plan(canary_percent=0)
        self.assertEqual(rolled["assignment"], "control")
        self.assertEqual(rolled["route"], "safe")

    def test_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            cwd = os.getcwd(); os.chdir(d)
            try:
                before = sorted(os.listdir(d)); self.plan(); after = sorted(os.listdir(d))
            finally:
                os.chdir(cwd)
        self.assertEqual(before, after)

    # CLI contract
    def test_cli_output_and_exit_codes(self):
        path = self.report()
        base = [sys.executable, str(TOOL), path, "--subject", "t1", "--control-route", "safe"]
        ok = subprocess.run(base + ["--enable-canary", "--canary-percent", "100"], capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0); self.assertIn("Canary plan: canary -> fast", ok.stdout)
        self.assertIn("reversible: True", ok.stdout); self.assertIn("rollback:", ok.stdout)
        j = subprocess.run(base + ["--enable-canary", "--json"], capture_output=True, text=True)
        self.assertEqual(j.returncode, 0)
        payload = json.loads(j.stdout)
        self.assertEqual(payload["rollback"]["assignment"], "control")
        self.assertEqual(payload["primary_route"], "fast")
        self.assertEqual(payload["report_sha256"], hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest())
        optout = subprocess.run(base, capture_output=True, text=True)
        self.assertEqual(optout.returncode, 3); self.assertIn("REFUSED", optout.stdout)
        self.assertEqual(subprocess.run(base + ["--wat"], capture_output=True).returncode, 64)
        self.assertEqual(subprocess.run([sys.executable, str(TOOL), path, "--enable-canary"],
                                        capture_output=True).returncode, 64)
        self.assertEqual(subprocess.run([sys.executable, str(TOOL), path + "x",
                                         "--subject", "t", "--control-route", "safe"],
                                        capture_output=True).returncode, 66)
        src = self.source(); gone = self.report(source=src); os.unlink(src)
        absent = subprocess.run([sys.executable, str(TOOL), gone, "--enable-canary",
                                 "--subject", "t", "--control-route", "safe"], capture_output=True)
        self.assertEqual(absent.returncode, 66)

    def test_cli_assignment_is_stable_across_processes(self):
        path = self.report()
        cmd = [sys.executable, str(TOOL), path, "--enable-canary", "--subject", "tenant-x",
               "--control-route", "safe", "--canary-percent", "50", "--json"]
        runs = {json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout)["assignment"] for _ in range(3)}
        self.assertEqual(len(runs), 1)

if __name__ == "__main__": unittest.main()
