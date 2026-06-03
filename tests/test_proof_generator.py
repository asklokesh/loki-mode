"""tests/test_proof_generator.py -- proof-of-run generator behavior (R1).

Covers:
  - schema validity: all frozen v1.0 fields present with the right types.
  - integrity hash: recompute it the way a verifier would (canonical form,
    minus the verification field) and assert it matches; scope == "integrity".
  - --include-diffs toggling: null when off, list when on (real git fixture).
  - graceful degradation: empty council, non-git dir -> empty files list,
    missing efficiency -> zero cost.

The generator is invoked as a subprocess (its filename has a hyphen so it is
not importable as a module), matching how run.sh actually calls it.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_GENERATOR = os.path.join(_REPO, "autonomy", "lib", "proof-generator.py")


def _canonical(obj):
    # Must match proof-generator.py:_canonical exactly.
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _run_generator(loki_dir, out_dir, *, include_diffs=False, env_extra=None,
                   run_id="gen-fixed-001", loki_version="7.9.0"):
    cmd = [sys.executable, _GENERATOR, "--loki-dir", loki_dir,
           "--out-dir", out_dir, "--run-id", run_id,
           "--loki-version", loki_version, "--quiet"]
    if include_diffs:
        cmd.append("--include-diffs")
    env = dict(os.environ)
    env.pop("PRD_PATH", None)
    env.pop("_LOKI_ITER_START_SHA", None)
    env.pop("LOKI_SESSION_ID", None)
    env.pop("LOKI_DEPLOYED_URL", None)
    if env_extra:
        env.update(env_extra)
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 0, "generator failed: %s" % r.stderr
    return json.load(open(os.path.join(out_dir, "proof.json")))


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-gen-schema-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_full(self, loki_dir):
        os.makedirs(os.path.join(loki_dir, "metrics", "efficiency"))
        os.makedirs(os.path.join(loki_dir, "council", "votes"))
        os.makedirs(os.path.join(loki_dir, "state"))
        os.makedirs(os.path.join(loki_dir, "queue"))
        with open(os.path.join(loki_dir, "metrics", "efficiency",
                               "iteration-1.json"), "w") as f:
            json.dump({"cost_usd": 1.2345, "input_tokens": 1000,
                       "output_tokens": 200, "cache_read_tokens": 50,
                       "cache_creation_tokens": 30, "model": "claude-x"}, f)
        with open(os.path.join(loki_dir, "council", "state.json"), "w") as f:
            json.dump({"enabled": True, "threshold": 3,
                       "verdicts": [{"verdict": "APPROVE"}]}, f)
        with open(os.path.join(loki_dir, "council", "votes",
                               "r1.json"), "w") as f:
            json.dump({"role": "principal", "vote": "APPROVE",
                       "summary": "ok"}, f)
        with open(os.path.join(loki_dir, "state",
                               "quality-gates.json"), "w") as f:
            json.dump({"lint": True, "tests": False}, f)
        with open(os.path.join(loki_dir, "queue", "completed.json"), "w") as f:
            json.dump([{"id": 1}, {"id": 2}], f)
        with open(os.path.join(loki_dir, "queue", "failed.json"), "w") as f:
            json.dump([{"id": 3}], f)
        with open(os.path.join(loki_dir, "state",
                               "orchestrator.json"), "w") as f:
            json.dump({"startedAt": "2026-06-03T00:00:00Z",
                       "version": "7.9.0"}, f)
        with open(os.path.join(loki_dir, "generated-prd.md"), "w") as f:
            f.write("Build a small CLI.")

    def test_all_frozen_fields_present_with_types(self):
        loki_dir = os.path.join(self.tmp, "p", ".loki")
        out_dir = os.path.join(self.tmp, "out")
        self._seed_full(loki_dir)
        d = _run_generator(loki_dir, out_dir)

        # Top-level scalars.
        self.assertEqual(d["schema_version"], "1.0")
        self.assertIsInstance(d["run_id"], str)
        self.assertIsInstance(d["generated_at"], str)
        self.assertIsInstance(d["loki_version"], str)
        self.assertIsInstance(d["started_at"], str)
        self.assertIsInstance(d["wall_clock_sec"], int)

        # spec.
        self.assertIsInstance(d["spec"], dict)
        self.assertIsInstance(d["spec"]["source"], str)
        self.assertIsInstance(d["spec"]["brief"], str)
        self.assertLessEqual(len(d["spec"]["brief"]), 600)

        # provider.
        self.assertIsInstance(d["provider"]["name"], str)
        self.assertIsInstance(d["provider"]["model"], str)

        # iterations.
        for k in ("count", "succeeded", "failed"):
            self.assertIsInstance(d["iterations"][k], int)

        # files_changed.
        fc = d["files_changed"]
        for k in ("count", "insertions", "deletions"):
            self.assertIsInstance(fc[k], int)
        self.assertIsInstance(fc["files"], list)

        # diffs (null by default).
        self.assertIsNone(d["diffs"])

        # council.
        c = d["council"]
        self.assertIsInstance(c["enabled"], bool)
        self.assertIsInstance(c["final_verdict"], str)
        self.assertIsInstance(c["reviewers"], list)
        self.assertIn("findings_link", c)
        for rv in c["reviewers"]:
            self.assertLessEqual(len(rv["summary"]), 300)

        # quality_gates.
        qg = d["quality_gates"]
        self.assertIsInstance(qg["passed"], int)
        self.assertIsInstance(qg["total"], int)
        self.assertIsInstance(qg["gates"], list)

        # cost.
        cost = d["cost"]
        self.assertIsInstance(cost["usd"], (int, float))
        for k in ("input_tokens", "output_tokens", "cache_read_tokens",
                  "cache_creation_tokens"):
            self.assertIsInstance(cost[k], int)

        # deployment.
        self.assertIn("deployed_url", d["deployment"])
        self.assertIsNone(d["deployment"]["public_url"])

        # redaction.
        r = d["redaction"]
        self.assertIs(r["applied"], True)
        self.assertEqual(r["rules_version"], "1.0")
        self.assertIsInstance(r["redactions_count"], int)

        # verification.
        v = d["verification"]
        self.assertIsInstance(v["hash"], str)
        self.assertEqual(v["algo"], "sha256")
        self.assertEqual(v["scope"], "integrity")

    def test_quality_gates_counts_match(self):
        loki_dir = os.path.join(self.tmp, "p2", ".loki")
        out_dir = os.path.join(self.tmp, "out2")
        self._seed_full(loki_dir)
        d = _run_generator(loki_dir, out_dir)
        # lint True, tests False -> 1 passed / 2 total.
        self.assertEqual(d["quality_gates"]["passed"], 1)
        self.assertEqual(d["quality_gates"]["total"], 2)

    def test_iterations_from_queue(self):
        loki_dir = os.path.join(self.tmp, "p3", ".loki")
        out_dir = os.path.join(self.tmp, "out3")
        self._seed_full(loki_dir)
        d = _run_generator(loki_dir, out_dir)
        self.assertEqual(d["iterations"]["succeeded"], 2)
        self.assertEqual(d["iterations"]["failed"], 1)
        self.assertGreaterEqual(d["iterations"]["count"], 3)


class IntegrityHashTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-gen-hash-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_hash_verifies_and_scope_is_integrity(self):
        loki_dir = os.path.join(self.tmp, "p", ".loki")
        out_dir = os.path.join(self.tmp, "out")
        os.makedirs(loki_dir)
        d = _run_generator(loki_dir, out_dir)
        v = d.pop("verification")
        self.assertEqual(v["scope"], "integrity")
        self.assertEqual(v["algo"], "sha256")
        recomputed = hashlib.sha256(_canonical(d).encode("utf-8")).hexdigest()
        self.assertEqual(recomputed, v["hash"],
                         "integrity hash does not verify")

    def test_tamper_breaks_hash(self):
        loki_dir = os.path.join(self.tmp, "p2", ".loki")
        out_dir = os.path.join(self.tmp, "out2")
        os.makedirs(loki_dir)
        d = _run_generator(loki_dir, out_dir)
        v = d.pop("verification")
        # Tamper with a value; recompute must NOT match the emitted hash.
        d["cost"]["usd"] = 999.99
        recomputed = hashlib.sha256(_canonical(d).encode("utf-8")).hexdigest()
        self.assertNotEqual(recomputed, v["hash"])


class IncludeDiffsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-gen-diffs-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _git_repo_with_change(self):
        proj = os.path.join(self.tmp, "gitproj")
        os.makedirs(proj)

        def git(*a):
            subprocess.run(["git", "-C", proj, "-c", "user.email=t@t.test",
                            "-c", "user.name=tester"] + list(a),
                           capture_output=True, text=True, check=True)
        git("init")
        with open(os.path.join(proj, "a.txt"), "w") as f:
            f.write("one\n")
        git("add", "a.txt")
        git("commit", "-m", "init")
        with open(os.path.join(proj, "a.txt"), "w") as f:
            f.write("one\ntwo\n")
        git("add", "a.txt")
        git("commit", "-m", "second")
        return proj

    def test_diffs_null_when_off(self):
        proj = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        os.makedirs(loki_dir)
        out_dir = os.path.join(self.tmp, "out-off")
        d = _run_generator(loki_dir, out_dir, include_diffs=False)
        self.assertIsNone(d["diffs"])
        # But the diffstat is still computed in a git repo.
        self.assertGreaterEqual(d["files_changed"]["count"], 1)

    def test_diffs_list_when_on(self):
        proj = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        os.makedirs(loki_dir)
        out_dir = os.path.join(self.tmp, "out-on")
        d = _run_generator(loki_dir, out_dir, include_diffs=True)
        self.assertIsInstance(d["diffs"], list)
        self.assertGreaterEqual(len(d["diffs"]), 1)
        for entry in d["diffs"]:
            self.assertIn("path", entry)
            self.assertIn("patch", entry)


class GracefulDegradationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-gen-degrade-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_non_git_dir_empty_files_and_uncollected_cost_and_empty_council(self):
        # A bare .loki dir with no metrics/council/queue, in a NON-git parent.
        loki_dir = os.path.join(self.tmp, "bare", ".loki")
        out_dir = os.path.join(self.tmp, "out")
        os.makedirs(loki_dir)
        # Ensure the parent is not a git repo (tmp under /var/folders is not).
        self.assertFalse(os.path.isdir(os.path.join(self.tmp, "bare", ".git")))
        d = _run_generator(loki_dir, out_dir)

        # Non-git -> empty files list and zero diffstat.
        self.assertEqual(d["files_changed"]["count"], 0)
        self.assertEqual(d["files_changed"]["files"], [])
        self.assertEqual(d["files_changed"]["insertions"], 0)
        self.assertEqual(d["files_changed"]["deletions"], 0)

        # Missing efficiency -> cost NOT collected: usd is null (not 0.0) so the
        # page reads "cost not recorded" instead of a credibility-killing $0.00.
        self.assertIsNone(d["cost"]["usd"])
        self.assertEqual(d["cost"]["input_tokens"], 0)
        self.assertEqual(d["cost"]["output_tokens"], 0)

        # Empty council -> not enabled, no reviewers.
        self.assertFalse(d["council"]["enabled"])
        self.assertEqual(d["council"]["reviewers"], [])
        self.assertEqual(d["council"]["final_verdict"], "")

        # No quality gates.
        self.assertEqual(d["quality_gates"]["total"], 0)
        self.assertEqual(d["quality_gates"]["gates"], [])

        # Still a valid, redacted, hashed artifact.
        self.assertIs(d["redaction"]["applied"], True)
        self.assertEqual(d["verification"]["scope"], "integrity")

    def test_genuine_zero_cost_stays_zero_not_null(self):
        # Efficiency file present but cost sums to 0 -> usd is 0.0 (collected),
        # NOT null. "Files existed but summed to 0" is a real, honest zero.
        loki_dir = os.path.join(self.tmp, "z", ".loki")
        out_dir = os.path.join(self.tmp, "outz")
        os.makedirs(os.path.join(loki_dir, "metrics", "efficiency"))
        with open(os.path.join(loki_dir, "metrics", "efficiency",
                               "iteration-1.json"), "w") as f:
            json.dump({"cost_usd": 0, "input_tokens": 10,
                       "output_tokens": 5}, f)
        d = _run_generator(loki_dir, out_dir)
        self.assertEqual(d["cost"]["usd"], 0.0)
        self.assertIsInstance(d["cost"]["usd"], float)
        self.assertEqual(d["cost"]["input_tokens"], 10)

    def test_empty_council_state_file(self):
        loki_dir = os.path.join(self.tmp, "c", ".loki")
        out_dir = os.path.join(self.tmp, "outc")
        os.makedirs(os.path.join(loki_dir, "council"))
        with open(os.path.join(loki_dir, "council", "state.json"), "w") as f:
            json.dump({}, f)
        d = _run_generator(loki_dir, out_dir)
        self.assertFalse(d["council"]["enabled"])
        self.assertEqual(d["council"]["reviewers"], [])

    def test_real_completion_council_shape_populates_verdict(self):
        # UAT regression: completion-council.sh writes state.json with aggregate
        # approve_votes/reject_votes and verdicts[] entries whose verdict field
        # is "result" (APPROVED/REJECTED), and it does NOT write flat
        # council/votes/*.json files. The generator must surface the council
        # outcome from THIS real shape, not leave it blank. (Previously the
        # final_verdict came out empty and the proof page showed no council,
        # blanking the central trust signal on every real run.)
        loki_dir = os.path.join(self.tmp, "rc", ".loki")
        out_dir = os.path.join(self.tmp, "outrc")
        os.makedirs(os.path.join(loki_dir, "council"))
        with open(os.path.join(loki_dir, "council", "state.json"), "w") as f:
            json.dump({
                "initialized": True, "enabled": True, "total_votes": 3,
                "approve_votes": 3, "reject_votes": 0,
                "verdicts": [{
                    "iteration": 1, "timestamp": "2026-05-30T02:01:00Z",
                    "approve": 3, "reject": 0, "result": "APPROVED",
                }],
            }, f)
        d = _run_generator(loki_dir, out_dir)
        c = d["council"]
        self.assertTrue(c["enabled"])
        self.assertEqual(c["final_verdict"], "APPROVED")
        # A populated council section: at least one reviewer/aggregate row.
        self.assertTrue(c["reviewers"], "council reviewers must not be empty")
        self.assertEqual(c["threshold"], "3/3")

    def test_real_council_reject_shape(self):
        # Same real shape but a REJECTED outcome must surface honestly.
        loki_dir = os.path.join(self.tmp, "rj", ".loki")
        out_dir = os.path.join(self.tmp, "outrj")
        os.makedirs(os.path.join(loki_dir, "council"))
        with open(os.path.join(loki_dir, "council", "state.json"), "w") as f:
            json.dump({
                "initialized": True, "enabled": True, "total_votes": 3,
                "approve_votes": 1, "reject_votes": 2,
                "verdicts": [{"iteration": 1, "approve": 1, "reject": 2,
                              "result": "REJECTED"}],
            }, f)
        d = _run_generator(loki_dir, out_dir)
        self.assertEqual(d["council"]["final_verdict"], "REJECTED")
        self.assertTrue(d["council"]["reviewers"])


if __name__ == "__main__":
    unittest.main()
