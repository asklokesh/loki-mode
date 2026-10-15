"""tests/test_proof_verify.py -- deterministic proof re-verifier behavior.

Companion to test_proof_generator.py. The generator emits proof.json with an
integrity hash AND a recorded git base/head + diff. proof-verify.py re-checks
that receipt against the live repo so a skeptic can prove the facts are STILL
TRUE, not merely that the JSON bytes are unaltered.

These tests lock the non-forgeability guarantees of the verifier:
  - TAMPER: flip one byte of a non-hash field -> exit 1 / ok:false. Untouched
    proof -> exit 0 / ok:true.
  - DRIFT: record base_sha, add a commit, re-verify -> drift detected.
  - HONESTY: an unresolvable base ref -> ok:false with a base-ref reason, never
    a silent pass.

Both the generator and verifier have hyphenated filenames (not importable as
modules), so they are driven as subprocesses exactly as run.sh / the CLI do.

KNOWN BUG (BUG-DIFFSHA), flagged to the integrator before ship:
  proof-generator._diff_sha256() records facts.git.diff_sha256 as the sha256 of
  the canonical diff STAT object {count,insertions,deletions,files}. But
  proof-verify.py recomputes it as the sha256 of the FULL git patch TEXT
  (_full_diff). Those two inputs differ, so the hashes never match and the
  verifier reports diff_drift True / ok False on EVERY untampered, unchanged
  v1.1 proof. The central drift re-check is therefore non-functional. The fix
  belongs in proof-verify.py: re-derive the stat with _numstat (already used
  for the counts) plus the file list, build the same canonical object the
  generator hashes, and sha256 that -- NOT the raw patch. The three tests below
  marked @unittest.expectedFailure encode the post-fix contract; remove the
  marker once proof-verify.py is corrected and they will pass (an unexpected
  success will fail the suite, forcing the marker removal).
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_GENERATOR = os.path.join(_REPO, "autonomy", "lib", "proof-generator.py")
_VERIFIER = os.path.join(_REPO, "autonomy", "lib", "proof-verify.py")


def _load_verifier_module():
    """Import proof-verify.py in-process (hyphenated filename, not a normal
    import) so render_reasons() can be exercised directly on a result dict,
    the same pattern tests/test-proof-verify-human.sh uses for the CLI."""
    spec = importlib.util.spec_from_file_location("proof_verify_mod", _VERIFIER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _git(proj, *a, check=True):
    return subprocess.run(
        ["git", "-C", proj, "-c", "user.email=t@t.test",
         "-c", "user.name=tester"] + list(a),
        capture_output=True, text=True, check=check)


def _run_verifier(proof_path, repo_dir):
    """Run proof-verify.py as a subprocess. Returns (returncode, result_dict).

    The CLI prints a JSON result and exits 0 (ok) / 1 (tamper or drift or bad
    sig) / 2 (load error)."""
    r = subprocess.run(
        [sys.executable, _VERIFIER, proof_path, repo_dir],
        capture_output=True, text=True, timeout=60)
    try:
        result = json.loads(r.stdout)
    except json.JSONDecodeError:
        result = {"_raw_stdout": r.stdout, "_stderr": r.stderr}
    return r.returncode, result


def _load_json(path):
    with open(path) as handle:
        return json.load(handle)


def _run_generator(loki_dir, out_dir, *, env_extra=None, include_diffs=False,
                   run_id="verify-fixed-001", loki_version="7.9.0",
                   session_exit_code=None):
    cmd = [sys.executable, _GENERATOR, "--loki-dir", loki_dir,
           "--out-dir", out_dir, "--run-id", run_id,
           "--loki-version", loki_version, "--quiet"]
    if include_diffs:
        cmd.append("--include-diffs")
    if session_exit_code is not None:
        cmd.extend(["--session-exit-code", str(session_exit_code)])
    env = dict(os.environ)
    env.pop("PRD_PATH", None)
    env.pop("LOKI_SESSION_ID", None)
    env.pop("LOKI_DEPLOYED_URL", None)
    if env_extra:
        env.update(env_extra)
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 0, "generator failed: %s" % r.stderr
    return os.path.join(out_dir, "proof.json")


class _GitFixtureMixin:
    """Builds a real git repo with one committed change and a .loki dir, then
    generates a proof recording the real base_sha so the verifier can re-derive
    the diff. Returns (proj, base_sha, proof_path)."""

    def _make_proj_and_proof(self, *, include_diffs=False):
        proj = os.path.join(self.tmp, "gp-%s" % os.urandom(4).hex())
        os.makedirs(proj)
        _git(proj, "init")
        with open(os.path.join(proj, "a.txt"), "w") as f:
            f.write("one\n")
        _git(proj, "add", "a.txt")
        _git(proj, "commit", "-m", "init")
        base = _git(proj, "rev-parse", "HEAD").stdout.strip()
        with open(os.path.join(proj, "a.txt"), "w") as f:
            f.write("one\ntwo\nthree\n")
        _git(proj, "add", "a.txt")
        _git(proj, "commit", "-m", "second")

        loki_dir = os.path.join(proj, ".loki")
        os.makedirs(loki_dir)
        out_dir = os.path.join(loki_dir, "proofs", "verify-fixed-001")
        proof_path = _run_generator(
            loki_dir, out_dir,
            env_extra={"_LOKI_RUN_START_SHA": base},
            include_diffs=include_diffs)
        return proj, base, proof_path


class TamperTests(_GitFixtureMixin, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-verify-tamper-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_untampered_proof_passes(self):
        proj, base, proof_path = self._make_proj_and_proof()
        # Sanity: the receipt recorded the base sha so drift is verifiable.
        proof = _load_json(proof_path)
        self.assertEqual(proof["facts"]["git"]["base_sha"], base)
        rc, res = _run_verifier(proof_path, proj)
        self.assertEqual(rc, 0, "unmodified proof should verify: %s" % res)
        self.assertTrue(res["ok"])
        self.assertTrue(res["hash_ok"])
        self.assertIs(res["diff_drift"], False)

    def test_tampered_nonhash_field_fails(self):
        # Flip one byte of a non-hash field (cost.usd) WITHOUT touching the
        # recorded verification.hash. The re-canonicalized hash must mismatch.
        proj, base, proof_path = self._make_proj_and_proof()
        proof = _load_json(proof_path)
        original_hash = proof["verification"]["hash"]
        proof.setdefault("cost", {})["usd"] = 99999.99
        # Leave verification.hash untouched (the forger edits a fact only).
        self.assertEqual(proof["verification"]["hash"], original_hash)
        with open(proof_path, "w") as f:
            json.dump(proof, f, indent=2)
        rc, res = _run_verifier(proof_path, proj)
        self.assertEqual(rc, 1, "tampered proof must exit 1: %s" % res)
        self.assertFalse(res["ok"])
        self.assertFalse(res["hash_ok"])
        self.assertIn("hash mismatch", res["reason"])

    def test_tampered_diff_count_fails(self):
        # Edit the recorded diff count so it overstates the work. Even if a
        # forger recomputed the hash, the live-repo drift check would catch it;
        # here we only edit the count, so the hash mismatch catches it first.
        proj, base, proof_path = self._make_proj_and_proof()
        proof = _load_json(proof_path)
        proof["facts"]["git"]["diff"]["count"] = 999
        with open(proof_path, "w") as f:
            json.dump(proof, f, indent=2)
        rc, res = _run_verifier(proof_path, proj)
        self.assertEqual(rc, 1)
        self.assertFalse(res["ok"])


class DriftTests(_GitFixtureMixin, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-verify-drift-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_drift_detected_after_new_commit(self):
        # Generate a valid proof, then add another commit so the live
        # base..HEAD diff no longer matches the recorded diff. The hash is still
        # valid (we did not touch proof.json), but the FACTS drifted.
        # GENUINE drift (the tree IS available and DOES show unauthorized
        # changes) must still exit 1, not 2 -- BACKLOG 31 only reclassifies the
        # UNVERIFIABLE case (see HonestyTests below), it must not weaken this.
        proj, base, proof_path = self._make_proj_and_proof()
        # Confirm clean before drift.
        rc0, res0 = _run_verifier(proof_path, proj)
        self.assertEqual(rc0, 0, "baseline must be clean: %s" % res0)

        with open(os.path.join(proj, "b.txt"), "w") as f:
            f.write("a brand new file the receipt never saw\n")
        _git(proj, "add", "b.txt")
        _git(proj, "commit", "-m", "drift")

        rc, res = _run_verifier(proof_path, proj)
        self.assertEqual(rc, 1, "drift must exit 1: %s" % res)
        self.assertFalse(res["ok"])
        # Hash is intact (proof.json unedited) but drift is detected.
        self.assertTrue(res["hash_ok"])
        self.assertIs(res["diff_drift"], True)
        self.assertIn("drift", res["reason"])

    def test_no_drift_when_repo_unchanged(self):
        proj, base, proof_path = self._make_proj_and_proof()
        rc, res = _run_verifier(proof_path, proj)
        self.assertEqual(rc, 0)
        self.assertIs(res["diff_drift"], False)

    def test_worktree_proof_passes_then_same_stat_content_drift_fails(self):
        proj = os.path.join(self.tmp, "worktree")
        os.makedirs(proj)
        _git(proj, "init")
        with open(os.path.join(proj, "a.txt"), "w") as handle:
            handle.write("base\n")
        _git(proj, "add", "a.txt")
        _git(proj, "commit", "-m", "baseline")
        base = _git(proj, "rev-parse", "HEAD").stdout.strip()
        with open(os.path.join(proj, "a.txt"), "w") as handle:
            handle.write("first\n")
        with open(os.path.join(proj, "new.txt"), "w") as handle:
            handle.write("new\n")
        loki_dir = os.path.join(proj, ".loki")
        out_dir = os.path.join(loki_dir, "proofs", "worktree")
        os.makedirs(loki_dir)
        proof_path = _run_generator(
            loki_dir, out_dir, env_extra={"_LOKI_RUN_START_SHA": base}
        )

        rc, result = _run_verifier(proof_path, proj)
        self.assertEqual(rc, 0, result)
        self.assertIs(result["diff_drift"], False)
        self.assertIs(result["tree_drift"], False)

        with open(os.path.join(proj, "a.txt"), "w") as handle:
            handle.write("other\n")
        rc, result = _run_verifier(proof_path, proj)
        self.assertEqual(rc, 1, result)
        self.assertIs(result["tree_drift"], True)


class HonestyTests(_GitFixtureMixin, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-verify-honesty-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_unresolvable_base_ref_does_not_pass(self):
        # A valid (hash-intact) proof whose recorded base_sha does not exist in
        # the repo: drift is unverifiable. The verifier must NOT pass -- it
        # reports diff_drift None, ok False, with a base-ref reason. This is an
        # INABILITY TO MEASURE, not evidence of tampering, so it exits 2
        # (could not check) per docs/exit-codes.md, not 1 (failed/tampered).
        # BACKLOG 31.
        proj, base, proof_path = self._make_proj_and_proof()
        proof = _load_json(proof_path)
        # Rewrite base_sha to a non-existent (but well-formed) sha, then re-sign
        # so the hash check passes and ONLY the base-ref honesty path is tested.
        proof["facts"]["git"]["base_sha"] = "0" * 40
        proof = _resign(proof)
        with open(proof_path, "w") as f:
            json.dump(proof, f, indent=2)
        rc, res = _run_verifier(proof_path, proj)
        self.assertEqual(rc, 2, "unverifiable base must exit 2, not 1: %s" % res)
        self.assertFalse(res["ok"])
        self.assertTrue(res["hash_ok"], "hash should still verify after resign")
        self.assertIsNone(res["diff_drift"])
        self.assertIn("base ref", res["reason"])
        self.assertIn("could not check", res["reason"])
        self.assertNotIn("tamper", res["reason"])
        for r in res["reasons"]:
            self.assertNotIn("tamper", r)
        mod = _load_verifier_module()
        rendered = mod.render_reasons(res)
        self.assertTrue(rendered.startswith("COULD NOT CHECK"))
        self.assertNotIn("tamper", rendered)

    def test_missing_base_sha_does_not_pass(self):
        # A v1.0-style proof with no recorded base_sha: drift cannot be
        # re-derived. Re-sign after stripping so only the missing-base path is
        # exercised (not a hash failure). Unmeasurable, not tampered: exit 2.
        proj, base, proof_path = self._make_proj_and_proof()
        proof = _load_json(proof_path)
        proof["facts"]["git"]["base_sha"] = ""
        proof = _resign(proof)
        with open(proof_path, "w") as f:
            json.dump(proof, f, indent=2)
        rc, res = _run_verifier(proof_path, proj)
        self.assertEqual(rc, 2)
        self.assertFalse(res["ok"])
        self.assertIsNone(res["diff_drift"])
        self.assertIn("base ref", res["reason"])
        self.assertIn("could not check", res["reason"])
        self.assertNotIn("tamper", res["reason"])
        for r in res["reasons"]:
            self.assertNotIn("tamper", r)

    def test_non_git_repo_dir_does_not_pass(self):
        # Point the verifier at a non-git dir: drift unverifiable, not a pass,
        # and not a tamper finding either -- exit 2 (could not check).
        proj, base, proof_path = self._make_proj_and_proof()
        nongit = os.path.join(self.tmp, "nongit")
        os.makedirs(nongit)
        rc, res = _run_verifier(proof_path, nongit)
        self.assertEqual(rc, 2)
        self.assertFalse(res["ok"])
        self.assertIsNone(res["diff_drift"])
        self.assertIn("could not check", res["reason"])
        self.assertNotIn("tamper", res["reason"])
        for r in res["reasons"]:
            self.assertNotIn("tamper", r)
        mod = _load_verifier_module()
        rendered = mod.render_reasons(res)
        self.assertTrue(rendered.startswith("COULD NOT CHECK"))
        self.assertNotIn("tamper", rendered)
        self.assertIn("could not check", res["reason"])
        self.assertNotIn("tamper", res["reason"])

    def test_genuine_tree_drift_with_unresolvable_base_still_exits_1(self):
        # A second laundering control: the recorded base_sha is unresolvable
        # (diff drift genuinely CANNOT be checked), but the workspace tree WAS
        # recorded and the working tree has since been altered -- a real,
        # measurable unauthorized change via the tree check. "could not check
        # diff drift" must not rescue this into exit 2: tree_drift True still
        # forces exit 1. This is the "tree available, shows unauthorized
        # changes, drift check unverifiable" case BACKLOG 31 says must not be
        # weakened.
        proj, base, proof_path = self._make_proj_and_proof()
        proof = _load_json(proof_path)
        self.assertTrue(proof["facts"]["git"].get("tree_sha256"),
                         "fixture must record a tree digest for this test")
        proof["facts"]["git"]["base_sha"] = "0" * 40
        proof = _resign(proof)
        with open(proof_path, "w") as f:
            json.dump(proof, f, indent=2)

        # Real tamper: alter the working tree after the receipt was generated.
        with open(os.path.join(proj, "a.txt"), "w") as f:
            f.write("an unauthorized edit the receipt never saw\n")

        rc, res = _run_verifier(proof_path, proj)
        self.assertEqual(
            rc, 1,
            "genuine tree drift must not be laundered into exit 2 just "
            "because the base_sha diff check is separately unverifiable: %s"
            % res)
        self.assertFalse(res["ok"])
        self.assertTrue(res["hash_ok"])
        self.assertIsNone(res["diff_drift"], "diff drift is genuinely unverifiable here")
        self.assertIs(res["tree_drift"], True)

    def test_genuine_tamper_with_unverifiable_repo_still_exits_1(self):
        # Laundering control (BACKLOG 31): a proof with a REAL hash mismatch
        # (tampered) must exit 1 even when pointed at a repo_dir where drift
        # also cannot be checked. "could not check drift" must never rescue an
        # otherwise-failed check into exit 2 -- the allowlist in
        # drift_unverifiable() requires hash_ok True first.
        proj, base, proof_path = self._make_proj_and_proof()
        proof = _load_json(proof_path)
        original_hash = proof["verification"]["hash"]
        proof.setdefault("cost", {})["usd"] = 99999.99
        self.assertEqual(proof["verification"]["hash"], original_hash)
        with open(proof_path, "w") as f:
            json.dump(proof, f, indent=2)
        nongit = os.path.join(self.tmp, "nongit-launder")
        os.makedirs(nongit)
        rc, res = _run_verifier(proof_path, nongit)
        self.assertEqual(
            rc, 1,
            "a genuinely tampered proof must not be laundered into exit 2 "
            "just because repo_dir also cannot check drift: %s" % res)
        self.assertFalse(res["ok"])
        self.assertFalse(res["hash_ok"])
        self.assertIn("hash mismatch", res["reason"])

    def test_missing_proof_file_exits_2(self):
        rc, res = _run_verifier(os.path.join(self.tmp, "nope.json"), self.tmp)
        self.assertEqual(rc, 2)
        self.assertFalse(res.get("ok", True))
        self.assertIn("error", res)

    def test_malformed_json_exits_2(self):
        bad = os.path.join(self.tmp, "bad.json")
        with open(bad, "w") as f:
            f.write("{ this is not json")
        rc, res = _run_verifier(bad, self.tmp)
        self.assertEqual(rc, 2)
        self.assertFalse(res.get("ok", True))

    def test_no_verification_hash_does_not_pass(self):
        # A proof stripped of its verification block cannot prove integrity.
        proj, base, proof_path = self._make_proj_and_proof()
        proof = _load_json(proof_path)
        proof.pop("verification", None)
        with open(proof_path, "w") as f:
            json.dump(proof, f, indent=2)
        rc, res = _run_verifier(proof_path, proj)
        self.assertEqual(rc, 1)
        self.assertFalse(res["ok"])
        self.assertFalse(res["hash_ok"])
        self.assertIn("integrity", res["reason"])

    def test_degraded_surfaced_in_verifier_output(self):
        # The verifier echoes honesty.degraded so the gaps the generator
        # disclosed are visible at verify time too. This proof (no tests/build
        # run) has degraded entries.
        proj, base, proof_path = self._make_proj_and_proof()
        rc, res = _run_verifier(proof_path, proj)
        self.assertIn("degraded", res)
        self.assertIsInstance(res["degraded"], list)
        # tests + build were never run in the fixture -> degraded is non-empty.
        self.assertTrue(res["degraded"])

    def test_rehashed_verified_headline_cannot_hide_failed_execution(self):
        proj, base, proof_path = self._make_proj_and_proof()
        proof = _load_json(proof_path)
        proof["facts"]["execution"] = {
            "terminated": False,
            "exit_code": 20,
            "run_status": "max_iterations_reached",
            "outcome": "max_iterations",
        }
        proof["honesty"]["headline"] = "VERIFIED"
        proof["honesty"]["degraded"] = []
        proof = _resign(proof)
        with open(proof_path, "w") as handle:
            json.dump(proof, handle, indent=2)

        rc, res = _run_verifier(proof_path, proj)

        self.assertEqual(rc, 1, res)
        self.assertTrue(res["hash_ok"], "tampered facts were deliberately rehashed")
        self.assertFalse(res["headline_consistent"])
        self.assertFalse(res["ok"])


def _resign(proof):
    """Recompute verification.hash exactly as the generator does, so a test can
    edit a fact and still produce a hash-valid proof (to isolate the drift /
    base-ref honesty paths from the tamper path)."""
    import hashlib
    unsigned = dict(proof)
    unsigned.pop("verification", None)
    canonical = json.dumps(unsigned, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    proof["verification"] = {"hash": digest, "algo": "sha256",
                             "scope": "integrity"}
    return proof


# ---------------------------------------------------------------------------
# Verification record (LM-005): integrity, execution validity and requirement
# coverage stay apart, and a passing label is never a bare pass when a check did
# not run. Folded in from the former tests/test_verification_record.py; the
# implementation is the verification-record section of proof-verify.py and the
# contract is docs/PROOF-PASSPORT.md ("Verification record"). Every case builds
# a real git repo under a private temp dir, so staleness and modified-test
# detection run against real git.
# ---------------------------------------------------------------------------

_LIB_DIR = os.path.join(_REPO, "autonomy", "lib")
VR = _load_verifier_module()


def _vr_git(repo, *args):
    r = subprocess.run(
        ["git", "-C", repo, "-c", "user.email=t@t.test", "-c", "user.name=tester"] + list(args),
        capture_output=True, text=True, check=True)
    return r.stdout.strip()


def _vr_seal(proof):
    """Return proof with a correct verification.hash, as the generator writes it."""
    body = {k: v for k, v in proof.items() if k != "verification"}
    digest = hashlib.sha256(VR._canonical(body).encode("utf-8")).hexdigest()
    out = dict(body)
    out["verification"] = {"hash": digest}
    return out


def _vr_proof(repo, base_sha, head_sha, *, tests="verified", build="verified", gates=None,
           security_ran=True):
    """A receipt shaped like the generator's, with the headline the verifier
    re-derives from the facts so integrity is genuinely valid."""
    gates = gates if gates is not None else [
        {"name": "lint", "status": "passed"}, {"name": "e2e", "status": "passed"}]
    facts = {
        "git": {"base_sha": base_sha, "head_sha": head_sha, "dirty": False,
                "diff": {"count": 1, "insertions": 1, "deletions": 1}},
        "tests": {"status": tests, "exit_code": 0 if tests == "verified" else 1,
                  "command": "make test"},
        "build": {"status": build, "ran": True},
        "quality_gates": gates,
        "security": {"ran": security_ran, "high_active": 0},
    }
    return {
        "facts": facts,
        "honesty": {"headline": VR._compute_headline(facts, []), "degraded": []},
        "cost": {"usd": 0.0, "available": False},
    }


class _VrFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-vrec-")
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        _vr_git(self.repo, "init", "-q", "-b", "main")
        with open(os.path.join(self.repo, "app.py"), "w") as fh:
            fh.write("print('v1')\n")
        os.makedirs(os.path.join(self.repo, "tests"))
        with open(os.path.join(self.repo, "tests", "test_app.py"), "w") as fh:
            fh.write("def test_ok():\n    assert True\n")
        _vr_git(self.repo, "add", "app.py", "tests/test_app.py")
        _vr_git(self.repo, "commit", "-q", "-m", "base")
        self.base = _vr_git(self.repo, "rev-parse", "HEAD")
        with open(os.path.join(self.repo, "app.py"), "w") as fh:
            fh.write("print('v2')\n")
        _vr_git(self.repo, "add", "app.py")
        _vr_git(self.repo, "commit", "-q", "-m", "change")
        self.head = _vr_git(self.repo, "rev-parse", "HEAD")
        self.loki = os.path.join(self.repo, ".loki")
        os.makedirs(os.path.join(self.loki, "state"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def build(self, proof):
        return VR.build_for_proof(proof, self.repo, self.loki)

    def sealed(self, **kw):
        return _vr_seal(_vr_proof(self.repo, self.base, self.head, **kw))

    def write_requirements(self, reqs):
        with open(os.path.join(self.loki, "state", "requirements-map.json"), "w") as fh:
            json.dump({"requirements": reqs}, fh)


class StatusVocabulary(unittest.TestCase):
    def test_vocabulary_is_closed(self):
        self.assertEqual(set(VR.CHECK_STATUSES),
                         {"passed", "failed", "skipped", "not_run", "stale"})

    def test_normalize(self):
        self.assertEqual(VR.normalize_status("pass"), "passed")
        self.assertEqual(VR.normalize_status("fail"), "failed")
        self.assertEqual(VR.normalize_status("skipped"), "skipped")
        self.assertEqual(VR.normalize_status("inconclusive"), "not_run")
        self.assertEqual(VR.normalize_status(None), "not_run")
        self.assertEqual(VR.normalize_status("???"), "not_run")


class Outcomes(_VrFixture):
    def test_all_passed_is_clean_verified(self):
        rec = self.build(self.sealed())
        self.assertEqual(rec["integrity"]["status"], "valid")
        self.assertEqual(rec["execution"]["status"], "fresh")
        self.assertEqual(rec["counts"]["failed"], 0)
        self.assertEqual(rec["counts"]["ran"], rec["counts"]["total"])
        self.write_requirements([{"id": "R1", "text": "t", "checks": ["lint"],
                                  "status": "covered"}])
        rec = self.build(self.sealed())
        self.assertEqual(rec["label"], "VERIFIED")

    def test_one_failed_never_passes(self):
        rec = self.build(self.sealed(tests="failed"))
        self.assertTrue(rec["label"].startswith("NOT VERIFIED"))
        self.assertIn("tests", rec["label"])
        self.assertNotIn("VERIFIED (scoped", rec["label"])

    def test_skipped_checks_give_scoped_label(self):
        gates = [{"name": "lint", "status": "skipped"}, {"name": "e2e", "status": "passed"}]
        rec = self.build(self.sealed(gates=gates))
        self.assertTrue(rec["label"].startswith("VERIFIED (scoped:"), rec["label"])
        self.assertIn("not run: lint", rec["label"])
        self.assertNotEqual(rec["label"], "VERIFIED")
        self.assertEqual(rec["counts"]["skipped"], 1)

    def test_unrun_check_is_named_in_label(self):
        rec = self.build(self.sealed(security_ran=False))
        self.assertIn("security", rec["label"])
        self.assertTrue(rec["label"].startswith("VERIFIED (scoped:"))

    def test_stale_revision(self):
        proof = self.sealed()
        with open(os.path.join(self.repo, "app.py"), "w") as fh:
            fh.write("print('v3')\n")
        _vr_git(self.repo, "add", "app.py")
        _vr_git(self.repo, "commit", "-q", "-m", "later")
        rec = self.build(proof)
        self.assertEqual(rec["execution"]["status"], "stale")
        self.assertTrue(rec["label"].startswith("STALE"), rec["label"])
        statuses = {c["status"] for c in rec["checks"]}
        self.assertNotIn("passed", statuses)
        self.assertIn("stale", statuses)

    def test_incomplete_record(self):
        rec = self.build({"honesty": {"headline": "VERIFIED"}, "facts": {}})
        self.assertFalse(rec["complete"])
        self.assertTrue(rec["label"].startswith("INCOMPLETE"), rec["label"])
        rec = self.build({})
        self.assertTrue(rec["label"].startswith("INCOMPLETE"), rec["label"])

    def test_tampered_record_fails_integrity(self):
        proof = self.sealed()
        proof["facts"]["tests"]["status"] = "pass"
        proof["facts"]["build"]["ran"] = False
        rec = self.build(proof)
        self.assertEqual(rec["integrity"]["status"], "invalid")
        self.assertTrue(rec["label"].startswith("NOT VERIFIED (integrity failed"), rec["label"])

    def test_missing_hash_is_not_valid(self):
        proof = _vr_proof(self.repo, self.base, self.head)
        rec = self.build(proof)
        self.assertEqual(rec["integrity"]["status"], "not_recorded")
        self.assertFalse(rec["label"].startswith("VERIFIED"), rec["label"])
        self.assertTrue(rec["label"].startswith("NOT VERIFIED"), rec["label"])


class ModifiedTests(_VrFixture):
    def _change_test(self, delete=False):
        path = os.path.join(self.repo, "tests", "test_app.py")
        if delete:
            os.remove(path)
        else:
            with open(path, "w") as fh:
                fh.write("def test_ok():\n    pass\n")
        _vr_git(self.repo, "add", "-A", "tests")
        _vr_git(self.repo, "commit", "-q", "-m", "edit tests")
        self.head = _vr_git(self.repo, "rev-parse", "HEAD")

    def test_modified_test_flagged(self):
        self._change_test()
        rec = self.build(self.sealed())
        files = rec["modified_tests"]["files"]
        self.assertEqual([f["path"] for f in files], ["tests/test_app.py"])
        self.assertEqual(files[0]["change"], "modified")
        self.assertIn("existing test file(s) modified", rec["label"])
        self.assertIn("test_app.py", VR.render_compact(rec))

    def test_deleted_test_flagged(self):
        self._change_test(delete=True)
        rec = self.build(self.sealed())
        self.assertEqual(rec["modified_tests"]["files"][0]["change"], "deleted")

    def test_added_test_not_flagged(self):
        with open(os.path.join(self.repo, "tests", "test_new.py"), "w") as fh:
            fh.write("def test_new():\n    assert 1\n")
        _vr_git(self.repo, "add", "tests/test_new.py")
        _vr_git(self.repo, "commit", "-q", "-m", "add test")
        self.head = _vr_git(self.repo, "rev-parse", "HEAD")
        rec = self.build(self.sealed())
        self.assertEqual(rec["modified_tests"]["files"], [])


class Requirements(_VrFixture):
    def test_absent_map_is_unknown_not_zero(self):
        rec = self.build(self.sealed())
        req = rec["requirements"]
        self.assertEqual(req["status"], "not_recorded")
        self.assertIsNone(req["covered"])
        self.assertIsNone(req["uncovered"])

    def test_map_present_counts(self):
        self.write_requirements([
            {"id": "R1", "text": "a", "checks": ["lint"], "status": "covered"},
            {"id": "R2", "text": "b", "checks": [], "status": "uncovered"},
            {"id": "R3", "text": "c", "checks": [], "status": "uncovered"}])
        rec = self.build(self.sealed())
        req = rec["requirements"]
        self.assertEqual((req["status"], req["total"], req["covered"], req["uncovered"]),
                         ("recorded", 3, 1, 2))
        self.assertEqual(req["uncovered_ids"], ["R2", "R3"])
        self.assertIn("2 requirement(s) uncovered", rec["label"])

    def test_corrupt_map_is_unreadable(self):
        with open(os.path.join(self.loki, "state", "requirements-map.json"), "w") as fh:
            fh.write("{not json")
        rec = self.build(self.sealed())
        self.assertEqual(rec["requirements"]["status"], "unreadable")
        self.assertIsNone(rec["requirements"]["uncovered"])


class Rendering(_VrFixture):
    def test_compact_summary_is_short(self):
        self.write_requirements([{"id": "R1", "text": "a", "checks": [], "status": "uncovered"}])
        rec = self.build(self.sealed(gates=[{"name": "lint", "status": "skipped"}]))
        lines = VR.render_compact(rec).rstrip("\n").split("\n")
        self.assertLessEqual(len(lines), 14, lines)
        self.assertIn(rec["label"], lines[0] + "\n" + "\n".join(lines))

    def test_record_is_json_serializable_and_keeps_fields(self):
        rec = self.build(self.sealed())
        again = json.loads(json.dumps(rec))
        for key in ("label", "integrity", "execution", "requirements", "checks",
                    "counts", "modified_tests", "complete"):
            self.assertIn(key, again)

    def test_cli_summary_and_json(self):
        proof = self.sealed()
        path = os.path.join(self.tmp, "proof.json")
        with open(path, "w") as fh:
            json.dump(proof, fh)
        for mode in ("summary", "json", "label"):
            r = subprocess.run(
                [sys.executable, "-I", _VERIFIER, mode, path, "--repo", self.repo,
                 "--loki-dir", self.loki], capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(r.stdout.strip())
            if mode == "json":
                self.assertEqual(json.loads(r.stdout)["integrity"]["status"], "valid")

    def test_no_dash_or_emoji_in_output(self):
        rec = self.build(self.sealed(gates=[{"name": "lint", "status": "skipped"}]))
        text = VR.render_compact(rec) + rec["label"]
        for code in (0x2014, 0x2013):
            self.assertNotIn(chr(code), text)
        self.assertTrue(all(ord(c) < 0x2000 for c in text))


class Evidence(_VrFixture):
    def _doc(self, gates):
        return {"verdict": "VERIFIED",
                "subject": {"head_sha": self.head, "worktree_clean_at_grade": True,
                            "merge_base_sha": self.base},
                "deterministic_gates": gates}

    def test_inconclusive_gate_is_not_run(self):
        doc = self._doc([{"gate": "build", "status": "pass", "summary": ""},
                         {"gate": "runtime", "status": "inconclusive", "summary": ""}])
        rec = VR.build_for_evidence(copy.deepcopy(doc), self.repo, self.loki, fresh_capture=True)
        self.assertEqual(rec["integrity"]["status"], "not_recorded")
        self.assertTrue(rec["label"].startswith("VERIFIED (scoped:"), rec["label"])
        self.assertIn("runtime", rec["label"])

    def test_failed_gate_blocks(self):
        doc = self._doc([{"gate": "tests", "status": "fail", "summary": "boom"}])
        doc["verdict"] = "BLOCKED"
        rec = VR.build_for_evidence(doc, self.repo, self.loki, fresh_capture=True)
        self.assertTrue(rec["label"].startswith("NOT VERIFIED"), rec["label"])


class CliEndToEnd(_VrFixture):
    """`loki proof show` on the bash route: compact by default, --json is full."""

    def _run(self, *args):
        env = {"PATH": os.environ.get("PATH", ""), "HOME": self.tmp,
               "LOKI_LEGACY_BASH": "1", "LOKI_NO_BROWSER": "1",
               "TARGET_DIR": self.repo, "LOKI_DIR": self.loki}
        return subprocess.run(["bash", os.path.join(_REPO, "bin", "loki"), *args],
                              cwd=self.repo, env=env, capture_output=True, text=True,
                              timeout=90)

    def test_show_default_is_compact_and_json_is_full(self):
        proof = self.sealed(gates=[{"name": "lint", "status": "skipped"}])
        d = os.path.join(self.loki, "proofs", "run1")
        os.makedirs(d)
        with open(os.path.join(d, "proof.json"), "w") as fh:
            json.dump(proof, fh)
        compact = self._run("proof", "show", "run1")
        self.assertEqual(compact.returncode, 0, compact.stderr)
        lines = compact.stdout.strip().split("\n")
        self.assertLessEqual(len(lines), 14, compact.stdout)
        self.assertIn("VERIFIED (scoped:", compact.stdout)
        self.assertNotIn('"schema_version"', compact.stdout)
        full = self._run("proof", "show", "run1", "--json")
        self.assertEqual(full.returncode, 0, full.stderr)
        self.assertEqual(json.loads(full.stdout)["facts"]["tests"]["command"], "make test")

    def test_loki_verify_banner_and_evidence(self):
        env = {"PATH": os.environ.get("PATH", ""), "HOME": self.tmp,
               "LOKI_NO_BROWSER": "1", "LOKI_LEGACY_BASH": "1"}
        out_dir = os.path.join(self.tmp, "verify-out")
        r = subprocess.run(
            ["bash", os.path.join(_REPO, "autonomy", "verify.sh"), "--base", self.base,
             "--no-llm", "--out", out_dir],
            cwd=self.repo, env=env, capture_output=True, text=True, timeout=240)
        text = r.stdout + r.stderr
        self.assertIn("VERDICT:", text)
        with open(os.path.join(out_dir, "evidence.json")) as fh:
            doc = json.load(fh)
        rec = doc["verification"]
        self.assertEqual(rec["integrity"]["status"], "not_recorded")
        self.assertIn(rec["execution"]["status"], ("fresh", "unknown"))
        self.assertEqual(sorted(rec["counts"]), sorted(
            ["passed", "failed", "skipped", "not_run", "stale", "total", "ran"]))
        # the banner verdict is the scoped label, never a bare pass when a gate did not run
        verdict_line = [ln for ln in text.splitlines() if ln.startswith("VERDICT:")][-1]
        if rec["counts"]["not_run"] or rec["counts"]["skipped"]:
            self.assertNotEqual(verdict_line.strip(), "VERDICT: VERIFIED")
        self.assertEqual(r.returncode, doc["exit_code"])

    def test_verify_json_carries_the_record(self):
        proof = self.sealed()
        d = os.path.join(self.loki, "proofs", "run2")
        os.makedirs(d)
        with open(os.path.join(d, "proof.json"), "w") as fh:
            json.dump(proof, fh)
        r = subprocess.run(
            [sys.executable, "-I", os.path.join(_LIB_DIR, "proof-verify.py"),
             os.path.join(d, "proof.json"), self.repo],
            capture_output=True, text=True, timeout=60)
        out = json.loads(r.stdout)
        self.assertIn("verification", out)
        self.assertIn("ok", out)
        self.assertEqual(out["verification"]["integrity"]["status"], "valid")


if __name__ == "__main__":
    unittest.main()
