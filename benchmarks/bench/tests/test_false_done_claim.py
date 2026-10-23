"""False-done claim: statistics, vacuity guard, useful-done guard, grid gating. No model calls.
Run: python3 -m pytest benchmarks/bench/tests/test_false_done_claim.py"""
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import false_done_claim as fd  # noqa: E402


def arm(tool, trials, claimed, false_done, useful):
    ci = fd.wilson
    return {"tool": tool, "trials": trials, "claimed_done": claimed, "false_done": false_done,
            "useful_done": useful, "false_done_ci": ci(false_done, trials), "useful_done_ci": ci(useful, trials)}


def result_file(d, tool, task, verdict, exit_status, ok, name):
    adapter = {"exit_status": exit_status, "cost_usd": 0.1, "provenance": {"verify_verdict": verdict}}
    row = {"tool": tool, "task_id": task,
           "trials": [{"adapter": adapter, "success": ok, "acceptance_exit_code": 0 if ok else 1}]}
    with open(os.path.join(d, name), "w") as fh:
        json.dump(row, fh)


MANIFEST = {"name": "m", "tasks": {"t1": {"sha256": "h1", "language": "python"},
                                    "t2": {"sha256": "h2", "language": "python"}},
            "pins": {"loki": {"tool_version": "11.0", "model": "sonnet"}}}


class Stats(unittest.TestCase):
    def test_wilson_zero_and_required_n(self):
        self.assertAlmostEqual(fd.wilson(0, 381)[1], fd.Z2 / (381 + fd.Z2), places=6)
        self.assertIsNone(fd.n_required(0))
        self.assertAlmostEqual(fd.rule_of_three(300), 0.01)

    def test_n_required_vectors(self):
        self.assertEqual(fd.n_required(1.0), 385)
        self.assertEqual(fd.n_required(0.9), 439)
        self.assertEqual(fd.n_required(0.5), 822)

    def test_n_required_is_the_gate_boundary(self):
        for p in (1.0, 0.9, 0.5):
            n = fd.n_required(p)
            self.assertGreaterEqual(fd.gate_ratio(round(p * n), n, 0, n), fd.FACTOR, p)
            self.assertLess(fd.gate_ratio(round(p * (n - 1)), n - 1, 0, n - 1), fd.FACTOR, p)

    def test_old_n_381_fails_the_gate(self):
        self.assertLess(fd.gate_ratio(381, 381, 0, 381), fd.FACTOR)
        t = fd.claim_text(arm("loki", 381, 381, 0, 381), arm("claude_code", 381, 381, 381, 0), "m", 10)
        self.assertTrue(t.startswith("CLAIM NOT SUPPORTED"), t)
        self.assertIn("needed at 0 false-done and this competitor rate: 385", t)
        t = fd.claim_text(arm("loki", 385, 385, 0, 385), arm("claude_code", 385, 385, 385, 0), "m", 10)
        self.assertTrue(t.startswith("CLAIM SUPPORTED"), t)


class Claim(unittest.TestCase):
    def test_vacuous_when_loki_never_claims(self):
        t = fd.claim_text(arm("loki", 400, 0, 0, 0), arm("claude_code", 30, 30, 30, 0), "m", 11)
        self.assertTrue(t.startswith("CLAIM NOT SUPPORTED: vacuous"), t)

    def test_supported_names_the_set(self):
        t = fd.claim_text(arm("loki", 500, 500, 0, 500), arm("claude_code", 30, 30, 30, 0), "trap-v1", 11)
        self.assertTrue(t.startswith("CLAIM SUPPORTED"), t)
        self.assertIn("11 pre-registered false-completion trap tasks (trap-v1)", t)

    def test_one_loki_false_done_fails(self):
        t = fd.claim_text(arm("loki", 381, 381, 1, 380), arm("claude_code", 30, 30, 30, 0), "m", 11)
        self.assertTrue(t.startswith("CLAIM NOT SUPPORTED"), t)
        self.assertNotIn("100x", t)

    def test_wins_false_done_but_loses_useful_done(self):
        # Loki claims done rarely and cleanly (0 false-done) but is useful on 5 of 1000; the competitor
        # is useful on 100 of 300. False-done ratio alone would pass; useful-done must block it.
        loki = arm("loki", 1000, 5, 0, 5)
        comp = arm("claude_code", 300, 300, 200, 100)
        self.assertGreaterEqual(comp["false_done_ci"][0] / loki["false_done_ci"][1], fd.FACTOR)
        t = fd.claim_text(loki, comp, "m", 11)
        self.assertIn("worse than claude_code beyond the intervals", t)
        self.assertTrue(t.startswith("CLAIM NOT SUPPORTED"), t)

    def test_positive_control_same_loki_without_useful_penalty_passes(self):
        loki = arm("loki", 1000, 900, 0, 900)
        comp = arm("claude_code", 300, 300, 200, 100)
        self.assertTrue(fd.claim_text(loki, comp, "m", 11).startswith("CLAIM SUPPORTED"))


class Report(unittest.TestCase):
    def test_report_reads_results_and_filters_to_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            mp = os.path.join(d, "m.json")
            json.dump(MANIFEST, open(mp, "w"))
            result_file(d, "loki", "t1", "PARTIAL", "error_rc_1", True, "a.json")
            result_file(d, "loki", "t1", "VERIFIED", "completed", False, "b.json")
            result_file(d, "loki", "other", "VERIFIED", "completed", False, "c.json")
            result_file(d, "claude_code", "t1", None, "completed", False, "e.json")
            out = fd.report(mp, [d], "claude_code")
            self.assertEqual(out["loki"]["trials"], 2)
            self.assertEqual(out["loki"]["claimed_done"], 1)
            self.assertEqual(out["loki"]["false_done"], 1)
            self.assertEqual(out["competitor"]["false_done"], 1)

    def test_manifest_requires_tasks_object(self):
        with tempfile.TemporaryDirectory() as d:
            for bad in ({"tasks": {}}, {"tasks": ["t1"]}, {}):
                p = os.path.join(d, "m.json")
                json.dump(bad, open(p, "w"))
                with self.assertRaises(ValueError):
                    fd.load_manifest(p)

    def test_load_trap_manifest_shape(self):
        # Verbatim head of pd/traptasks trap-manifest.json (127b6654d): no name, tasks keyed by id.
        shape = {"schema_version": "1.0", "preregistered_before_any_paid_run": True, "tasks": {
            "trap-01-dedupe": {"sha256": "c57b67a712ee1629b2d36209689b5113817a30c597c42c49298b6fb66ee5e073",
                               "language": "python"}}}
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "trap-manifest.json")
            json.dump(shape, open(p, "w"))
            m = fd.load_manifest(p)
        self.assertEqual(m["name"], "trap-manifest")
        self.assertEqual(list(m["tasks"]), ["trap-01-dedupe"])

    def test_load_real_trap_manifest(self):
        path = os.path.join(os.path.dirname(__file__), "..", "tasks", "trap-manifest.json")
        if not os.path.exists(path):
            self.skipTest("trap-manifest.json lands with pd/traptasks")
        m = fd.load_manifest(path)
        self.assertEqual(m["name"], "trap-manifest")
        self.assertEqual(len(m["tasks"]), 10)
        self.assertTrue(all(len(v["sha256"]) == 64 and v["language"] for v in m["tasks"].values()))


def crow(tool, task, value, correct=True, trial=1, axis="C", **kw):
    r = {"axis": axis, "tool": tool, "tool_version": "11.0" if tool == "loki" else "2.0",
         "model": "sonnet", "task_id": task, "task_hash": MANIFEST["tasks"][task]["sha256"], "trial": trial,
         "value": value, "unit": "ms", "correct": correct}
    r.update(kw)
    return r


def write_rows(root, axis, tool, rows):
    os.makedirs(os.path.join(root, axis), exist_ok=True)
    with open(os.path.join(root, axis, tool + ".jsonl"), "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")


def pair_rows(ratio, n_tasks=2, trials=4, loki_correct=True):
    lk, cp = [], []
    for task in list(MANIFEST["tasks"])[:n_tasks]:
        for i in range(1, trials + 1):
            lk.append(crow("loki", task, 10.0, loki_correct, i))
            cp.append(crow("claude_code", task, 10.0 * ratio, True, i))
    return lk, cp


class CostAxis(unittest.TestCase):
    def verdict(self, lk, cp, manifest=MANIFEST):
        return fd.cost_axis("C", lk, cp, manifest, "claude_code")

    def test_proven_at_150x(self):
        v = self.verdict(*pair_rows(150))
        self.assertEqual(v["verdict"], "PROVEN", v["line"])
        self.assertIn("100x", v["line"])

    def test_not_proven_below_gate_has_no_100x(self):
        v = self.verdict(*pair_rows(50))
        self.assertEqual(v["verdict"], "NOT PROVEN")
        self.assertNotIn("100x", v["line"])

    def test_150x_but_less_correct_is_not_proven(self):
        lk, cp = pair_rows(150, trials=30, loki_correct=False)
        v = self.verdict(lk, cp)
        self.assertEqual(v["verdict"], "NOT PROVEN", v["line"])
        self.assertIn("less correct", v["line"])
        self.assertNotIn("100x", v["line"])

    def test_incorrect_rows_are_excluded_and_counted(self):
        lk, cp = pair_rows(150, trials=6)
        lk[0]["correct"] = False
        v = self.verdict(lk, cp)
        self.assertEqual(v["loki"]["incorrect"], 1)
        self.assertEqual(v["loki"]["correct"], len(lk) - 1)

    def test_pin_mismatch_is_refused_not_proven(self):
        for field, bad in (("task_hash", "nope"), ("model", "opus"), ("tool_version", "9.9")):
            lk, cp = pair_rows(150)
            lk[0][field] = bad
            v = self.verdict(lk, cp)
            self.assertEqual(v["verdict"], "NOT PROVEN", field)
            self.assertEqual(v["loki"]["refused"], 1, field)
            self.assertIn("pin check refused", v["line"])

    def test_no_rows_is_no_data_never_zero(self):
        v = self.verdict([], [])
        self.assertEqual(v["verdict"], "NO DATA")
        self.assertNotIn("100x", v["line"])
        self.assertNotIn("0.0", v["line"])

    def test_uses_cost_claim_bootstrap(self):
        import cost_claim
        self.assertIs(fd.cost_claim, cost_claim)

    def test_unpaired_tasks_not_proven(self):
        lk = [crow("loki", "t1", 10.0)]
        cp = [crow("claude_code", "t2", 2000.0)]
        self.assertEqual(self.verdict(lk, cp)["verdict"], "NOT PROVEN")


class Claim100(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.mp = os.path.join(self.d, "m.json")
        json.dump(MANIFEST, open(self.mp, "w"))
        self.root = os.path.join(self.d, "claim")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.d, ignore_errors=True)

    def run_claim(self, *extra):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = fd.main(["claim", "--manifest", self.mp, "--root", self.root,
                          "--claims-dir", os.path.join(self.d, "claims"), *extra])
        return rc, buf.getvalue()

    def test_empty_is_no_data_on_every_axis_exit_0(self):
        rc, out = self.run_claim()
        self.assertEqual(rc, 0)
        self.assertEqual(out.count("NO DATA"), 4, out)
        self.assertNotIn("100x", out)

    def test_missing_manifest_is_no_data(self):
        os.remove(self.mp)
        rc, out = self.run_claim()
        self.assertEqual((rc, out.count("NO DATA")), (0, 4))

    def test_exactly_one_100x_sentence_when_only_c_proven(self):
        lk, cp = pair_rows(150)
        write_rows(self.root, "C", "loki", lk)
        write_rows(self.root, "C", "claude_code", cp)
        os.makedirs(os.path.join(self.root, "A"))
        result_file(os.path.join(self.root, "A"), "loki", "t1", "VERIFIED", "completed", True, "a.json")
        result_file(os.path.join(self.root, "A"), "claude_code", "t1", "VERIFIED", "completed", False, "b.json")
        rc, out = self.run_claim()
        self.assertEqual(out.count("100x"), 1, out)
        self.assertEqual(self.run_claim("--require-proven")[0], 1)
        self.assertIn("A false done: NOT PROVEN (need n=", out)

    def test_require_proven_passes_when_requested_axis_proven(self):
        lk, cp = pair_rows(150)
        write_rows(self.root, "C", "loki", lk)
        write_rows(self.root, "C", "claude_code", cp)
        self.assertEqual(self.run_claim("--axis", "C", "--require-proven")[0], 0)

    def test_json_is_byte_identical_across_runs(self):
        lk, cp = pair_rows(150)
        write_rows(self.root, "C", "loki", lk)
        write_rows(self.root, "C", "claude_code", cp)
        self.assertEqual(self.run_claim("--json")[1], self.run_claim("--json")[1])

    def test_record_writes_verdicts_and_input_hashes(self):
        lk, cp = pair_rows(150)
        write_rows(self.root, "C", "loki", lk)
        write_rows(self.root, "C", "claude_code", cp)
        rc, out = self.run_claim("--record", "--json")
        path = json.loads(out)["recorded"]
        rec = json.load(open(path))
        self.assertEqual(rec["axes"]["C"]["verdict"], "PROVEN")
        self.assertIn("C/loki.jsonl", rec["input_sha256"])
        self.assertIn("manifest", rec["input_sha256"])

    def test_run_refuses_without_spend_approval(self):
        os.environ.pop("LOKI_BENCH_SPEND_APPROVED", None)
        self.assertEqual(self.run_claim("--run", "--trials", "1")[0], 2)

    def test_ten_thousand_rows_under_five_seconds(self):
        lk, cp = [], []
        for i in range(1, 5001):
            task = "t1" if i % 2 else "t2"
            lk.append(crow("loki", task, 10.0 + (i % 7), True, i))
            cp.append(crow("claude_code", task, 1500.0 + (i % 11), True, i))
        write_rows(self.root, "C", "loki", lk)
        write_rows(self.root, "C", "claude_code", cp)
        t0 = time.time()
        rc, out = self.run_claim("--json")
        self.assertLess(time.time() - t0, 5.0)
        self.assertEqual(json.loads(out)["axes"]["C"]["verdict"], "PROVEN")


class Grid(unittest.TestCase):
    def test_plan_size_and_load_gate_and_resume(self):
        m = {"name": "m", "tasks": {"a": {}, "b": {}}}
        self.assertEqual(len(fd.plan(m, ["loki", "claude_code"], 3)), 12)
        loads = iter([30.0, 26.0, 10.0] + [10.0] * 50)
        sleeps = []
        launched = []
        with tempfile.TemporaryDirectory() as d:
            res = fd.run_grid(m, ["loki"], 1, d, parallel=1, launch=lambda t, tool, i, out, env: launched.append(out) or 0,
                              load=lambda: next(loads), sleep=lambda s: sleeps.append(s))
            self.assertEqual(len(res), 2)
            self.assertEqual(len(sleeps), 2)  # waited twice while load >= 24 before the first launch
            open(launched[0], "w").close()
            res2 = fd.run_grid(m, ["loki"], 1, d, parallel=1, launch=lambda *a: 0, load=lambda: 1.0)
            self.assertEqual(res2[0][1], "skipped-existing")

    def test_each_trial_row_records_its_own_workdir(self):
        m = {"name": "m", "tasks": {"a": {}}}
        seen = []

        def launch(task, tool, i, out, env):
            root = env["LOKI_BENCH_WORKDIRS"]
            seen.append(root)
            wd = os.path.join(root, tool, task, "0")
            os.makedirs(wd)
            open(os.path.join(wd, "f.txt"), "w").write("x%d" % i)
            json.dump({"tool": tool, "task_id": task, "trials": [{"success": True}]}, open(out, "w"))
            return 0
        with tempfile.TemporaryDirectory() as d:
            fd.run_grid(m, ["loki"], 2, d, parallel=1, launch=launch, load=lambda: 0.0)
            dirs = []
            for i in (1, 2):
                row = json.load(open(os.path.join(d, "a__loki__%03d.json" % i)))["trials"][0]
                self.assertEqual(row["workdir"], os.path.join(d, "workdirs", "loki", "a", "%03d" % i))
                self.assertEqual(open(os.path.join(row["workdir"], "f.txt")).read(), "x%d" % i)
                dirs.append(row["workdir"])
            self.assertEqual(len(set(seen)), 2)
            self.assertEqual(len(set(dirs)), 2)

    def test_collect_carries_workdir(self):
        with tempfile.TemporaryDirectory() as d:
            json.dump({"tool": "loki", "task_id": "t1", "trials": [{"success": True, "workdir": "/w/1",
                       "adapter": {"provenance": {"verify_verdict": "VERIFIED"}}}]}, open(os.path.join(d, "r.json"), "w"))
            recs = fd.collect([os.path.join(d, "r.json")], {"t1"})
        self.assertEqual(fd.collect_workdirs(recs), ["/w/1"])


if __name__ == "__main__":
    unittest.main()
