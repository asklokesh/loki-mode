#!/usr/bin/env python3
"""
tests/test-trigger-server-jobs.py - Tests for the remote-submit API.

Covers POST /jobs and GET /jobs/<id> in autonomy/trigger-server.py:
  1. No API token configured -> 503 + audit line (never 200).
  2. Wrong token -> 401, compared in constant time (hmac.compare_digest).
  3. Correct token -> job enqueued, an id is returned.
  4. The API token and the webhook HMAC are genuinely DISTINCT credentials --
     neither one grants the other. This is the load-bearing property.
  5. Oversized / control-character / flag-injecting specs are rejected.
  6. Queue full -> 429 (shed, never a silent drop).
  7. /health and /status still work with no API token configured.

Standard library only (unittest). Run with:
    python3 tests/test-trigger-server-jobs.py
"""

import hashlib
import hmac
import http.client
import importlib
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

# Ensure autonomy/ is on path so we can import the module under test.
sys.path.insert(0, str(Path(__file__).parent.parent / "autonomy"))
ts = importlib.import_module("trigger-server")
sys.modules["trigger_server"] = ts

API_TOKEN = "api-token-for-humans"
WEBHOOK_SECRET = "hmac-secret-for-github"


def _sign(secret, body):
    return "sha256=" + hmac.new(
        secret.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()


class _JobServer:
    """Spin up a real ThreadingWebhookServer with both credentials set."""

    def __init__(self, dispatcher, api_token=API_TOKEN, secret=WEBHOOK_SECRET):
        # Fresh handler subclass so class attrs do not leak between tests.
        class _H(ts.WebhookHandler):
            pass

        _H.secret = secret
        _H.api_token = api_token
        _H.dry_run = False
        _H.dispatcher = dispatcher
        _H.log_message = lambda *a, **k: None  # silence access logs in tests
        self.server = ts.ThreadingWebhookServer(("127.0.0.1", 0), _H)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data

    def submit(self, spec, token=API_TOKEN, extra_headers=None):
        body = json.dumps({"spec": spec}).encode()
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        if extra_headers:
            headers.update(extra_headers)
        return self.request("POST", "/jobs", body=body, headers=headers)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class _JobsTestBase(unittest.TestCase):
    """Chdir to a temp dir (log_event writes .loki/) and stub the dispatch."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_cwd = os.getcwd()
        os.chdir(self.tmpdir)
        patch.object(ts, "send_notification").start()
        self.dispatched = []
        self.dispatch_lock = threading.Lock()
        self.fired = threading.Event()

        def fake_run(args, dry_run=False):
            with self.dispatch_lock:
                self.dispatched.append(args)
            self.fired.set()
            return ts.OUTCOME_PASSED

        patch.object(ts, "run_loki_outcome", side_effect=fake_run).start()
        self.disp = None
        self.srv = None

    def tearDown(self):
        if self.srv is not None:
            self.srv.close()
        if self.disp is not None:
            self.disp.shutdown()
        patch.stopall()
        os.chdir(self.orig_cwd)

    def start(self, api_token=API_TOKEN, secret=WEBHOOK_SECRET,
              workers=2, queue_size=8):
        self.disp = ts.Dispatcher(workers=workers, queue_size=queue_size,
                                  dry_run=False)
        self.srv = _JobServer(self.disp, api_token=api_token, secret=secret)
        return self.srv

    def audit_lines(self):
        """Return the .loki/triggers/events.log entries written so far."""
        log_path = Path(self.tmpdir) / ".loki" / "triggers" / "events.log"
        if not log_path.exists():
            return []
        return [json.loads(line) for line in
                log_path.read_text().splitlines() if line.strip()]


class TestSpecValidation(unittest.TestCase):
    """A remotely-submitted spec is untrusted input (unit level)."""

    def test_accepts_normal_specs(self):
        self.assertTrue(ts.valid_spec("owner/repo#12"))
        self.assertTrue(ts.valid_spec("./prd.md"))
        self.assertTrue(ts.valid_spec("build me a todo app"))

    def test_rejects_non_strings(self):
        # Rejected outright, never coerced (same rigor as valid_issue_number).
        for bad in (None, 5, True, {"spec": "x"}, ["x"], b"bytes"):
            self.assertFalse(ts.valid_spec(bad), repr(bad))

    def test_rejects_empty_and_whitespace(self):
        self.assertFalse(ts.valid_spec(""))
        self.assertFalse(ts.valid_spec("   \t "))

    def test_rejects_oversized(self):
        self.assertTrue(ts.valid_spec("a" * ts.MAX_SPEC_BYTES))
        self.assertFalse(ts.valid_spec("a" * (ts.MAX_SPEC_BYTES + 1)))
        # Cap is on BYTES, not characters: multibyte input cannot slip past.
        self.assertFalse(ts.valid_spec("é" * ts.MAX_SPEC_BYTES))

    def test_rejects_control_characters(self):
        self.assertFalse(ts.valid_spec("owner/repo\x00rm -rf /"))
        self.assertFalse(ts.valid_spec("spec\nsecond line"))
        self.assertFalse(ts.valid_spec("spec\rX"))
        self.assertFalse(ts.valid_spec("spec\x1b[31m"))
        self.assertFalse(ts.valid_spec("spec\x7f"))

    def test_rejects_leading_dash_flag_injection(self):
        # Same class of injection REPO_FULL_NAME_RE guards on the webhook path:
        # a dash-leading value would parse as a `loki start` CLI FLAG.
        self.assertFalse(ts.valid_spec("--config=/etc/x"))
        self.assertFalse(ts.valid_spec("-rf"))

    def test_shell_metacharacters_are_not_a_shell_risk(self):
        # The spec goes into argv as ONE element, never a shell string, so
        # metacharacters need no escaping. Assert the handler passes it whole.
        with patch.object(ts, "run_loki_outcome",
                          return_value=ts.OUTCOME_PASSED) as m, \
                patch.object(ts, "send_notification"), \
                patch.object(ts, "log_event"):
            ts.handle_job_event({"spec": "a; rm -rf /", "job_id": "j1"})
        self.assertEqual(m.call_args[0][0], ["start", "a; rm -rf /", "--detach"])


class TestNoTokenFailsClosed(_JobsTestBase):
    """Requirement 3: no API token -> 503 + audit line, never a silent accept."""

    def test_submit_rejected_with_503_and_audit_line(self):
        srv = self.start(api_token="")
        status, body = srv.submit("owner/repo#1")
        self.assertEqual(status, 503)
        self.assertNotEqual(status, 200)
        self.assertIn(b"not configured", body)
        # No id handed out, nothing dispatched.
        self.assertNotIn(b"\"id\"", body)
        self.disp.queue.join()
        self.assertEqual(self.dispatched, [])
        # Audit line recorded.
        lines = self.audit_lines()
        self.assertTrue(
            any("no API token configured" in e["status"] for e in lines),
            "expected an audit line for the rejected submit, got %r" % lines,
        )

    def test_even_a_correct_looking_bearer_is_rejected(self):
        srv = self.start(api_token="")
        status, _ = srv.submit("owner/repo#1", token="anything-at-all")
        self.assertEqual(status, 503)

    def test_job_status_also_fails_closed(self):
        srv = self.start(api_token="")
        status, _ = srv.request("GET", "/jobs/whatever",
                                headers={"Authorization": "Bearer x"})
        self.assertEqual(status, 503)


class TestOpsEndpointsSurvive(_JobsTestBase):
    """Requirement 7: operators keep /health and /status with no API token."""

    def test_health_and_status_work_without_api_token(self):
        srv = self.start(api_token="", secret="")
        status, body = srv.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertIn(b"ok", body)

        status, body = srv.request("GET", "/status")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data["status"], "running")
        self.assertFalse(data["api_token_configured"])
        self.assertFalse(data["secret_configured"])

    def test_status_reports_configured_token_without_leaking_it(self):
        srv = self.start()
        status, body = srv.request("GET", "/status")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["api_token_configured"])
        self.assertNotIn(API_TOKEN.encode(), body)


class TestTokenAuth(_JobsTestBase):
    """Requirement 2: wrong token -> 401, compared in constant time."""

    def test_wrong_token_rejected(self):
        srv = self.start()
        status, _ = srv.submit("owner/repo#1", token="wrong-token")
        self.assertEqual(status, 401)
        self.disp.queue.join()
        self.assertEqual(self.dispatched, [])

    def test_missing_authorization_header_rejected(self):
        srv = self.start()
        status, _ = srv.submit("owner/repo#1", token=None)
        self.assertEqual(status, 401)

    def test_non_bearer_scheme_rejected(self):
        srv = self.start()
        status, _ = srv.submit("owner/repo#1",
                               extra_headers={"Authorization": "Basic " + API_TOKEN})
        self.assertEqual(status, 401)

    def test_token_prefix_is_not_accepted(self):
        # A truncated token must not pass: compare_digest is length-aware.
        srv = self.start()
        status, _ = srv.submit("owner/repo#1", token=API_TOKEN[:-1])
        self.assertEqual(status, 401)

    def test_comparison_is_constant_time(self):
        """The token compare must route through hmac.compare_digest.

        Patch it and assert it was CALLED with a well-formed-but-wrong bearer
        (so no earlier return skips the call). A behavior-only assertion would
        stay green if compare_digest were swapped for ==.
        """
        srv = self.start()
        real = hmac.compare_digest
        calls = []

        def spy(a, b):
            calls.append((a, b))
            return real(a, b)

        with patch.object(ts.hmac, "compare_digest", side_effect=spy):
            status, _ = srv.submit("owner/repo#1", token="wrong-but-well-formed")
        self.assertEqual(status, 401)
        self.assertTrue(calls, "hmac.compare_digest was not used for the token")

    def test_non_ascii_token_does_not_500(self):
        # compare_digest raises TypeError on non-ASCII str; a weird header must
        # produce a clean 401, not a server error.
        srv = self.start()
        status, _ = srv.submit("owner/repo#1", token="töken-ünicode")
        self.assertEqual(status, 401)


class TestCredentialSeparation(_JobsTestBase):
    """Requirement 4 (LOAD-BEARING): the two credentials are truly distinct.

    Holding one must never grant the other, in EITHER direction, and the
    submit pseudo-event must not be reachable from the HMAC-authenticated
    webhook path.
    """

    def test_webhook_secret_as_bearer_is_rejected(self):
        srv = self.start()
        status, _ = srv.submit("owner/repo#1", token=WEBHOOK_SECRET)
        self.assertEqual(status, 401)
        self.disp.queue.join()
        self.assertEqual(self.dispatched, [])

    def test_api_token_as_webhook_signature_is_rejected(self):
        """The reverse direction: the bearer token must not sign a webhook."""
        srv = self.start()
        body = json.dumps({"action": "opened", "issue": {"number": 1},
                           "repository": {"full_name": "o/r"}}).encode()
        status, _ = srv.request("POST", "/webhook", body=body, headers={
            "Content-Type": "application/json",
            "X-GitHub-Event": "issues",
            "X-Hub-Signature-256": _sign(API_TOKEN, body),
        })
        self.assertEqual(status, 401)
        self.disp.queue.join()
        self.assertEqual(self.dispatched, [])

    def test_valid_hmac_cannot_submit_a_job_via_webhook(self):
        """A correctly-signed webhook must NOT be able to submit a spec.

        JOB_EVENT shares the EVENT_HANDLERS dispatch table (one code path), so
        without an explicit refusal a holder of the webhook secret could POST
        X-GitHub-Event: loki_job and run an arbitrary spec, defeating the
        separate-credential requirement entirely.
        """
        srv = self.start()
        body = json.dumps({"spec": "pwn-me"}).encode()
        status, _ = srv.request("POST", "/webhook", body=body, headers={
            "Content-Type": "application/json",
            "X-GitHub-Event": ts.JOB_EVENT,
            "X-Hub-Signature-256": _sign(WEBHOOK_SECRET, body),
        })
        self.assertIn(status, (401, 403))
        self.disp.queue.join()
        self.assertEqual(self.dispatched, [])

    def _isolate_handler_class_attrs(self):
        """main() writes onto WebhookHandler itself; undo that after the test."""
        saved = (ts.WebhookHandler.api_token, ts.WebhookHandler.secret,
                 ts.WebhookHandler.dispatcher, ts.WebhookHandler.dry_run)

        def restore():
            (ts.WebhookHandler.api_token, ts.WebhookHandler.secret,
             ts.WebhookHandler.dispatcher, ts.WebhookHandler.dry_run) = saved

        self.addCleanup(restore)

    def test_startup_disables_jobs_when_token_equals_webhook_secret(self):
        """Configuring the SAME string for both is not credential separation.

        Exercises the startup guard in main() itself (not just its helpers): a
        token identical to the webhook secret must be discarded, so /jobs falls
        back to the 503 fail-closed state rather than accepting the HMAC secret
        as a bearer token.
        """
        self._isolate_handler_class_attrs()
        env = {"LOKI_API_TOKEN": "same-string", "GITHUB_WEBHOOK_SECRET": "same-string"}
        with patch.dict(os.environ, env, clear=False), \
                patch.object(ts, "save_config"), \
                patch.object(ts, "write_pid_file"), \
                patch.object(ts, "Dispatcher"), \
                patch.object(ts, "ThreadingWebhookServer") as srv_cls, \
                patch.object(sys, "argv", ["trigger-server.py"]):
            srv_cls.return_value.serve_forever.side_effect = KeyboardInterrupt
            with self.assertLogs(level="ERROR") as cm:
                ts.main()
        self.assertTrue(
            any("identical to the webhook secret" in line for line in cm.output),
            cm.output,
        )
        # The token was discarded: /jobs is disabled, not satisfied by the HMAC.
        self.assertEqual(ts.WebhookHandler.api_token, "")
        self.assertEqual(ts.WebhookHandler.secret, "same-string")

    def test_startup_keeps_a_distinct_token(self):
        """Sanity: the guard only fires on equality, not on any token at all."""
        self._isolate_handler_class_attrs()
        env = {"LOKI_API_TOKEN": "api-side", "GITHUB_WEBHOOK_SECRET": "hmac-side"}
        with patch.dict(os.environ, env, clear=False), \
                patch.object(ts, "save_config"), \
                patch.object(ts, "write_pid_file"), \
                patch.object(ts, "Dispatcher"), \
                patch.object(ts, "ThreadingWebhookServer") as srv_cls, \
                patch.object(sys, "argv", ["trigger-server.py"]):
            srv_cls.return_value.serve_forever.side_effect = KeyboardInterrupt
            ts.main()
        self.assertEqual(ts.WebhookHandler.api_token, "api-side")


class TestSuccessfulSubmit(_JobsTestBase):
    """Requirement 3: correct token -> enqueued, id returned, poll-able."""

    def test_submit_returns_id_and_dispatches(self):
        srv = self.start()
        status, body = srv.submit("owner/repo#42")
        self.assertEqual(status, 202)
        data = json.loads(body)
        self.assertTrue(data["id"])
        self.assertEqual(data["status"], "queued")

        self.assertTrue(self.fired.wait(timeout=5))
        self.disp.queue.join()
        # Enqueued the same job shape the webhook path produces: `loki start`
        # with the spec as ONE argv element.
        self.assertEqual(len(self.dispatched), 1)
        self.assertEqual(self.dispatched[0], ["start", "owner/repo#42", "--detach"])

    def test_job_status_is_pollable(self):
        srv = self.start()
        status, body = srv.submit("owner/repo#7")
        self.assertEqual(status, 202)
        job_id = json.loads(body)["id"]

        self.assertTrue(self.fired.wait(timeout=5))
        self.disp.queue.join()

        status, body = srv.request("GET", "/jobs/" + job_id, headers={
            "Authorization": "Bearer " + API_TOKEN,
        })
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data["id"], job_id)
        self.assertEqual(data["status"], ts.JOB_STATUS_PASSED)
        self.assertIn("owner/repo#7", data["summary"])

    def test_terminal_status_is_not_clobbered_by_the_queued_write(self):
        """A finished job must never poll as "queued" forever.

        record_job is last-writer-wins, and a worker can pick the job up the
        instant submit() returns. If the handler wrote "queued" AFTER
        enqueueing, that write could land on top of the worker's terminal
        terminal status and the client would poll a completed job as queued
        forever.

        Reproduced deterministically by making the worker's terminal write land
        before the handler's enqueue call returns: submit() is wrapped so that
        the worker's whole lifecycle (running -> fired) completes inside it.
        Ordering the handler's record BEFORE submit() is what makes this safe.
        """
        srv = self.start(workers=1)
        real_submit = self.disp.submit
        done = threading.Event()

        def submit_then_wait(event_type, payload):
            accepted = real_submit(event_type, payload)
            # Let the worker fully process it (and write the terminal status)
            # before this call returns to the handler.
            if accepted:
                done.wait(timeout=5)
            return accepted

        original_record = self.disp.record_job

        def record_and_signal(job_id, status, summary=""):
            original_record(job_id, status, summary)
            if status in ts.JOB_TERMINAL_STATUSES:
                done.set()

        with patch.object(self.disp, "record_job", side_effect=record_and_signal), \
                patch.object(self.disp, "submit", side_effect=submit_then_wait):
            status, body = srv.submit("owner/repo#5")

        self.assertEqual(status, 202)
        job_id = json.loads(body)["id"]
        self.assertTrue(done.is_set(), "worker never reached a terminal status")
        self.disp.queue.join()

        job = self.disp.get_job(job_id)
        self.assertIsNotNone(job)
        self.assertEqual(
            job["status"], ts.JOB_STATUS_PASSED,
            "terminal status was clobbered by the handler's queued write",
        )

    def test_job_ids_are_unique_and_unguessable(self):
        srv = self.start()
        ids = set()
        for _ in range(5):
            status, body = srv.submit("owner/repo#1")
            self.assertEqual(status, 202)
            ids.add(json.loads(body)["id"])
        self.assertEqual(len(ids), 5)
        # Not a sequential counter an attacker could enumerate.
        self.assertTrue(all(len(i) >= 12 for i in ids))

    def test_unknown_job_id_is_404(self):
        srv = self.start()
        status, _ = srv.request("GET", "/jobs/does-not-exist", headers={
            "Authorization": "Bearer " + API_TOKEN,
        })
        self.assertEqual(status, 404)

    def test_job_status_requires_the_token(self):
        # A status record echoes the spec text, so it is not public.
        srv = self.start()
        _, body = srv.submit("owner/repo#3")
        job_id = json.loads(body)["id"]
        status, _ = srv.request("GET", "/jobs/" + job_id)
        self.assertEqual(status, 401)


class TestSubmitRejectsBadInput(_JobsTestBase):
    """Requirement 5, over real HTTP: bad specs never reach the queue."""

    def test_oversized_spec_rejected(self):
        srv = self.start()
        status, _ = srv.submit("a" * (ts.MAX_SPEC_BYTES + 10))
        self.assertEqual(status, 400)
        self.disp.queue.join()
        self.assertEqual(self.dispatched, [])

    def test_control_character_spec_rejected(self):
        srv = self.start()
        status, _ = srv.submit("owner/repo\x00#1")
        self.assertEqual(status, 400)
        self.disp.queue.join()
        self.assertEqual(self.dispatched, [])

    def test_flag_injection_spec_rejected(self):
        srv = self.start()
        status, _ = srv.submit("--config=/etc/shadow")
        self.assertEqual(status, 400)
        self.disp.queue.join()
        self.assertEqual(self.dispatched, [])

    def test_missing_and_non_string_spec_rejected(self):
        srv = self.start()
        for payload in ({}, {"spec": None}, {"spec": 5}, {"spec": ["a"]}):
            body = json.dumps(payload).encode()
            status, _ = srv.request("POST", "/jobs", body=body, headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + API_TOKEN,
            })
            self.assertEqual(status, 400, repr(payload))
        self.disp.queue.join()
        self.assertEqual(self.dispatched, [])

    def test_invalid_json_rejected(self):
        srv = self.start()
        status, _ = srv.request("POST", "/jobs", body=b"{not json", headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + API_TOKEN,
        })
        self.assertEqual(status, 400)

    def test_non_object_json_rejected(self):
        srv = self.start()
        status, _ = srv.request("POST", "/jobs", body=b'["spec"]', headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + API_TOKEN,
        })
        self.assertEqual(status, 400)

    def test_oversized_body_rejected_before_auth(self):
        srv = self.start()
        conn = http.client.HTTPConnection("127.0.0.1", srv.port, timeout=10)
        conn.putrequest("POST", "/jobs")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length",
                       str(ts.WebhookHandler.MAX_BODY_BYTES + 1))
        conn.endheaders()
        resp = conn.getresponse()
        self.assertEqual(resp.status, 413)
        resp.read()
        conn.close()


class TestQueueBound(_JobsTestBase):
    """Requirement 6: a submit storm is shed with 429, never dropped silently."""

    def test_queue_full_returns_429(self):
        release = threading.Event()

        def blocking_run(args, dry_run=False):
            release.wait(timeout=10)
            return ts.OUTCOME_PASSED

        patch.stopall()
        patch.object(ts, "send_notification").start()
        patch.object(ts, "run_loki_outcome", side_effect=blocking_run).start()

        # 1 worker + queue of 1 -> capacity 2 in flight, the rest are shed.
        srv = self.start(workers=1, queue_size=1)
        try:
            codes = [srv.submit("owner/repo#1")[0] for _ in range(6)]
            self.assertIn(429, codes)
            # Never a silent drop: every request got an explicit code.
            self.assertTrue(all(c in (202, 429) for c in codes), codes)
            # And 429 is distinct from the webhook path's 503.
            self.assertNotIn(503, codes)
        finally:
            release.set()
            self.disp.queue.join()

    def test_shed_submit_gets_no_job_id(self):
        release = threading.Event()

        patch.stopall()
        patch.object(ts, "send_notification").start()
        patch.object(ts, "run_loki_outcome",
                     side_effect=lambda *a, **k: release.wait(timeout=10)
                     and ts.OUTCOME_PASSED).start()

        srv = self.start(workers=1, queue_size=1)
        try:
            shed_body = None
            for _ in range(6):
                status, body = srv.submit("owner/repo#1")
                if status == 429:
                    shed_body = body
                    break
            self.assertIsNotNone(shed_body, "queue never filled")
            self.assertNotIn(b"\"id\"", shed_body)
        finally:
            release.set()
            self.disp.queue.join()


class TestBuildOutcomeIsReported(unittest.TestCase):
    """A remote client gates CI on this, so "launched" must never read as "passed".

    THE BUG THIS PINS: handle_job_event used to derive its status from
    run_loki_command, which returns True when the LAUNCH succeeded -- including
    the detach-timeout path. So a build that started and then FAILED reported
    "fired" and a CI pipeline gating on it went green on a failed build.
    """

    def setUp(self):
        patch.object(ts, "send_notification").start()
        patch.object(ts, "log_event").start()

    def tearDown(self):
        patch.stopall()

    def _outcome_for(self, exit_code=0, launch_error=None, hang=False):
        """Drive the real run_loki_outcome against a stubbed child process."""
        import subprocess as real_subprocess
        real_popen = real_subprocess.Popen

        def fake_popen(cmd, **kwargs):
            if launch_error is not None:
                raise launch_error
            script = "import time; time.sleep(5)" if hang else \
                     "import sys; sys.exit(%d)" % exit_code
            return real_popen([sys.executable, "-c", script], **kwargs)

        with patch("subprocess.Popen", side_effect=fake_popen), \
                patch.object(ts, "DISPATCH_WAIT_SECONDS", 0.3):
            return ts.run_loki_outcome(["start", "spec", "--detach"])

    def test_exit_zero_is_passed(self):
        self.assertEqual(self._outcome_for(exit_code=0), ts.OUTCOME_PASSED)

    def test_nonzero_exit_is_failed(self):
        # THE BUG: this used to be indistinguishable from a pass.
        self.assertEqual(self._outcome_for(exit_code=1), ts.OUTCOME_FAILED)

    def test_launch_failure_is_failed(self):
        self.assertEqual(
            self._outcome_for(launch_error=FileNotFoundError("no loki")),
            ts.OUTCOME_FAILED,
        )

    def test_detached_build_is_unknown_not_passed(self):
        """Fail closed: an outcome we never observed is NOT a pass."""
        outcome = self._outcome_for(hang=True)
        self.assertEqual(outcome, ts.OUTCOME_UNKNOWN)
        self.assertNotEqual(outcome, ts.OUTCOME_PASSED)

    def test_terminal_statuses_are_all_distinct(self):
        # "launched" and "passed" must never share a value.
        self.assertEqual(len(set(ts.JOB_TERMINAL_STATUSES)), 3)
        self.assertIn(ts.JOB_STATUS_PASSED, ts.JOB_TERMINAL_STATUSES)
        self.assertIn(ts.JOB_STATUS_UNKNOWN, ts.JOB_TERMINAL_STATUSES)

    def test_in_flight_statuses_are_not_terminal(self):
        # A client must tell "not done yet" from "done and failed".
        self.assertNotIn("queued", ts.JOB_TERMINAL_STATUSES)
        self.assertNotIn("running", ts.JOB_TERMINAL_STATUSES)

    def test_handler_reports_the_build_outcome(self):
        for outcome in (ts.OUTCOME_PASSED, ts.OUTCOME_FAILED, ts.OUTCOME_UNKNOWN):
            with patch.object(ts, "run_loki_outcome", return_value=outcome):
                _, status = ts.handle_job_event({"spec": "x", "job_id": "j"})
            self.assertEqual(status, outcome)

    def test_webhook_handlers_keep_launch_semantics(self):
        """The webhook path only cares that a dispatch started; unchanged."""
        with patch.object(ts, "run_loki_outcome", return_value=ts.OUTCOME_UNKNOWN):
            self.assertTrue(ts.run_loki_command(["start"]))
        with patch.object(ts, "run_loki_outcome", return_value=ts.OUTCOME_FAILED):
            self.assertFalse(ts.run_loki_command(["start"]))


class TestWebhookCannotWriteJobStatus(unittest.TestCase):
    """A webhook payload must not reach the /jobs status store.

    _worker honoured job_id from ANY payload, so a holder of the WEBHOOK HMAC
    could POST a crafted GitHub payload carrying a top-level job_id and
    overwrite a real submitted job's terminal status -- turning a "passed" back
    into "fired" and re-introducing the false-green this work exists to remove.
    A webhook credential must never reach a /jobs capability.
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_cwd = os.getcwd()
        os.chdir(self.tmpdir)
        patch.object(ts, "send_notification").start()
        patch.object(ts, "log_event").start()
        patch.object(ts, "run_loki_command", return_value=True).start()
        patch.object(ts, "run_loki_outcome", return_value=ts.OUTCOME_PASSED).start()

    def tearDown(self):
        patch.stopall()
        os.chdir(self.orig_cwd)

    def test_webhook_payload_cannot_overwrite_a_job_status(self):
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True)
        try:
            disp.record_job("real-job", ts.JOB_STATUS_PASSED, "a real build")
            # A GitHub payload smuggling a top-level job_id.
            disp.submit("issues", {
                "action": "opened",
                "issue": {"number": 1},
                "repository": {"full_name": "o/r"},
                "job_id": "real-job",
            })
            disp.queue.join()
            job = disp.get_job("real-job")
            self.assertEqual(
                job["status"], ts.JOB_STATUS_PASSED,
                "a webhook payload overwrote a submitted job's terminal status",
            )
        finally:
            disp.shutdown()

    def test_webhook_payload_cannot_create_a_job_record(self):
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True)
        try:
            disp.submit("issues", {
                "action": "opened",
                "issue": {"number": 1},
                "repository": {"full_name": "o/r"},
                "job_id": "invented-by-webhook",
            })
            disp.queue.join()
            self.assertIsNone(disp.get_job("invented-by-webhook"))
        finally:
            disp.shutdown()

    def test_a_real_job_still_records_its_status(self):
        # Sanity: the gate must not break the path it protects.
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True)
        try:
            disp.submit(ts.JOB_EVENT, {"spec": "x", "job_id": "mine"})
            disp.queue.join()
            self.assertEqual(disp.get_job("mine")["status"], ts.JOB_STATUS_PASSED)
        finally:
            disp.shutdown()


class TestJobRecordsAreBounded(unittest.TestCase):
    """The status store cannot grow without limit under a submit storm."""

    def test_oldest_records_are_evicted(self):
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True,
                             job_history=3)
        try:
            for i in range(5):
                disp.record_job("job-%d" % i, "queued")
            self.assertIsNone(disp.get_job("job-0"))
            self.assertIsNotNone(disp.get_job("job-4"))
        finally:
            disp.shutdown()

    def test_update_does_not_duplicate_a_record(self):
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True,
                             job_history=3)
        try:
            disp.record_job("j", "queued", "spec")
            disp.record_job("j", "running")
            disp.record_job("j", "passed", "done")
            job = disp.get_job("j")
            self.assertEqual(job["status"], "passed")
            self.assertEqual(job["summary"], "done")
        finally:
            disp.shutdown()


class TestApiTokenSources(unittest.TestCase):
    """The token comes from env or a mounted file, never argv or config.json."""

    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=False)
        self.env.start()
        os.environ.pop("LOKI_API_TOKEN", None)
        os.environ.pop("LOKI_API_TOKEN_FILE", None)

    def tearDown(self):
        self.env.stop()

    def test_unset_returns_empty(self):
        self.assertEqual(ts.load_api_token(), "")

    def test_env_var(self):
        os.environ["LOKI_API_TOKEN"] = "from-env"
        self.assertEqual(ts.load_api_token(), "from-env")

    def test_file_is_stripped(self):
        # A Kubernetes mounted secret ends with a newline; unstripped, every
        # comparison would fail.
        with tempfile.NamedTemporaryFile("w", suffix=".token", delete=False) as f:
            f.write("from-file\n")
            path = f.name
        try:
            os.environ["LOKI_API_TOKEN_FILE"] = path
            self.assertEqual(ts.load_api_token(), "from-file")
        finally:
            os.unlink(path)

    def test_unreadable_file_returns_empty_not_crash(self):
        os.environ["LOKI_API_TOKEN_FILE"] = "/nonexistent/token"
        with self.assertLogs(level="ERROR"):
            self.assertEqual(ts.load_api_token(), "")

    def test_no_cli_flag_exposes_the_token(self):
        # A CLI arg would land in the process list for any local user to read.
        source = (Path(__file__).parent.parent /
                  "autonomy" / "trigger-server.py").read_text()
        self.assertNotIn('add_argument("--api-token"', source)
        self.assertNotIn("add_argument('--api-token'", source)


def _write_proof(tmpdir, run_id, proof, set_pointer=True):
    """Emulate a build writing .loki/proofs/<run_id>/proof.json + the pointer.

    This is what generate_proof_of_run does in run.sh: emit the receipt, then
    atomically write .loki/state/last-proof-id.txt naming the directory. The
    server observes that pointer; it cannot predict the run id.
    """
    d = Path(tmpdir) / ".loki" / "proofs" / run_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "proof.json").write_text(json.dumps(proof))
    if set_pointer:
        state = Path(tmpdir) / ".loki" / "state"
        state.mkdir(parents=True, exist_ok=True)
        (state / "last-proof-id.txt").write_text(run_id)
    return d


class TestJobProofEndpoint(_JobsTestBase):
    """GET /jobs/<id>/proof -- the remote Evidence Receipt.

    The endpoint's entire value is that a submitter can check a build without
    trusting the machine that ran it. Two properties carry that: it is
    fail-closed like every other /jobs route, and it NEVER synthesizes or
    borrows a receipt -- an unattributable job must 404.
    """

    def _run_job_writing_proof(self, proof, run_id="run-20260808-1-1",
                               set_pointer=True):
        """Submit a job whose fake build writes a receipt, and return its id."""
        tmpdir = self.tmpdir

        # THE TIMING THAT MATTERS. handle_job_event dispatches `loki start
        # --detach`, which returns as soon as the child forks; the build then
        # runs for minutes and writes its receipt at the very END. A fixture
        # that writes the proof inline would make the receipt appear before the
        # dispatch returns -- and an implementation that resolved attribution
        # at dispatch-return would pass that fixture while 404-ing on every
        # real build. So the write happens on a timer, AFTER fake_run returns.
        done = threading.Event()

        def write_later():
            _write_proof(tmpdir, run_id, proof, set_pointer=set_pointer)
            done.set()

        def fake_run(args, dry_run=False):
            threading.Timer(0.2, write_later).start()
            self.fired.set()
            return ts.OUTCOME_PASSED

        patch.object(ts, "run_loki_outcome", side_effect=fake_run).start()
        self.addCleanup(done.wait, 5)
        srv = self.start(workers=1)
        status, data = srv.submit("./prd.md")
        self.assertEqual(status, 202)
        job_id = json.loads(data)["id"]
        self.assertTrue(self.fired.wait(timeout=10))
        self.disp.queue.join()
        # Wait for the receipt the detached "build" writes after dispatch
        # returned, mirroring a client that polls until the job is terminal.
        self.assertTrue(done.wait(timeout=10))
        return srv, job_id

    def test_fail_closed_without_a_token(self):
        # Same rule as POST /jobs: no token configured -> 503, never a receipt.
        srv = self.start(api_token="")
        status, _ = srv.request("GET", "/jobs/anything/proof")
        self.assertEqual(status, 503)

    def test_missing_bearer_is_401(self):
        srv = self.start()
        status, _ = srv.request("GET", "/jobs/anything/proof")
        self.assertEqual(status, 401)

    def test_wrong_token_is_401(self):
        srv = self.start()
        status, _ = srv.request(
            "GET", "/jobs/anything/proof",
            headers={"Authorization": "Bearer wrong-token"})
        self.assertEqual(status, 401)

    def test_unknown_job_is_404(self):
        srv = self.start()
        status, _ = srv.request(
            "GET", "/jobs/no-such-job/proof",
            headers={"Authorization": "Bearer " + API_TOKEN})
        self.assertEqual(status, 404)

    def test_job_with_no_proof_is_404_never_synthesized(self):
        # THE LOAD-BEARING ABSENCE CASE. A build that wrote no receipt must
        # yield nothing. A synthesized receipt would be a fabricated claim
        # about a build that produced no evidence.
        srv = self.start(workers=1)
        status, data = srv.submit("./prd.md")
        job_id = json.loads(data)["id"]
        self.assertTrue(self.fired.wait(timeout=10))
        self.disp.queue.join()
        status, body = srv.request(
            "GET", "/jobs/%s/proof" % job_id,
            headers={"Authorization": "Bearer " + API_TOKEN})
        self.assertEqual(status, 404)
        self.assertNotIn("verification", body.decode())

    def test_returns_the_proof_unwrapped(self):
        # Unwrapped is load-bearing: the integrity hash is computed over the
        # receipt with `verification` stripped, so an outer envelope written to
        # disk would make every honest receipt recompute to a different hash
        # and read as TAMPERED.
        proof = {"run_id": "r1", "facts": {"a": 1},
                 "verification": {"hash": "abc", "algo": "sha256"}}
        srv, job_id = self._run_job_writing_proof(proof)
        status, body = srv.request(
            "GET", "/jobs/%s/proof" % job_id,
            headers={"Authorization": "Bearer " + API_TOKEN})
        self.assertEqual(status, 200)
        got = json.loads(body)
        self.assertEqual(got, proof)
        self.assertEqual(got["verification"]["hash"], "abc")

    def test_signature_is_carried_through(self):
        # The detached signature lives INSIDE proof.json. If the endpoint drops
        # it, every signed remote receipt silently degrades to UNSIGNED.
        proof = {"run_id": "r1",
                 "verification": {"hash": "abc", "gpg_signature": "-----BEGIN-----"}}
        srv, job_id = self._run_job_writing_proof(proof)
        _, body = srv.request(
            "GET", "/jobs/%s/proof" % job_id,
            headers={"Authorization": "Bearer " + API_TOKEN})
        self.assertEqual(
            json.loads(body)["verification"]["gpg_signature"], "-----BEGIN-----")

    def test_no_pointer_written_is_404(self):
        # LOKI_PROVEN_PR=0 suppresses the pointer. The proof dir may exist, but
        # nothing attributes it to this job, so we must not go looking for the
        # newest directory under .loki/proofs/ and serve that.
        proof = {"run_id": "r1", "verification": {"hash": "abc"}}
        srv, job_id = self._run_job_writing_proof(proof, set_pointer=False)
        status, _ = srv.request(
            "GET", "/jobs/%s/proof" % job_id,
            headers={"Authorization": "Bearer " + API_TOKEN})
        self.assertEqual(status, 404)

    def test_stale_pointer_from_an_earlier_run_is_404(self):
        # A pointer that did NOT change during this job's window names some
        # earlier run's receipt. Serving it would hand the submitter another
        # build's evidence labelled as theirs.
        _write_proof(self.tmpdir, "run-earlier", {"run_id": "earlier"})
        srv = self.start(workers=1)
        _, data = srv.submit("./prd.md")
        job_id = json.loads(data)["id"]
        self.assertTrue(self.fired.wait(timeout=10))
        self.disp.queue.join()
        status, _ = srv.request(
            "GET", "/jobs/%s/proof" % job_id,
            headers={"Authorization": "Bearer " + API_TOKEN})
        self.assertEqual(status, 404)

    def test_status_response_hides_internal_bookkeeping(self):
        # Asserted while the job is MID-FLIGHT, when _proof_before is actually
        # present. Checking only after completion proves nothing: the window
        # keys are popped at the end, so a get_job() that leaked everything
        # would still look clean by then.
        srv = self.start(workers=1)
        _, data = srv.submit("./prd.md")
        job_id = json.loads(data)["id"]
        self.assertTrue(self.fired.wait(timeout=10))
        self.assertIn("_proof_before", self.disp._jobs[job_id],
                      "test premise: the internal key should be present here")
        _, body = srv.request(
            "GET", "/jobs/%s" % job_id,
            headers={"Authorization": "Bearer " + API_TOKEN})
        for key in json.loads(body):
            self.assertFalse(key.startswith("_"),
                             "internal key %r leaked into the status API" % key)


class TestProofAttributionUnderConcurrency(unittest.TestCase):
    """Overlapping jobs must yield NO proof rather than the wrong one.

    The pointer is global to the working directory, so when two builds overlap
    it names whichever finished last. Attributing it to either submitter would
    hand one of them someone else's receipt while labelling it theirs -- worse
    than the 404 an absent receipt already returns.
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_cwd = os.getcwd()
        os.chdir(self.tmpdir)

    def tearDown(self):
        os.chdir(self.orig_cwd)

    def test_overlapping_jobs_refuse_to_attribute(self):
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True)
        try:
            disp.record_job("job-a", "queued")
            disp.record_job("job-b", "queued")
            # Two builds dispatched, then a receipt appears. It belongs to
            # whichever finished last, which nobody here can know.
            disp._begin_proof_window("job-a")
            disp._begin_proof_window("job-b")
            _write_proof(self.tmpdir, "run-x", {"run_id": "x"})
            for job in ("job-a", "job-b"):
                run_id, reason = disp.get_job_proof_id(job)
                self.assertEqual(run_id, "", "%s was misattributed" % job)
            self.assertIn("another build", disp.get_job_proof_id("job-a")[1])
        finally:
            disp.shutdown()

    def test_a_webhook_build_also_spoils_attribution(self):
        # THE HOLE A JOB-ONLY COUNTER LEAVES. Webhook dispatches carry no
        # job_id, but they run `loki start` in the same working directory and
        # write the same global pointer. Uncounted, a webhook build finishing
        # during a submitted job's window would be handed to that submitter as
        # their own evidence.
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True)
        try:
            disp.record_job("job-a", "queued")
            disp._begin_proof_window("job-a")
            disp._begin_proof_window(None)  # a webhook build, no job id
            _write_proof(self.tmpdir, "run-webhook", {"run_id": "webhook"})
            run_id, reason = disp.get_job_proof_id("job-a")
            self.assertEqual(run_id, "",
                             "a webhook build's receipt was attributed to a job")
            self.assertIn("another build", reason)
        finally:
            disp.shutdown()

    def test_uncontended_window_attributes_a_receipt_written_later(self):
        # The receipt appears well AFTER dispatch returns, which is how a
        # detached build behaves. Resolution is lazy, so this still attributes.
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True)
        try:
            disp.record_job("job-a", "queued")
            disp._begin_proof_window("job-a")
            self.assertEqual(disp.get_job_proof_id("job-a")[0], "",
                             "attributed a receipt before one existed")
            _write_proof(self.tmpdir, "run-x", {"run_id": "x"})
            self.assertEqual(disp.get_job_proof_id("job-a")[0], "run-x")
        finally:
            disp.shutdown()

    def test_corrupt_pointer_cannot_name_an_arbitrary_path(self):
        # The pointer is server-written, not request-supplied, so this is
        # defense in depth -- but a corrupt pointer must not traverse. ".." is
        # the sharp case: it passes an alphabet check yet resolves to
        # .loki/proof.json, one level ABOVE the proofs directory.
        state = Path(self.tmpdir) / ".loki" / "state"
        state.mkdir(parents=True, exist_ok=True)
        (state / "last-proof-id.txt").write_text("../../../etc")
        self.assertEqual(ts.read_proof_pointer(), "../../../etc")
        self.assertIsNone(ts.read_proof("../../../etc"))
        loki = Path(self.tmpdir) / ".loki"
        (loki / "proofs").mkdir(parents=True, exist_ok=True)
        (loki / "proof.json").write_text('{"run_id": "escaped"}')
        self.assertIsNone(ts.read_proof(".."))
        self.assertIsNone(ts.read_proof("."))


if __name__ == "__main__":
    unittest.main(verbosity=2)
