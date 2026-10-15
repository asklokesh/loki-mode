"""tests/test_verification_record.py -- the three-property verification record.

Fixture tests for autonomy/lib/verification_record.py (LM-005). A passing
outcome label must never be a bare pass when a check did not run, and the
record must keep integrity, execution validity and requirement coverage apart.

Every case builds a real git repo under a private temp directory, so revision
staleness and modified-test detection run against real git, not a mock.
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
_LIB = os.path.join(_REPO, "autonomy", "lib")
_RECORD_CLI = os.path.join(_LIB, "verification_record.py")


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_LIB, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


VR = _load("vr_under_test", "verification_record.py")
PV = _load("pv_under_test", "proof-verify.py")


def _git(repo, *args):
    r = subprocess.run(
        ["git", "-C", repo, "-c", "user.email=t@t.test", "-c", "user.name=tester"] + list(args),
        capture_output=True, text=True, check=True)
    return r.stdout.strip()


def _seal(proof):
    """Return proof with a correct verification.hash, as the generator writes it."""
    body = {k: v for k, v in proof.items() if k != "verification"}
    digest = hashlib.sha256(PV._canonical(body).encode("utf-8")).hexdigest()
    out = dict(body)
    out["verification"] = {"hash": digest}
    return out


def _proof(repo, base_sha, head_sha, *, tests="verified", build="verified", gates=None,
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
        "honesty": {"headline": PV._compute_headline(facts, []), "degraded": []},
        "cost": {"usd": 0.0, "available": False},
    }


class _Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-vrec-")
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        _git(self.repo, "init", "-q", "-b", "main")
        with open(os.path.join(self.repo, "app.py"), "w") as fh:
            fh.write("print('v1')\n")
        os.makedirs(os.path.join(self.repo, "tests"))
        with open(os.path.join(self.repo, "tests", "test_app.py"), "w") as fh:
            fh.write("def test_ok():\n    assert True\n")
        _git(self.repo, "add", "app.py", "tests/test_app.py")
        _git(self.repo, "commit", "-q", "-m", "base")
        self.base = _git(self.repo, "rev-parse", "HEAD")
        with open(os.path.join(self.repo, "app.py"), "w") as fh:
            fh.write("print('v2')\n")
        _git(self.repo, "add", "app.py")
        _git(self.repo, "commit", "-q", "-m", "change")
        self.head = _git(self.repo, "rev-parse", "HEAD")
        self.loki = os.path.join(self.repo, ".loki")
        os.makedirs(os.path.join(self.loki, "state"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def build(self, proof):
        return VR.build_for_proof(proof, self.repo, self.loki)

    def sealed(self, **kw):
        return _seal(_proof(self.repo, self.base, self.head, **kw))

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


class Outcomes(_Fixture):
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
        _git(self.repo, "add", "app.py")
        _git(self.repo, "commit", "-q", "-m", "later")
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
        proof = _proof(self.repo, self.base, self.head)
        rec = self.build(proof)
        self.assertEqual(rec["integrity"]["status"], "not_recorded")
        self.assertFalse(rec["label"].startswith("VERIFIED"), rec["label"])
        self.assertTrue(rec["label"].startswith("NOT VERIFIED"), rec["label"])


class ModifiedTests(_Fixture):
    def _change_test(self, delete=False):
        path = os.path.join(self.repo, "tests", "test_app.py")
        if delete:
            os.remove(path)
        else:
            with open(path, "w") as fh:
                fh.write("def test_ok():\n    pass\n")
        _git(self.repo, "add", "-A", "tests")
        _git(self.repo, "commit", "-q", "-m", "edit tests")
        self.head = _git(self.repo, "rev-parse", "HEAD")

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
        _git(self.repo, "add", "tests/test_new.py")
        _git(self.repo, "commit", "-q", "-m", "add test")
        self.head = _git(self.repo, "rev-parse", "HEAD")
        rec = self.build(self.sealed())
        self.assertEqual(rec["modified_tests"]["files"], [])


class Requirements(_Fixture):
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


class Rendering(_Fixture):
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
                [sys.executable, "-I", _RECORD_CLI, mode, path, "--repo", self.repo,
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


class Evidence(_Fixture):
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


class CliEndToEnd(_Fixture):
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
            [sys.executable, "-I", os.path.join(_LIB, "proof-verify.py"),
             os.path.join(d, "proof.json"), self.repo],
            capture_output=True, text=True, timeout=60)
        out = json.loads(r.stdout)
        self.assertIn("verification", out)
        self.assertIn("ok", out)
        self.assertEqual(out["verification"]["integrity"]["status"], "valid")


if __name__ == "__main__":
    unittest.main()
