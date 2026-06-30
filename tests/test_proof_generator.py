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
        self.assertEqual(d["schema_version"], "1.1")
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


class BriefSpecTests(unittest.TestCase):
    """The raw one-liner from `loki start "<brief>"` must surface in the proof
    spec (source="brief" + verbatim text), and must NOT be picked up stale on a
    later non-brief run. Regression guard for the GAP-7 F1 fix."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-gen-brief-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_raw_brief_surfaces_in_spec(self):
        # Brief run wrote .loki/state/brief.txt and no generated-prd.md.
        loki_dir = os.path.join(self.tmp, "b", ".loki")
        out_dir = os.path.join(self.tmp, "outb")
        os.makedirs(os.path.join(loki_dir, "state"))
        with open(os.path.join(loki_dir, "state", "brief.txt"), "w") as f:
            f.write("add a multiply(a,b) function with a pytest test")
        d = _run_generator(loki_dir, out_dir)
        self.assertEqual(d["spec"]["source"], "brief")
        self.assertIn("multiply", d["spec"]["brief"])

    def test_generated_prd_wins_when_no_brief(self):
        # A non-brief run (codebase-analysis) has generated-prd.md and NO
        # brief.txt (the bash start path clears it). Spec must reflect the PRD,
        # never mislabel as "brief".
        loki_dir = os.path.join(self.tmp, "g", ".loki")
        out_dir = os.path.join(self.tmp, "outg")
        os.makedirs(os.path.join(loki_dir, "state"))
        with open(os.path.join(loki_dir, "generated-prd.md"), "w") as f:
            f.write("# Generated PRD\nReverse-engineered from code.")
        d = _run_generator(loki_dir, out_dir)
        self.assertNotEqual(d["spec"]["source"], "brief")
        self.assertTrue(d["spec"]["source"].endswith("generated-prd.md"))

    def test_prd_path_env_wins_over_brief(self):
        # An explicit PRD file always wins, even if a stale brief.txt exists.
        loki_dir = os.path.join(self.tmp, "p", ".loki")
        out_dir = os.path.join(self.tmp, "outp")
        os.makedirs(os.path.join(loki_dir, "state"))
        with open(os.path.join(loki_dir, "state", "brief.txt"), "w") as f:
            f.write("stale brief from a prior run")
        prd = os.path.join(self.tmp, "p", "real-prd.md")
        with open(prd, "w") as f:
            f.write("# Real PRD")
        d = _run_generator(loki_dir, out_dir, env_extra={"PRD_PATH": prd})
        # source is recorded as the PRD path (possibly cwd-relativized); the key
        # invariant is it is the PRD, not the stale brief.
        self.assertTrue(d["spec"]["source"].endswith("real-prd.md"))
        self.assertNotEqual(d["spec"]["source"], "brief")
        self.assertNotIn("stale brief", d["spec"]["brief"])
        self.assertIn("Real PRD", d["spec"]["brief"])

    def test_codebase_analysis_when_no_brief_no_prd(self):
        # Neither brief.txt, generated-prd.md, nor PRD_PATH -> the honest
        # codebase-analysis fallback with an empty brief.
        loki_dir = os.path.join(self.tmp, "c", ".loki")
        out_dir = os.path.join(self.tmp, "outc")
        os.makedirs(os.path.join(loki_dir, "state"))
        d = _run_generator(loki_dir, out_dir)
        self.assertEqual(d["spec"]["source"], "codebase-analysis")
        self.assertEqual(d["spec"]["brief"], "")


class HonestyHeadlineTests(unittest.TestCase):
    """v1.1 evidence model: the deterministic headline must NEVER read green
    unless real exit_code:0 test evidence + a non-empty diff are present, and
    LLM assessments (council/completion) must never flip it green on their own.

    These are the non-forgeability guarantees: a green receipt cannot be
    hand-crafted from a bare pass:true, a not-run/failed test, or an APPROVE
    verdict. Each test locks one guarantee.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-gen-honesty-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _git_repo_with_change(self):
        """A real git repo with one committed change so the diff is non-empty.
        Returns the project dir; .loki lives under it. _LOKI_ITER_START_SHA is
        set to the first commit so base..HEAD shows a real diff."""
        proj = os.path.join(self.tmp, "gitproj-%s" % os.urandom(4).hex())
        os.makedirs(proj)

        def git(*a):
            return subprocess.run(
                ["git", "-C", proj, "-c", "user.email=t@t.test",
                 "-c", "user.name=tester"] + list(a),
                capture_output=True, text=True, check=True)
        git("init")
        with open(os.path.join(proj, "a.txt"), "w") as f:
            f.write("one\n")
        git("add", "a.txt")
        git("commit", "-m", "init")
        base = git("rev-parse", "HEAD").stdout.strip()
        with open(os.path.join(proj, "a.txt"), "w") as f:
            f.write("one\ntwo\n")
        git("add", "a.txt")
        git("commit", "-m", "second")
        return proj, base

    def _write_tests(self, loki_dir, payload):
        os.makedirs(os.path.join(loki_dir, "quality"), exist_ok=True)
        with open(os.path.join(loki_dir, "quality", "test-results.json"),
                  "w") as f:
            json.dump(payload, f)

    def _write_build(self, loki_dir, payload):
        os.makedirs(os.path.join(loki_dir, "quality"), exist_ok=True)
        with open(os.path.join(loki_dir, "quality", "build-results.json"),
                  "w") as f:
            json.dump(payload, f)

    # --- Guarantee 1: not-run tests never read green --------------------
    def test_not_run_tests_never_verified(self):
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out1")
        os.makedirs(loki_dir)
        # No test-results.json at all -> tests not_run.
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        self.assertEqual(d["facts"]["tests"]["status"], "not_run")
        self.assertNotEqual(d["honesty"]["headline"], "VERIFIED")
        self.assertIn(d["honesty"]["headline"],
                      ("NOT VERIFIED", "VERIFIED WITH GAPS"))
        # The tests gap must appear in degraded[] with a reason.
        items = {x["item"]: x for x in d["honesty"]["degraded"]}
        self.assertIn("tests", items)
        self.assertEqual(items["tests"]["status"], "not_run")
        self.assertTrue(items["tests"]["reason"])

    def test_diff_only_no_checks_is_not_verified(self):
        # Regression (wave-9 CRITICAL): a build that produced a real non-empty
        # diff but ran NO tests, NO build, and passed NO gates must read
        # NOT VERIFIED -- never "VERIFIED WITH GAPS". A non-empty diff is a
        # PREREQUISITE for VERIFIED, not a positive fact of passage; code was
        # written but nothing was shown to pass. Previously diff_nonempty was
        # counted as a verified fact, letting a checks-free build read amber-green.
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out-diffonly")
        os.makedirs(loki_dir)
        # No test-results.json, no build-results.json, no quality gates: only the
        # real non-empty diff exists.
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        self.assertEqual(d["facts"]["tests"]["status"], "not_run")
        self.assertTrue((d["facts"]["git"]["diff"] or {}).get("count"),
                        "fixture must have a non-empty diff to exercise the bug")
        self.assertEqual(
            d["honesty"]["headline"], "NOT VERIFIED",
            "a diff-only build with no passing checks must be NOT VERIFIED, "
            "not VERIFIED WITH GAPS (the wave-9 fake-green)")

    def test_bare_pass_true_without_command_not_verified(self):
        # OLD shape {pass: true} maps tests.status -> verified, but the headline
        # additionally requires a real command + exit_code 0. A bare pass:true
        # must NOT produce a green headline.
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out1b")
        os.makedirs(loki_dir)
        self._write_tests(loki_dir, {"pass": True, "runner": "pytest"})
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        # status maps to verified, but no command + no exit_code 0.
        self.assertEqual(d["facts"]["tests"]["status"], "verified")
        self.assertEqual(d["facts"]["tests"]["command"], "")
        self.assertNotEqual(d["honesty"]["headline"], "VERIFIED")

    # --- Guarantee 2: failed tests never read green --------------------
    def test_failed_tests_not_verified(self):
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out2")
        os.makedirs(loki_dir)
        self._write_tests(loki_dir, {
            "runner": "pytest", "command": "pytest -q",
            "exit_code": 1, "status": "failed",
            "passed_count": 3, "failed_count": 1})
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        self.assertEqual(d["facts"]["tests"]["status"], "failed")
        self.assertNotEqual(d["honesty"]["headline"], "VERIFIED")

    def test_nonzero_exit_code_not_verified(self):
        # No explicit status but exit_code != 0 -> failed.
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out2b")
        os.makedirs(loki_dir)
        self._write_tests(loki_dir, {
            "runner": "pytest", "command": "pytest -q", "exit_code": 2})
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        self.assertEqual(d["facts"]["tests"]["status"], "failed")
        self.assertNotEqual(d["honesty"]["headline"], "VERIFIED")

    # --- Guarantee 3: all-green reads VERIFIED -------------------------
    def test_all_green_is_verified(self):
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out3")
        os.makedirs(loki_dir)
        self._write_tests(loki_dir, {
            "runner": "pytest", "command": "pytest -q",
            "exit_code": 0, "status": "verified",
            "passed_count": 10, "failed_count": 0})
        # A green headline requires NO degraded facts, so the build must have
        # run and passed too (an absent build is reported as a not_run gap).
        self._write_build(loki_dir, {
            "command": "make build", "ran": True, "exit_code": 0,
            "duration_sec": 1.0})
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        self.assertEqual(d["facts"]["build"]["status"], "verified")
        self.assertEqual(d["facts"]["tests"]["status"], "verified")
        self.assertEqual(d["facts"]["tests"]["exit_code"], 0)
        self.assertTrue(d["facts"]["tests"]["command"])
        self.assertGreaterEqual(d["facts"]["git"]["diff"]["count"], 1)
        self.assertEqual(d["honesty"]["degraded"], [],
                         "no degraded items expected for an all-green run")
        self.assertEqual(d["honesty"]["headline"], "VERIFIED")

    def test_all_green_but_empty_diff_not_verified(self):
        # Tests green but NO file changes -> git.diff degraded -> not VERIFIED.
        # Use a non-git dir so the diff is empty (count 0).
        loki_dir = os.path.join(self.tmp, "nogit", ".loki")
        out_dir = os.path.join(self.tmp, "out3b")
        os.makedirs(loki_dir)
        self._write_tests(loki_dir, {
            "runner": "pytest", "command": "pytest -q",
            "exit_code": 0, "status": "verified"})
        d = _run_generator(loki_dir, out_dir)
        self.assertEqual(d["facts"]["git"]["diff"]["count"], 0)
        self.assertNotEqual(d["honesty"]["headline"], "VERIFIED")
        items = {x["item"]: x for x in d["honesty"]["degraded"]}
        self.assertIn("git.diff", items)

    # --- Guarantee 4: assessments never flip the headline green --------
    def test_council_approve_does_not_make_verified(self):
        # An LLM APPROVE council verdict + claimed completion, but tests NOT run.
        # The headline must stay NOT VERIFIED: opinions are not proof.
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out4")
        os.makedirs(os.path.join(loki_dir, "council"))
        os.makedirs(os.path.join(loki_dir, "state"))
        with open(os.path.join(loki_dir, "council", "state.json"), "w") as f:
            json.dump({"enabled": True, "approve_votes": 3, "reject_votes": 0,
                       "verdicts": [{"result": "APPROVED"}]}, f)
        with open(os.path.join(loki_dir, "state", "completion.json"), "w") as f:
            json.dump({"completed": True, "outcome": "complete"}, f)
        # No test-results.json -> tests not_run.
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        # The council/completion live under assessments, labeled not-proof.
        self.assertIn("_note", d["assessments"])
        self.assertIn("not deterministic proof", d["assessments"]["_note"])
        self.assertEqual(d["assessments"]["council"]["final_verdict"],
                         "APPROVED")
        self.assertTrue(d["assessments"]["completion_claim"]["claimed"])
        # Despite the APPROVE + claimed completion, the headline stays not green.
        self.assertEqual(d["facts"]["tests"]["status"], "not_run")
        self.assertNotEqual(d["honesty"]["headline"], "VERIFIED")

    def test_council_lives_under_assessments_not_facts(self):
        # Council must be an assessment, never a fact. facts{} must not carry it.
        loki_dir = os.path.join(self.tmp, "as", ".loki")
        out_dir = os.path.join(self.tmp, "out4b")
        os.makedirs(os.path.join(loki_dir, "council"))
        with open(os.path.join(loki_dir, "council", "state.json"), "w") as f:
            json.dump({"enabled": True, "approve_votes": 3, "reject_votes": 0,
                       "verdicts": [{"result": "APPROVED"}]}, f)
        d = _run_generator(loki_dir, out_dir)
        self.assertIn("council", d["assessments"])
        self.assertNotIn("council", d["facts"])

    # --- Guarantee 5: back-compat mirror keys still present ------------
    def test_back_compat_mirror_keys_present(self):
        # Old (schema v1.0) readers parse the flat top-level keys. They must
        # remain present alongside the additive facts/assessments/honesty.
        loki_dir = os.path.join(self.tmp, "bc", ".loki")
        out_dir = os.path.join(self.tmp, "out5")
        os.makedirs(loki_dir)
        d = _run_generator(loki_dir, out_dir)
        for k in ("files_changed", "council", "quality_gates", "cost",
                  "provider", "iterations", "spec", "deployment",
                  "wall_clock_sec", "loki_version", "run_id"):
            self.assertIn(k, d, "back-compat key %r missing" % k)
        # And the new additive blocks are also present.
        for k in ("facts", "assessments", "honesty"):
            self.assertIn(k, d)

    def test_facts_cost_mirror_consistent_with_top_level(self):
        # facts.cost is re-pointed at the capped top-level cost (generator
        # ordering): the two must be identical so the receipt is consistent.
        loki_dir = os.path.join(self.tmp, "fc", ".loki")
        out_dir = os.path.join(self.tmp, "out5b")
        os.makedirs(os.path.join(loki_dir, "metrics", "efficiency"))
        with open(os.path.join(loki_dir, "metrics", "efficiency",
                               "iteration-1.json"), "w") as f:
            json.dump({"cost_usd": 2.5, "input_tokens": 100,
                       "output_tokens": 20}, f)
        d = _run_generator(loki_dir, out_dir)
        self.assertEqual(d["facts"]["cost"], d["cost"])

    # --- Guarantee 9: redaction still gates emission ------------------
    def test_redaction_applied_flag_present(self):
        # The generator refuses to emit without redaction; the emitted proof
        # always carries redaction.applied True. (A returncode 0 with a written
        # proof.json is itself proof the chokepoint ran.)
        loki_dir = os.path.join(self.tmp, "rd", ".loki")
        out_dir = os.path.join(self.tmp, "out9")
        os.makedirs(loki_dir)
        d = _run_generator(loki_dir, out_dir)
        self.assertIs(d["redaction"]["applied"], True)
        self.assertIsInstance(d["redaction"]["redactions_count"], int)


    def test_failed_tests_listed_in_degraded_and_red(self):
        # cH_r1 (v7.85.0): a FAILED test must render NOT VERIFIED (red), never an
        # amber "VERIFIED WITH GAPS", AND must appear in honesty.degraded so the
        # banner's "items below" is not empty. A failed check is stronger than a
        # not-run one; conflating them understates the failure.
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out_failed")
        os.makedirs(os.path.join(loki_dir, "quality"))
        # Seed a FAILED test result (a runner that ran and failed).
        with open(os.path.join(loki_dir, "quality", "test-results.json"), "w") as f:
            json.dump({"runner": "pytest", "pass": False, "summary": "1 failed",
                       "command": "pytest", "exit_code": 1, "status": "failed",
                       "passed_count": 0, "failed_count": 1}, f)
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        # A failed test is RED, never amber, never green.
        self.assertEqual(d["honesty"]["headline"], "NOT VERIFIED")
        # And it is listed explicitly in the honesty ledger.
        items = {x["item"]: x for x in d["honesty"]["degraded"]}
        self.assertIn("tests", items)
        self.assertEqual(items["tests"]["status"], "failed")


class SecurityHonestyTests(unittest.TestCase):
    """Secure-by-default gate honesty (Loop 4): the Evidence Receipt must tell
    the truth about the security scan and must never green-wash an app that
    ships a known-bad pattern.

    Contract (deterministic, derived only from .loki/quality/security-findings
    .json -- a pattern-scan FACT, not an LLM opinion):
      - an ACTIVE (un-waived) HIGH finding -> headline NOT VERIFIED AND
        "security" appears in honesty.degraded (a verified-NO, not an amber gap).
      - the SAME finding WAIVED -> not a gap; with otherwise-green evidence the
        headline can read VERIFIED (the user accepted it with intent, recorded).
      - no security file at all -> not run, not a gap (silence is honest here:
        the gate did not run, so it is neither a pass nor a fail for security).
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-gen-sec-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _git_repo_with_change(self):
        """A real git repo with one committed change so the diff is non-empty.
        Returns (proj_dir, base_sha). Mirrors HonestyHeadlineTests."""
        proj = os.path.join(self.tmp, "gitproj-%s" % os.urandom(4).hex())
        os.makedirs(proj)

        def git(*a):
            return subprocess.run(
                ["git", "-C", proj, "-c", "user.email=t@t.test",
                 "-c", "user.name=tester"] + list(a),
                capture_output=True, text=True, check=True)
        git("init")
        with open(os.path.join(proj, "a.txt"), "w") as f:
            f.write("one\n")
        git("add", "a.txt")
        git("commit", "-m", "init")
        base = git("rev-parse", "HEAD").stdout.strip()
        with open(os.path.join(proj, "a.txt"), "w") as f:
            f.write("one\ntwo\n")
        git("add", "a.txt")
        git("commit", "-m", "second")
        return proj, base

    def _write_green_tests_and_build(self, loki_dir):
        """Seed verified tests + a passing build so the ONLY remaining gap is
        whatever the security fact contributes -- isolates the security signal."""
        os.makedirs(os.path.join(loki_dir, "quality"), exist_ok=True)
        with open(os.path.join(loki_dir, "quality", "test-results.json"),
                  "w") as f:
            json.dump({"runner": "pytest", "command": "pytest -q",
                       "exit_code": 0, "status": "verified",
                       "passed_count": 5, "failed_count": 0}, f)
        with open(os.path.join(loki_dir, "quality", "build-results.json"),
                  "w") as f:
            json.dump({"command": "make build", "ran": True,
                       "exit_code": 0, "duration_sec": 1.0}, f)

    def _write_security(self, loki_dir, findings):
        os.makedirs(os.path.join(loki_dir, "quality"), exist_ok=True)
        total = len(findings)
        by_sev = {}
        for f in findings:
            sev = str(f.get("severity", "")).upper()
            by_sev[sev] = by_sev.get(sev, 0) + 1
        doc = {"rules_version": "1.0", "findings": findings,
               "summary": {"total": total, "by_severity": by_sev}}
        with open(os.path.join(loki_dir, "quality",
                               "security-findings.json"), "w") as f:
            json.dump(doc, f)

    # --- active un-waived HIGH -> NOT VERIFIED + in degraded ---------------
    def test_active_high_finding_is_not_verified_and_degraded(self):
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out-sec-active")
        os.makedirs(loki_dir)
        # Otherwise all-green, so the security finding is the ONLY signal.
        self._write_green_tests_and_build(loki_dir)
        self._write_security(loki_dir, [{
            "rule": "private-key-committed", "file": "leak.pem", "line": 1,
            "severity": "HIGH",
            "message": "A PEM private key block is present in this file.",
            "fix": "Remove the key and rotate it.", "waived": False}])
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        # An un-waived HIGH is a verified-NO: red, never green, never amber-only.
        self.assertEqual(d["honesty"]["headline"], "NOT VERIFIED")
        # The security gap is surfaced explicitly in the honesty ledger.
        items = {x["item"]: x for x in d["honesty"]["degraded"]}
        self.assertIn("security", items)
        self.assertEqual(items["security"]["status"], "findings")
        self.assertTrue(items["security"]["reason"])
        # And the fact is recorded: scan ran, 1 active HIGH, 0 waived.
        sec = d["facts"]["security"]
        self.assertTrue(sec["ran"])
        self.assertEqual(sec["high_active"], 1)
        self.assertEqual(sec["active"], 1)
        self.assertEqual(sec["waived"], 0)
        self.assertEqual(sec["status"], "findings")

    # --- the SAME HIGH waived -> not a gap; headline can be VERIFIED -------
    def test_waived_high_finding_is_not_a_gap(self):
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out-sec-waived")
        os.makedirs(loki_dir)
        self._write_green_tests_and_build(loki_dir)
        # Identical finding, but waived (accepted with intent).
        self._write_security(loki_dir, [{
            "rule": "private-key-committed", "file": "leak.pem", "line": 1,
            "severity": "HIGH",
            "message": "A PEM private key block is present in this file.",
            "fix": "Remove the key and rotate it.", "waived": True}])
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        # A waived finding is NOT a gap: it must not appear in degraded.
        items = {x["item"]: x for x in d["honesty"]["degraded"]}
        self.assertNotIn("security", items,
                         "a waived finding must not be reported as a gap")
        # The fact records it as waived, not active.
        sec = d["facts"]["security"]
        self.assertTrue(sec["ran"])
        self.assertEqual(sec["high_active"], 0)
        self.assertEqual(sec["active"], 0)
        self.assertEqual(sec["waived"], 1)
        self.assertEqual(sec["status"], "clean")
        # With everything else green and no gap, the headline can read VERIFIED.
        self.assertEqual(d["honesty"]["degraded"], [],
                         "no gaps expected: a waived finding is accepted")
        self.assertEqual(d["honesty"]["headline"], "VERIFIED")

    # --- no security file -> not run, not a gap ---------------------------
    def test_no_security_file_is_not_a_gap(self):
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out-sec-absent")
        os.makedirs(loki_dir)
        self._write_green_tests_and_build(loki_dir)
        # Deliberately do NOT write security-findings.json.
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        # Absence of a scan is not a security gap (the gate did not run).
        items = {x["item"]: x for x in d["honesty"]["degraded"]}
        self.assertNotIn("security", items,
                         "no scan is not_run, not a gap")
        sec = d["facts"]["security"]
        self.assertFalse(sec["ran"])
        self.assertEqual(sec["status"], "not_run")
        self.assertEqual(sec["high_active"], 0)

    # --- a MEDIUM active finding is NOT a hard-fail (only HIGH gates) ------
    def test_active_medium_does_not_force_not_verified(self):
        # The gate's hard-fail signal is an un-waived HIGH. A MEDIUM finding
        # (e.g. debug-in-prod / cors-wildcard-credentials) is recorded but does
        # NOT force NOT VERIFIED -- locking that the headline keys off high_active
        # specifically, not any active finding.
        proj, base = self._git_repo_with_change()
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(self.tmp, "out-sec-medium")
        os.makedirs(loki_dir)
        self._write_green_tests_and_build(loki_dir)
        self._write_security(loki_dir, [{
            "rule": "debug-in-prod", "file": "settings.py", "line": 1,
            "severity": "MEDIUM",
            "message": "Debug mode is enabled in a production config.",
            "fix": "Set debug to False for production.", "waived": False}])
        d = _run_generator(loki_dir, out_dir,
                           env_extra={"_LOKI_ITER_START_SHA": base})
        sec = d["facts"]["security"]
        self.assertTrue(sec["ran"])
        self.assertEqual(sec["high_active"], 0)
        self.assertEqual(sec["active"], 1)
        # No HIGH -> security is not a hard-fail and not in the degraded ledger.
        items = {x["item"]: x for x in d["honesty"]["degraded"]}
        self.assertNotIn("security", items)
        self.assertEqual(d["honesty"]["headline"], "VERIFIED")


class LokiVersionResolutionTests(unittest.TestCase):
    """Regression for the runtime-path proof loki_version="unknown" bug (F51).

    In a real `loki start` build, run.sh's generate_proof_of_run wrapper passes
    --loki-version "$(get_version || echo unknown)", but get_version is not
    defined in run.sh's process, so the literal sentinel "unknown" reaches the
    generator. The generator must NOT report "unknown": it self-locates the
    VERSION shipped beside it (autonomy/lib/proof-generator.py -> ../../VERSION),
    so the receipt shows the installed version even when the target app dir has
    no VERSION file and orchestrator.json carries no version.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-gen-version-")
        # The real installed version this generator ships beside.
        self.real_version = open(
            os.path.join(_REPO, "VERSION")
        ).read().strip()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_minimal_no_version(self, loki_dir):
        """A user app dir: no VERSION file, orchestrator.json without version."""
        os.makedirs(os.path.join(loki_dir, "state"))
        os.makedirs(os.path.join(loki_dir, "queue"))
        with open(os.path.join(loki_dir, "state",
                               "orchestrator.json"), "w") as f:
            json.dump({"startedAt": "2026-06-20T00:00:00Z"}, f)
        # Sanity: the app dir really has no VERSION (this is the user scenario).
        target_dir = os.path.dirname(loki_dir)
        self.assertFalse(os.path.exists(os.path.join(target_dir, "VERSION")))

    def test_runtime_unknown_sentinel_resolves_to_real_version(self):
        loki_dir = os.path.join(self.tmp, "userapp", ".loki")
        out_dir = os.path.join(self.tmp, "out")
        self._seed_minimal_no_version(loki_dir)
        # Simulate the exact runtime wrapper behavior: --loki-version "unknown".
        d = _run_generator(loki_dir, out_dir, loki_version="unknown")
        self.assertNotEqual(d["loki_version"], "unknown")
        self.assertEqual(d["loki_version"], self.real_version)
        # v1.1 facts mirror must agree.
        self.assertEqual(d["facts"]["meta"]["loki_version"], self.real_version)

    def test_empty_arg_also_resolves_to_real_version(self):
        loki_dir = os.path.join(self.tmp, "userapp2", ".loki")
        out_dir = os.path.join(self.tmp, "out2")
        self._seed_minimal_no_version(loki_dir)
        d = _run_generator(loki_dir, out_dir, loki_version="")
        self.assertEqual(d["loki_version"], self.real_version)

    def test_explicit_version_arg_still_wins(self):
        # A real, non-sentinel --loki-version must still take precedence.
        loki_dir = os.path.join(self.tmp, "userapp3", ".loki")
        out_dir = os.path.join(self.tmp, "out3")
        self._seed_minimal_no_version(loki_dir)
        d = _run_generator(loki_dir, out_dir, loki_version="9.9.9")
        self.assertEqual(d["loki_version"], "9.9.9")

    def test_orchestrator_version_wins_over_self_version(self):
        # When orchestrator.json records a version and the arg is the sentinel,
        # the recorded run version is used (not the self-located fallback).
        loki_dir = os.path.join(self.tmp, "userapp4", ".loki")
        out_dir = os.path.join(self.tmp, "out4")
        os.makedirs(os.path.join(loki_dir, "state"))
        os.makedirs(os.path.join(loki_dir, "queue"))
        with open(os.path.join(loki_dir, "state",
                               "orchestrator.json"), "w") as f:
            json.dump({"startedAt": "2026-06-20T00:00:00Z",
                       "version": "7.0.0"}, f)
        d = _run_generator(loki_dir, out_dir, loki_version="unknown")
        self.assertEqual(d["loki_version"], "7.0.0")


if __name__ == "__main__":
    unittest.main()
