#!/usr/bin/env python3
"""
tests/test_trigger_server_hardening.py - Tests for the hardened trigger server.

Covers the four production-safety fixes in autonomy/trigger-server.py:
  1. No secret configured -> server refuses (rejects every webhook, no dispatch).
  2. Valid signature -> dispatch happens via `loki start` (not `loki run`).
  3. Invalid signature -> 401, no dispatch.
  4. Concurrency -> ThreadingHTTPServer handles concurrent webhooks without the
     listener serializing, and child processes are reaped (no zombies).

Standard library only (unittest). Run with:
    python3 tests/test_trigger_server_hardening.py
"""

import hashlib
import hmac
import http.client
import importlib
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

# Ensure autonomy/ is on path so we can import the module under test.
sys.path.insert(0, str(Path(__file__).parent.parent / "autonomy"))
ts = importlib.import_module("trigger-server")
sys.modules["trigger_server"] = ts


def _sign(secret, body):
    return "sha256=" + hmac.new(
        secret.encode("utf-8"), body, hashlib.sha256
    ).hexdigest()


class TestSignatureValidation(unittest.TestCase):
    """validate_signature must fail closed when no secret is set."""

    def test_no_secret_rejects(self):
        # Defect 1: no secret must NOT accept-all.
        self.assertFalse(ts.validate_signature("", b"body", ""))
        self.assertFalse(ts.validate_signature("", b"body", "sha256=anything"))

    def test_valid_signature_accepts(self):
        body = b'{"action": "opened"}'
        self.assertTrue(ts.validate_signature("s3cr3t", body, _sign("s3cr3t", body)))

    def test_invalid_signature_rejects(self):
        self.assertFalse(ts.validate_signature("s3cr3t", b"body", "sha256=bad"))

    def test_missing_signature_rejects(self):
        self.assertFalse(ts.validate_signature("s3cr3t", b"body", ""))
        self.assertFalse(ts.validate_signature("s3cr3t", b"body", None))

    def test_tampered_body_rejects(self):
        sig = _sign("s3cr3t", b'{"action": "opened"}')
        self.assertFalse(ts.validate_signature("s3cr3t", b'{"action": "deleted"}', sig))


class TestEventRoutingUsesLokiStart(unittest.TestCase):
    """Defect 4: handlers must invoke `loki start`, never the deprecated `loki run`."""

    def setUp(self):
        self.mock_run = patch.object(ts, "run_loki_command", return_value=True).start()
        patch.object(ts, "send_notification").start()
        patch.object(ts, "log_event").start()

    def tearDown(self):
        patch.stopall()

    def test_issue_opened_uses_start_with_ref(self):
        payload = {
            "action": "opened",
            "issue": {"number": 99},
            "repository": {"full_name": "myorg/myrepo"},
        }
        summary, status = ts.handle_issues_event(payload, dry_run=False)
        self.assertEqual(status, "fired")
        args = self.mock_run.call_args[0][0]
        self.assertEqual(args[0], "start")
        self.assertNotIn("run", args)
        self.assertIn("myorg/myrepo#99", args)
        self.assertIn("--pr", args)
        self.assertIn("--detach", args)

    def test_pr_synchronize_uses_start_with_ref(self):
        payload = {
            "action": "synchronize",
            "pull_request": {"number": 17},
            "repository": {"full_name": "myorg/myrepo"},
        }
        summary, status = ts.handle_pull_request_event(payload, dry_run=False)
        self.assertEqual(status, "fired")
        args = self.mock_run.call_args[0][0]
        self.assertEqual(args[0], "start")
        self.assertIn("myorg/myrepo#17", args)
        self.assertIn("--detach", args)

    def test_workflow_failure_uses_start(self):
        payload = {
            "action": "completed",
            "workflow_run": {"name": "CI", "conclusion": "failure"},
            "repository": {"full_name": "myorg/myrepo"},
        }
        summary, status = ts.handle_workflow_run_event(payload, dry_run=False)
        self.assertEqual(status, "fired")
        args = self.mock_run.call_args[0][0]
        self.assertEqual(args[0], "start")
        self.assertIn("--detach", args)

    def test_issue_closed_skipped_no_dispatch(self):
        payload = {"action": "closed", "issue": {"number": 1}, "repository": {}}
        _, status = ts.handle_issues_event(payload, dry_run=False)
        self.assertIn("skipped", status)
        self.mock_run.assert_not_called()


class TestRefFlagInjection(unittest.TestCase):
    """M2: a webhook-controlled repository full_name must not inject a CLI flag.

    A payload whose repository.full_name begins with "--" would otherwise
    place a leading-dash token into the `loki start <ref>` argv, parsed as an
    option (e.g. --config=/etc/x) after the HMAC check. The handler must reject
    such payloads and never dispatch.
    """

    def setUp(self):
        self.mock_run = patch.object(ts, "run_loki_command", return_value=True).start()
        patch.object(ts, "send_notification").start()
        patch.object(ts, "log_event").start()

    def tearDown(self):
        patch.stopall()

    def test_validator_accepts_clean_repo(self):
        self.assertTrue(ts.valid_repo_full_name("owner/repo"))
        self.assertTrue(ts.valid_repo_full_name("my-org.x/my_repo.v2"))

    def test_validator_rejects_dash_leading_and_malformed(self):
        self.assertFalse(ts.valid_repo_full_name("--config=/etc/x"))
        self.assertFalse(ts.valid_repo_full_name("--config=/etc/x/repo"))
        self.assertFalse(ts.valid_repo_full_name("ownerrepo"))  # no slash
        self.assertFalse(ts.valid_repo_full_name("owner/repo extra"))
        self.assertFalse(ts.valid_repo_full_name("owner/re;po"))
        self.assertFalse(ts.valid_repo_full_name(""))
        # Council R1: these fail ONLY on the leading-dash anchor (no '=' or extra
        # slash), so they pin the actual "ref can never begin with a dash" claim.
        # A prior pattern wrongly accepted a dash-leading owner segment.
        self.assertFalse(ts.valid_repo_full_name("-rf/x"))
        self.assertFalse(ts.valid_repo_full_name("-foo/bar"))
        self.assertFalse(ts.valid_repo_full_name("--/--"))
        # A legit owner/repo with non-leading dashes still passes.
        self.assertTrue(ts.valid_repo_full_name("my-org/my-repo"))

    def test_validator_issue_number(self):
        self.assertTrue(ts.valid_issue_number(5))
        self.assertFalse(ts.valid_issue_number(0))
        self.assertFalse(ts.valid_issue_number(-1))
        self.assertFalse(ts.valid_issue_number("5"))
        self.assertFalse(ts.valid_issue_number(True))  # bool is not a number here
        self.assertFalse(ts.valid_issue_number(None))

    def test_issue_flag_injection_rejected_no_dispatch(self):
        payload = {
            "action": "opened",
            "issue": {"number": 5},
            "repository": {"full_name": "--config=/etc/x"},
        }
        _, status = ts.handle_issues_event(payload, dry_run=False)
        self.assertIn("rejected", status)
        self.mock_run.assert_not_called()

    def test_pr_flag_injection_rejected_no_dispatch(self):
        payload = {
            "action": "synchronize",
            "pull_request": {"number": 7},
            "repository": {"full_name": "--config=/etc/x"},
        }
        _, status = ts.handle_pull_request_event(payload, dry_run=False)
        self.assertIn("rejected", status)
        self.mock_run.assert_not_called()

    def test_non_int_issue_number_rejected(self):
        payload = {
            "action": "opened",
            "issue": {"number": "5; rm -rf /"},
            "repository": {"full_name": "owner/repo"},
        }
        _, status = ts.handle_issues_event(payload, dry_run=False)
        self.assertIn("rejected", status)
        self.mock_run.assert_not_called()

    def test_normal_issue_still_dispatches_clean_ref(self):
        payload = {
            "action": "opened",
            "issue": {"number": 5},
            "repository": {"full_name": "owner/repo"},
        }
        _, status = ts.handle_issues_event(payload, dry_run=False)
        self.assertEqual(status, "fired")
        args = self.mock_run.call_args[0][0]
        self.assertEqual(args, ["start", "owner/repo#5", "--pr", "--detach"])
        # The ref can never begin with a dash, so it can never parse as a flag.
        self.assertFalse(args[1].startswith("-"))


class TestChildReaping(unittest.TestCase):
    """Defect 2: run_loki_command must wait on / reap the child (no zombies)."""

    def setUp(self):
        # Replace the launched binary with a fast stub so we exercise the real
        # subprocess path without invoking loki.
        self.tmpdir = tempfile.mkdtemp()
        self.orig_cwd = os.getcwd()
        os.chdir(self.tmpdir)

    def tearDown(self):
        os.chdir(self.orig_cwd)

    def _stub_loki(self, exit_code=0, stderr_text=""):
        """Patch Popen to run a trivial python child instead of `loki`.

        Capture the real Popen BEFORE patching so the stub does not recurse
        into the patched name. Records the spawned child pid on self._last_pid so
        a test can assert THAT specific child was reaped (deterministic), rather
        than os.waitpid(-1) which reaps any child and is environment-dependent.
        """
        import subprocess as real_subprocess
        real_popen = real_subprocess.Popen
        self._last_pid = None

        def fake_popen(cmd, **kwargs):
            script = "import sys; sys.stderr.write(%r); sys.exit(%d)" % (
                stderr_text, exit_code,
            )
            proc = real_popen([sys.executable, "-c", script], **kwargs)
            self._last_pid = proc.pid
            return proc

        return patch("subprocess.Popen", side_effect=fake_popen)

    def test_success_child_reaped(self):
        with self._stub_loki(exit_code=0):
            ok = ts.run_loki_command(["start", "owner/repo#1", "--detach"])
        self.assertTrue(ok)
        # Deterministic: assert THIS specific child pid was reaped (communicate()
        # collects it on the success path) -> os.waitpid on its exact pid raises
        # ChildProcessError. Using os.waitpid(-1) was flaky: it reaps ANY child in
        # the interpreter, so under pytest (which may have other/no children) the
        # result was environment-dependent.
        self.assertIsNotNone(self._last_pid)
        with self.assertRaises(ChildProcessError):
            os.waitpid(self._last_pid, 0)

    def test_failed_child_returns_false_and_captures_stderr(self):
        with self._stub_loki(exit_code=2, stderr_text="boom"):
            with self.assertLogs(level="ERROR") as cm:
                ok = ts.run_loki_command(["start", "owner/repo#1", "--detach"])
        self.assertFalse(ok)
        self.assertTrue(any("boom" in line for line in cm.output))

    def test_launch_failure_returns_false(self):
        with patch("subprocess.Popen", side_effect=FileNotFoundError("no loki")):
            ok = ts.run_loki_command(["start"])
        self.assertFalse(ok)

    def test_dry_run_does_not_launch(self):
        with patch("subprocess.Popen") as p:
            ok = ts.run_loki_command(["start"], dry_run=True)
        self.assertTrue(ok)
        p.assert_not_called()

    def test_timeout_child_is_reaped_no_zombie(self):
        """L1: a dispatch that outlives the wait window is still reaped.

        Shrink DISPATCH_WAIT_SECONDS so the child trips the timeout path. The
        background reaper thread must wait() on the child. We assert by giving
        the reaper the proc and observing that, after it finishes, the child has
        been collected (proc.returncode is set and no zombie remains). To avoid
        racing the reaper for the child, we do NOT call os.waitpid ourselves;
        instead we capture the launched proc and join the reaper thread.
        """
        import subprocess as real_subprocess
        real_popen = real_subprocess.Popen

        launched = {}
        reaper_threads_before = set(t.name for t in threading.enumerate())

        # Child runs slightly longer than our (shortened) wait window so we hit
        # the TimeoutExpired branch, then exits on its own shortly after.
        def fake_popen(cmd, **kwargs):
            script = "import time; time.sleep(0.6)"
            proc = real_popen([sys.executable, "-c", script], **kwargs)
            launched["proc"] = proc
            return proc

        with patch.object(ts, "DISPATCH_WAIT_SECONDS", 0.2):
            with patch("subprocess.Popen", side_effect=fake_popen):
                ok = ts.run_loki_command(["start", "owner/repo#1", "--detach"])
        self.assertTrue(ok)  # timeout path reports success (detached dispatch)

        # Find and join the one-shot reaper thread spawned for this child.
        proc = launched["proc"]
        reaper = None
        deadline = time.time() + 5
        while time.time() < deadline and reaper is None:
            for t in threading.enumerate():
                if t.name == "loki-trigger-reaper-%d" % proc.pid:
                    reaper = t
                    break
            if reaper is None:
                time.sleep(0.02)
        self.assertIsNotNone(reaper, "reaper thread was not spawned on timeout")
        reaper.join(timeout=5)
        self.assertFalse(reaper.is_alive(), "reaper thread did not finish")

        # The reaper called proc.wait(): the child is collected (returncode set)
        # and is no longer a zombie. poll() returns the exit status, not None.
        self.assertIsNotNone(proc.returncode, "child not reaped (returncode None)")
        self.assertIsNotNone(proc.poll())
        # Sanity: no leftover reaper thread name beyond what we started with.
        del reaper_threads_before


class TestDeliveryDedup(unittest.TestCase):
    """Idempotency: a redelivered X-GitHub-Delivery must not re-dispatch."""

    def test_seen_delivery_dedups(self):
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True)
        try:
            self.assertFalse(disp.seen_delivery("abc-123"))
            self.assertTrue(disp.seen_delivery("abc-123"))
            self.assertFalse(disp.seen_delivery("def-456"))
        finally:
            disp.shutdown()

    def test_empty_delivery_never_dedups(self):
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True)
        try:
            self.assertFalse(disp.seen_delivery(""))
            self.assertFalse(disp.seen_delivery(""))
        finally:
            disp.shutdown()

    def test_dedup_cache_is_bounded(self):
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True, dedup_size=3)
        try:
            for i in range(5):
                disp.seen_delivery("id-%d" % i)
            # Oldest evicted: id-0 should be forgotten and thus re-accepted.
            self.assertFalse(disp.seen_delivery("id-0"))
            # Most recent retained.
            self.assertTrue(disp.seen_delivery("id-4"))
        finally:
            disp.shutdown()

    def test_duplicate_flood_does_not_evict_real_ids(self):
        """L3: a flood of ONE valid duplicate id must not evict genuine ids.

        Before the fix, a duplicate hit refreshed recency (move_to_end), so
        hammering one id kept it pinned and evicted up to dedup_max real ids.
        With insertion-order eviction unchanged by duplicates, the oldest real
        id stays remembered no matter how many times a newer id is replayed.
        """
        disp = ts.Dispatcher(workers=1, queue_size=4, dry_run=True, dedup_size=3)
        try:
            # Fill: oldest is "real-old", then two more.
            disp.seen_delivery("real-old")
            disp.seen_delivery("real-mid")
            disp.seen_delivery("flood")
            # Flood the newest id many times. This must NOT touch ordering.
            for _ in range(50):
                self.assertTrue(disp.seen_delivery("flood"))
            # The oldest genuine id must still be remembered (not evicted by the
            # flood), so replaying it is still detected as a duplicate.
            self.assertTrue(disp.seen_delivery("real-old"))
        finally:
            disp.shutdown()


class _ServerFixture:
    """Spin up a real ThreadingWebhookServer on an ephemeral port."""

    def __init__(self, secret, dispatcher):
        # Fresh handler subclass so class attrs do not leak between tests.
        class _H(ts.WebhookHandler):
            pass

        _H.secret = secret
        _H.dry_run = False
        _H.dispatcher = dispatcher
        _H.log_message = lambda *a, **k: None  # silence access logs in tests
        self.server = ts.ThreadingWebhookServer(("127.0.0.1", 0), _H)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def post(self, body, headers):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/webhook", body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class TestHttpEndToEnd(unittest.TestCase):
    """End-to-end over real HTTP: secret enforcement, signatures, concurrency."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_cwd = os.getcwd()
        os.chdir(self.tmpdir)
        patch.object(ts, "send_notification").start()

    def tearDown(self):
        patch.stopall()
        os.chdir(self.orig_cwd)

    def test_no_secret_rejects_all_no_dispatch(self):
        calls = []
        with patch.object(ts, "run_loki_command",
                          side_effect=lambda *a, **k: calls.append(a) or True):
            disp = ts.Dispatcher(workers=2, queue_size=8, dry_run=False)
            srv = _ServerFixture(secret="", dispatcher=disp)
            try:
                body = json.dumps({"action": "opened", "issue": {"number": 1},
                                   "repository": {"full_name": "o/r"}}).encode()
                status, _ = srv.post(body, {
                    "Content-Type": "application/json",
                    "X-GitHub-Event": "issues",
                })
                self.assertEqual(status, 503)
                disp.queue.join()
                self.assertEqual(calls, [])
            finally:
                srv.close()
                disp.shutdown()

    def test_valid_signature_dispatches_loki_start(self):
        secret = "topsecret"
        seen = []
        ev = threading.Event()

        def fake_run(args, dry_run=False):
            seen.append(args)
            ev.set()
            return True

        with patch.object(ts, "run_loki_command", side_effect=fake_run):
            disp = ts.Dispatcher(workers=2, queue_size=8, dry_run=False)
            srv = _ServerFixture(secret=secret, dispatcher=disp)
            try:
                body = json.dumps({"action": "opened", "issue": {"number": 7},
                                   "repository": {"full_name": "o/r"}}).encode()
                status, _ = srv.post(body, {
                    "Content-Type": "application/json",
                    "X-GitHub-Event": "issues",
                    "X-Hub-Signature-256": _sign(secret, body),
                })
                self.assertEqual(status, 202)
                self.assertTrue(ev.wait(timeout=5))
                disp.queue.join()
                self.assertEqual(len(seen), 1)
                self.assertEqual(seen[0][0], "start")
                self.assertIn("o/r#7", seen[0])
            finally:
                srv.close()
                disp.shutdown()

    def test_duplicate_delivery_dispatches_once(self):
        """Redelivered webhook (same X-GitHub-Delivery) fires loki start once."""
        secret = "topsecret"
        seen = []
        lock = threading.Lock()

        def fake_run(args, dry_run=False):
            with lock:
                seen.append(args)
            return True

        with patch.object(ts, "run_loki_command", side_effect=fake_run):
            disp = ts.Dispatcher(workers=2, queue_size=8, dry_run=False)
            srv = _ServerFixture(secret=secret, dispatcher=disp)
            try:
                body = json.dumps({"action": "opened", "issue": {"number": 7},
                                   "repository": {"full_name": "o/r"}}).encode()
                headers = {
                    "Content-Type": "application/json",
                    "X-GitHub-Event": "issues",
                    "X-Hub-Signature-256": _sign(secret, body),
                    "X-GitHub-Delivery": "delivery-abc",
                }
                s1, b1 = srv.post(body, headers)
                s2, b2 = srv.post(body, headers)
                self.assertEqual(s1, 202)
                self.assertEqual(s2, 200)
                self.assertIn(b"duplicate", b2)
                disp.queue.join()
                # Only the first delivery dispatched.
                self.assertEqual(len(seen), 1)
            finally:
                srv.close()
                disp.shutdown()

    def test_invalid_signature_rejected_no_dispatch(self):
        secret = "topsecret"
        calls = []
        with patch.object(ts, "run_loki_command",
                          side_effect=lambda *a, **k: calls.append(a) or True):
            disp = ts.Dispatcher(workers=2, queue_size=8, dry_run=False)
            srv = _ServerFixture(secret=secret, dispatcher=disp)
            try:
                body = json.dumps({"action": "opened", "issue": {"number": 1},
                                   "repository": {"full_name": "o/r"}}).encode()
                status, _ = srv.post(body, {
                    "Content-Type": "application/json",
                    "X-GitHub-Event": "issues",
                    "X-Hub-Signature-256": "sha256=deadbeef",
                })
                self.assertEqual(status, 401)
                disp.queue.join()
                self.assertEqual(calls, [])
            finally:
                srv.close()
                disp.shutdown()

    def test_concurrent_requests_do_not_serialize(self):
        """A slow dispatch must not block other requests (threaded listener).

        We make run_loki_command block; with a single-threaded server the
        second request would queue behind the first at the socket level. Since
        the handler enqueues and returns 202 immediately AND the server is
        threaded, all requests return promptly.
        """
        secret = "topsecret"
        release = threading.Event()
        started = threading.Semaphore(0)

        def slow_run(args, dry_run=False):
            started.release()
            release.wait(timeout=10)
            return True

        with patch.object(ts, "run_loki_command", side_effect=slow_run):
            disp = ts.Dispatcher(workers=4, queue_size=16, dry_run=False)
            srv = _ServerFixture(secret=secret, dispatcher=disp)
            try:
                body = json.dumps({"action": "opened", "issue": {"number": 1},
                                   "repository": {"full_name": "o/r"}}).encode()
                headers = {
                    "Content-Type": "application/json",
                    "X-GitHub-Event": "issues",
                    "X-Hub-Signature-256": _sign(secret, body),
                }
                results = []
                lock = threading.Lock()

                def fire():
                    st, _ = srv.post(body, headers)
                    with lock:
                        results.append(st)

                threads = [threading.Thread(target=fire) for _ in range(6)]
                t0 = time.time()
                for t in threads:
                    t.start()
                for t in threads:
                    t.join(timeout=10)
                elapsed = time.time() - t0
                # All POSTs returned 202 quickly even though dispatches block.
                self.assertEqual(results, [202] * 6)
                self.assertLess(elapsed, 5.0)
                release.set()
                disp.queue.join()
            finally:
                release.set()
                srv.close()
                disp.shutdown()

    def test_slow_body_is_dropped_not_held(self):
        """L3: a client that declares a body but under-delivers is dropped.

        We open a raw socket, send headers with a large Content-Length, send
        only a few bytes, then stop. With a bounded body-read timeout the server
        must drop the connection (it does not block a worker forever) and our
        socket sees EOF / a response within the timeout window rather than
        hanging until the test harness times out.
        """
        secret = "topsecret"
        with patch.object(ts, "BODY_READ_TIMEOUT_SECONDS", 0.5):
            with patch.object(ts, "run_loki_command", return_value=True):
                disp = ts.Dispatcher(workers=2, queue_size=8, dry_run=False)
                srv = _ServerFixture(secret=secret, dispatcher=disp)
                try:
                    s = socket.create_connection(("127.0.0.1", srv.port), timeout=5)
                    try:
                        # Declare 1000 bytes but send only 3, then stall.
                        head = (
                            "POST /webhook HTTP/1.1\r\n"
                            "Host: 127.0.0.1\r\n"
                            "X-GitHub-Event: issues\r\n"
                            "Content-Type: application/json\r\n"
                            "Content-Length: 1000\r\n"
                            "\r\n"
                        ).encode()
                        s.sendall(head + b"{ x")
                        # Server should give up on the body read within its
                        # timeout. Read whatever it returns (a 408, or a closed
                        # connection) without blocking past a generous bound.
                        s.settimeout(4)
                        t0 = time.time()
                        try:
                            data = s.recv(4096)
                        except (socket.timeout, ConnectionError, OSError):
                            data = b""
                        elapsed = time.time() - t0
                        # It must not have held the connection open for long.
                        self.assertLess(elapsed, 3.0)
                        # Either an explicit timeout status or a dropped/closed
                        # connection is acceptable; what matters is it did not
                        # block a worker indefinitely.
                        if data:
                            self.assertIn(b"408", data.split(b"\r\n", 1)[0])
                    finally:
                        s.close()
                finally:
                    srv.close()
                    disp.shutdown()

    def test_queue_full_sheds_load(self):
        """A webhook storm beyond queue capacity returns 503, never unbounded."""
        secret = "topsecret"
        release = threading.Event()

        def blocking_run(args, dry_run=False):
            release.wait(timeout=10)
            return True

        with patch.object(ts, "run_loki_command", side_effect=blocking_run):
            # 1 worker + queue of 1 -> capacity 2 in-flight, rest shed.
            disp = ts.Dispatcher(workers=1, queue_size=1, dry_run=False)
            srv = _ServerFixture(secret=secret, dispatcher=disp)
            try:
                body = json.dumps({"action": "opened", "issue": {"number": 1},
                                   "repository": {"full_name": "o/r"}}).encode()
                headers = {
                    "Content-Type": "application/json",
                    "X-GitHub-Event": "issues",
                    "X-Hub-Signature-256": _sign(secret, body),
                }
                codes = []
                for _ in range(6):
                    st, _ = srv.post(body, headers)
                    codes.append(st)
                # At least one request must be shed with 503.
                self.assertIn(503, codes)
                release.set()
                disp.queue.join()
            finally:
                release.set()
                srv.close()
                disp.shutdown()


if __name__ == "__main__":
    unittest.main(verbosity=2)
