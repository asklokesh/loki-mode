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
            return True

        patch.object(ts, "run_loki_command", side_effect=fake_run).start()
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
        with patch.object(ts, "run_loki_command", return_value=True) as m, \
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
        self.assertEqual(data["status"], "fired")
        self.assertIn("owner/repo#7", data["summary"])

    def test_terminal_status_is_not_clobbered_by_the_queued_write(self):
        """A finished job must never poll as "queued" forever.

        record_job is last-writer-wins, and a worker can pick the job up the
        instant submit() returns. If the handler wrote "queued" AFTER
        enqueueing, that write could land on top of the worker's terminal
        "fired" and the client would poll a completed job as queued forever.

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
            if status in ("fired", "error"):
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
            job["status"], "fired",
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
            return True

        patch.stopall()
        patch.object(ts, "send_notification").start()
        patch.object(ts, "run_loki_command", side_effect=blocking_run).start()

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
        patch.object(ts, "run_loki_command",
                     side_effect=lambda *a, **k: release.wait(timeout=10)).start()

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
            disp.record_job("j", "fired", "done")
            job = disp.get_job("j")
            self.assertEqual(job["status"], "fired")
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
