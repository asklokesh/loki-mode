#!/usr/bin/env python3
"""
tests/test-trigger-server-unit-jobs.py - M-23: POST /jobs kind "unit".

A remote modernize unit rides the existing /jobs API: same bearer auth, same
queue and worker pool. Covers:
  1. No token configured -> 503; missing or wrong token -> 401 (never 202).
  2. Unknown fields are rejected, so a credential field cannot ride the payload.
  3. repo, ref and unit id are bounded and cannot be parsed as a CLI flag.
  4. A valid unit job is enqueued and dispatched as a single argv list.
  5. The spec job kind and the webhook credential separation are unchanged.

Standard library only. Run with: python3 tests/test-trigger-server-unit-jobs.py
"""

import importlib
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "autonomy"))
base = importlib.import_module("test-trigger-server-jobs")
ts = base.ts

GOOD = {
    "kind": "unit",
    "repo": "acme/legacy-app",
    "ref": "loki/mod-20261015T000000Z-abcdef",
    "unit": "billing.core",
}


class TestUnitValidation(unittest.TestCase):
    def test_accepts_minimal_and_full(self):
        self.assertIsNotNone(ts.validate_unit_job(dict(GOOD))[0])
        full = dict(GOOD, mid="mod-20261015T000000Z-abcdef", target="python3")
        self.assertEqual(ts.validate_unit_job(full)[0]["target"], "python3")

    def test_rejects_unknown_fields(self):
        for extra in ("token", "api_key", "password", "env", "cmd", "spec"):
            clean, err = ts.validate_unit_job(dict(GOOD, **{extra: "x"}))
            self.assertIsNone(clean, extra)
            self.assertIn("unknown", err)

    def test_missing_required(self):
        for k in ("repo", "ref", "unit"):
            p = dict(GOOD)
            del p[k]
            self.assertIsNone(ts.validate_unit_job(p)[0], k)

    def test_bounds_and_injection(self):
        bad = [
            dict(GOOD, repo="--config=/etc/x/y"),
            dict(GOOD, repo="no-slash"),
            dict(GOOD, repo="a/" + "b" * 200),
            dict(GOOD, ref="-rf"),
            dict(GOOD, ref="a" * 201),
            dict(GOOD, ref="a..b"),
            dict(GOOD, ref="a b"),
            dict(GOOD, ref="x\ny"),
            dict(GOOD, ref="a@{1}"),
            dict(GOOD, unit="-x"),
            dict(GOOD, unit="u" * 129),
            dict(GOOD, unit="a/b"),
            dict(GOOD, unit="a~v1"),
            dict(GOOD, mid="not-a-mid"),
            dict(GOOD, target="cobol"),
            dict(GOOD, unit=5),
            dict(GOOD, repo=["a/b"]),
        ]
        for p in bad:
            self.assertIsNone(ts.validate_unit_job(p)[0], p)


class TestUnitParity(unittest.TestCase):
    """The TS buildUnitJob test reads this same fixture, so both validators agree."""

    FIXTURE = (Path(__file__).parent.parent / "loki-ts" / "tests" / "engine10"
               / "modernize" / "fixtures" / "unit_job_parity.json")

    def test_shared_fixture_verdicts(self):
        cases = json.loads(self.FIXTURE.read_text(encoding="utf-8"))
        self.assertGreater(len(cases), 10)
        for case in cases:
            clean, err = ts.validate_unit_job(case["payload"])
            self.assertEqual(clean is not None, case["valid"], "%s: %s" % (case["name"], err))


@unittest.skipUnless(shutil.which("helm"), "helm not installed")
class TestUnitHelm(unittest.TestCase):
    CHART = str(Path(__file__).parent.parent / "deploy" / "helm" / "autonomi")
    UNIT = ["--set", "worker.engine=v10", "--set", "worker.unit.repo=a/b",
            "--set", "worker.unit.ref=main", "--set", "worker.unit.id=u1"]

    def render(self, *extra):
        return subprocess.run(["helm", "template", "t", self.CHART, *self.UNIT, *extra],
                              capture_output=True, text=True)

    def test_job_runs_loki_modernize_unit(self):
        r = self.render()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("- modernize\n            - unit\n", r.stdout)
        self.assertNotIn("engine10", r.stdout)

    def test_engine_v10_needs_job_mode(self):
        for mode in ("deployment", "serverless"):
            r = self.render("--set", "worker.mode=" + mode)
            self.assertNotEqual(r.returncode, 0, mode)
            self.assertIn("needs worker.mode=job", r.stderr)


class TestUnitJobsHttp(base._JobsTestBase):
    def post(self, payload, token=base.API_TOKEN):
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        return self.srv.request("POST", "/jobs", body=json.dumps(payload).encode(),
                                headers=headers)

    def test_auth_missing_rejected(self):
        self.start()
        status, _ = self.post(dict(GOOD), token=None)
        self.assertEqual(status, 401)
        status, _ = self.post(dict(GOOD), token="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(self.dispatched, [])

    def test_no_token_configured_is_503(self):
        self.start(api_token="")
        status, _ = self.post(dict(GOOD), token="anything")
        self.assertEqual(status, 503)
        self.assertEqual(self.dispatched, [])

    def test_webhook_secret_does_not_grant_unit_jobs(self):
        self.start()
        status, _ = self.post(dict(GOOD), token=base.WEBHOOK_SECRET)
        self.assertEqual(status, 401)

    def test_unknown_field_rejected_and_not_dispatched(self):
        self.start()
        status, _ = self.post(dict(GOOD, token="ghp_secret"))
        self.assertEqual(status, 400)
        self.assertFalse(self.fired.wait(0.3))
        self.assertEqual(self.dispatched, [])

    def test_non_unit_kind_takes_the_unchanged_spec_path(self):
        self.start()
        status, _ = self.post({"kind": "shell"})
        self.assertEqual(status, 400)
        self.assertEqual(self.dispatched, [])
        status, _ = self.post({"kind": "shell", "spec": "./prd.md"})
        self.assertEqual(status, 202)
        self.assertTrue(self.fired.wait(5))
        self.assertEqual(self.dispatched[0], ["start", "./prd.md", "--detach"])

    def test_trailing_newline_and_unicode_digits_get_400(self):
        self.start()
        for bad in (dict(GOOD, repo="acme/app\n"), dict(GOOD, unit="u1\n"),
                    dict(GOOD, mid="mod-\u0662\u0660\u0662\u0661\u0661\u0660\u0661\u0665T000000Z-abcdef")):
            status, _ = self.post(bad)
            self.assertEqual(status, 400, bad)
        self.assertEqual(self.dispatched, [])

    def test_valid_unit_enqueued_as_argv(self):
        self.start()
        status, data = self.post(dict(GOOD, target="python3"))
        self.assertEqual(status, 202)
        job_id = json.loads(data)["id"]
        self.assertTrue(self.fired.wait(5))
        argv = self.dispatched[0]
        self.assertEqual(argv[:2], ["modernize", "unit"])
        self.assertIn("acme/legacy-app", argv)
        self.assertIn("billing.core", argv)
        self.assertEqual(argv[argv.index("--target") + 1], "python3")
        status, _ = self.srv.request(
            "GET", "/jobs/" + job_id,
            headers={"Authorization": "Bearer " + base.API_TOKEN})
        self.assertEqual(status, 200)

    def test_spec_job_unchanged(self):
        self.start()
        status, _ = self.srv.request(
            "POST", "/jobs", body=json.dumps({"spec": "./prd.md"}).encode(),
            headers={"Authorization": "Bearer " + base.API_TOKEN,
                     "Content-Type": "application/json"})
        self.assertEqual(status, 202)
        self.assertTrue(self.fired.wait(5))
        self.assertEqual(self.dispatched[0][0], "start")

    def test_handler_revalidates_unit_job(self):
        summary, status = ts.handle_job_event(
            {"spec": "unit:x", "unit_job": dict(GOOD, token="t"), "job_id": "j"})
        self.assertIsNone(summary)
        self.assertIn("rejected", status)


if __name__ == "__main__":
    unittest.main()
