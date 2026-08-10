import importlib.util, json, pathlib, subprocess, sys, tempfile, unittest
ROOT = pathlib.Path(__file__).parents[1]; TOOL = ROOT / "tools/outcome-router.py"
spec = importlib.util.spec_from_file_location("outcome_router", TOOL); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
class TestOutcomeRouter(unittest.TestCase):
    def write(self, rows):
        f = tempfile.NamedTemporaryFile("w", delete=False)
        for row in rows: f.write((json.dumps(row) if not isinstance(row, str) else row) + "\n")
        f.close(); return f.name
    def row(self, route="a", accepted=True, cost=1, mins=1, risk=.1):
        return {"route":route,"accepted":accepted,"cost_usd":cost,"duration_minutes":mins,"risk":risk,"verifier":"proof"}
    def test_selects_best_measured_route(self):
        p=self.write([self.row("b",cost=2)]*3+[self.row("a",cost=1)]*3)
        self.assertEqual(mod.route(p)["selected_route"], "a")
    def test_deterministic_tie(self):
        p=self.write([self.row("z")]*3+[self.row("a")]*3); self.assertEqual(mod.route(p)["selected_route"],"a")
    def test_sparse_and_risky_refuse(self):
        p=self.write([self.row(risk=.9)]*2); self.assertIsNone(mod.route(p)["selected_route"])
    def test_zero_cost_is_finite(self):
        p=self.write([self.row(cost=0)]*3); self.assertTrue(mod.route(p)["candidates"][0]["eligible"])
    def test_bad_bool_and_nonfinite_poison_input(self):
        rows=[self.row() for _ in range(3)]; rows += [{**self.row(),"accepted":1}, {**self.row(),"risk":float("nan")}, "{"]
        r=mod.route(self.write(rows)); self.assertIsNone(r["selected_route"]); self.assertEqual(len(r["invalid_observations"]),3)
    def test_report_carries_source_digest_and_policy(self):
        import hashlib
        p=self.write([self.row()]*3); r=mod.route(p,min_trials=3,max_risk=.25,risk_weight=1.0)
        self.assertEqual(r["source_sha256"], hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest())
        self.assertEqual(r["policy"], {"min_trials":3,"max_risk":.25,"risk_weight":1.0})
    def test_cli_json_human_and_codes(self):
        p=self.write([self.row()]*3)
        j=subprocess.run([sys.executable,str(TOOL),p,"--json"],capture_output=True,text=True); self.assertEqual(j.returncode,0); json.loads(j.stdout)
        h=subprocess.run([sys.executable,str(TOOL),p],capture_output=True,text=True); self.assertIn("Outcome route: a",h.stdout)
        missing=subprocess.run([sys.executable,str(TOOL),p+"x"],capture_output=True); self.assertEqual(missing.returncode,66)
        usage=subprocess.run([sys.executable,str(TOOL),p,"--wat"],capture_output=True); self.assertEqual(usage.returncode,64)
        refused=subprocess.run([sys.executable,str(TOOL),self.write([self.row()])],capture_output=True); self.assertEqual(refused.returncode,3)
if __name__ == "__main__": unittest.main()
