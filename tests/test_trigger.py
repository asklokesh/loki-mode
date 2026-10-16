#!/usr/bin/env python3
"""
tests/test_trigger.py - Tests for loki-mode trigger system.

Tests webhook signature validation, event routing, schedule parsing, and dry-run mode.
Uses only the standard library (unittest).

Run with:
    python3 tests/test_trigger.py
"""

import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

# Ensure autonomy/ is on path so we can import the modules
sys.path.insert(0, str(Path(__file__).parent.parent / "autonomy"))

import importlib
ts = importlib.import_module("trigger-server")
sys.modules["trigger_server"] = ts
tsc = importlib.import_module("trigger-schedule")
sys.modules["trigger_schedule"] = tsc


class TestWebhookSignatureValidation(unittest.TestCase):
    """Tests for HMAC-SHA256 webhook signature validation."""

    def test_valid_signature(self):
        secret = "mysecret"
        body = b'{"action": "opened"}'
        sig = "sha256=" + hmac.new(
            secret.encode("utf-8"), body, hashlib.sha256
        ).hexdigest()
        self.assertTrue(ts.validate_signature(secret, body, sig))

    def test_invalid_signature(self):
        secret = "mysecret"
        body = b'{"action": "opened"}'
        self.assertFalse(ts.validate_signature(secret, body, "sha256=badhash"))

    def test_no_secret_rejects_all(self):
        """When no secret is configured, NO webhook is considered valid.

        v7.79.0 security fix: validate_signature now returns False when no secret
        is set (was a return-True accept-all). The server refuses to dispatch
        unauthenticated webhooks; an operator must configure a secret.
        """
        self.assertFalse(ts.validate_signature("", b"body", ""))
        self.assertFalse(ts.validate_signature("", b"body", "sha256=anything"))

    def test_missing_signature_with_secret_rejects(self):
        """When secret is set but no signature provided, reject."""
        self.assertFalse(ts.validate_signature("secret", b"body", ""))
        self.assertFalse(ts.validate_signature("secret", b"body", None))

    def test_wrong_secret(self):
        body = b'{"test": true}'
        sig = "sha256=" + hmac.new(
            b"correct-secret", body, hashlib.sha256
        ).hexdigest()
        self.assertFalse(ts.validate_signature("wrong-secret", body, sig))

    def test_tampered_body(self):
        secret = "mysecret"
        original_body = b'{"action": "opened"}'
        tampered_body = b'{"action": "deleted"}'
        sig = "sha256=" + hmac.new(
            secret.encode("utf-8"), original_body, hashlib.sha256
        ).hexdigest()
        self.assertFalse(ts.validate_signature(secret, tampered_body, sig))


class TestEventRouting(unittest.TestCase):
    """Tests for GitHub webhook event routing."""

    def setUp(self):
        # Patch run_loki_command to avoid actually running loki
        self.mock_run = patch("trigger_server.run_loki_command", return_value=True).start()
        self.mock_notify = patch("trigger_server.send_notification").start()
        # Patch log_event to avoid file I/O
        self.mock_log = patch("trigger_server.log_event").start()

    def tearDown(self):
        patch.stopall()

    def _make_issues_payload(self, action, number=42, repo="owner/repo", assoc="OWNER"):
        return {
            "action": action,
            "issue": {"number": number, "title": "Test issue", "author_association": assoc},
            "repository": {"full_name": repo},
        }

    def _make_comment_payload(self, assoc="MEMBER", action="created", body="focus on auth",
                              repo="owner/repo", number=42, login="alice", user_type="User"):
        return {
            "action": action,
            "issue": {"number": number, "title": "Test issue"},
            "comment": {"body": body, "author_association": assoc,
                        "user": {"login": login, "type": user_type}},
            "repository": {"full_name": repo},
        }

    def _make_pr_payload(self, action, number=17, repo="owner/repo"):
        return {
            "action": action,
            "pull_request": {"number": number, "title": "Test PR"},
            "repository": {"full_name": repo},
        }

    def _make_workflow_payload(self, action, conclusion, name="CI"):
        return {
            "action": action,
            "workflow_run": {"name": name, "conclusion": conclusion},
            "repository": {"full_name": "owner/repo"},
        }

    # Issues event tests

    def test_issues_opened_fires_loki_start(self):
        # v7.79.0: dispatch uses `loki start` (loki run is a deprecated alias).
        payload = self._make_issues_payload("opened", number=99)
        summary, status = ts.handle_issues_event(payload, dry_run=False)
        self.assertEqual(status, "fired")
        self.assertIn("99", summary)
        self.mock_run.assert_called_once()
        call_args = self.mock_run.call_args[0][0]
        self.assertEqual(call_args[0], "start")
        self.assertIn("--pr", call_args)
        self.assertIn("--detach", call_args)

    def test_issues_opened_from_stranger_skipped(self):
        for assoc in ("NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", ""):
            summary, status = ts.handle_issues_event(self._make_issues_payload("opened", assoc=assoc))
            self.assertIn("skipped", status)
        self.mock_run.assert_not_called()

    def test_issues_opened_stranger_allowed_with_optout_env(self):
        with patch.dict(os.environ, {"LOKI_TRIGGER_ALLOW_ANY_ISSUE_AUTHOR": "1"}):
            _, status = ts.handle_issues_event(self._make_issues_payload("opened", assoc="NONE"))
        self.assertEqual(status, "fired")

    # issue_comment steering

    def test_issue_comment_registered(self):
        self.assertIn("issue_comment", ts.EVENT_HANDLERS)

    def test_issue_comment_member_steers_known_run(self):
        with patch("trigger_server.find_live_run", return_value="run-1") as f:
            summary, status = ts.handle_issue_comment_event(self._make_comment_payload("MEMBER"))
        f.assert_called_once_with("owner/repo#42")
        self.assertEqual(status, "fired")
        args = self.mock_run.call_args[0][0]
        self.assertEqual(args[0], "steer")
        self.assertEqual(len(args), 2)
        self.assertIn("focus on auth", args[1])
        self.assertFalse(args[1].startswith("-"))

    def test_issue_comment_authorized_steer_posts_ack_with_rev(self):
        with patch("trigger_server.find_live_run", return_value="run-1"), \
             patch("trigger_server._pending_steer_rev", return_value=3), \
             patch("trigger_server.post_steer_ack") as ack:
            _, status = ts.handle_issue_comment_event(self._make_comment_payload("MEMBER"))
        self.assertEqual(status, "fired")
        ack.assert_called_once_with("owner/repo#42", "owner/repo", 3, dry_run=False)
        text = ts.steer_ack_text(3)
        self.assertIn("rev 3", text)
        self.assertIn("applies at next plan/implement stage", text)

    def test_issue_comment_unauthorized_posts_no_ack(self):
        with patch("trigger_server.find_live_run", return_value="run-1"), \
             patch("trigger_server._pending_steer_rev", return_value=3), \
             patch("trigger_server.post_steer_ack") as ack:
            ts.handle_issue_comment_event(self._make_comment_payload("NONE"))
        ack.assert_not_called()

    def test_issue_comment_failed_steer_posts_no_ack(self):
        self.mock_run.return_value = False
        with patch("trigger_server.find_live_run", return_value="run-1"), \
             patch("trigger_server._pending_steer_rev", return_value=3), \
             patch("trigger_server.post_steer_ack") as ack:
            _, status = ts.handle_issue_comment_event(self._make_comment_payload("MEMBER"))
        self.assertEqual(status, "error")
        ack.assert_not_called()

    def test_issue_comment_prompt_injection_off_posts_no_ack(self):
        with patch.dict(os.environ, {"LOKI_PROMPT_INJECTION": "0"}), \
             patch("trigger_server.find_live_run", return_value="run-1"), \
             patch("trigger_server._pending_steer_rev", return_value=3), \
             patch("trigger_server.post_steer_ack") as ack:
            ts.handle_issue_comment_event(self._make_comment_payload("MEMBER"))
        ack.assert_not_called()

    def test_loki_authored_comments_never_steer(self):
        bodies = [ts.STEER_ACK_MARKER + "\n" + ts.steer_ack_text(3),
                  "<!-- loki-status -->\nrun state"]
        for b in bodies:
            with patch("trigger_server.find_live_run", return_value="run-1"):
                _, status = ts.handle_issue_comment_event(
                    self._make_comment_payload("OWNER", body=b))
            self.assertIn("skipped", status)
        self.mock_run.assert_not_called()

    def test_post_steer_ack_body_carries_marker(self):
        seen = {}
        def fake(argv, **kw):
            seen["body"] = Path(argv[-1]).read_text()
            return MagicMock(returncode=0, stderr="")
        with patch("trigger_server.subprocess.run", side_effect=fake):
            ts.post_steer_ack("owner/repo#42", "owner/repo", 2)
        self.assertIn(ts.STEER_ACK_MARKER, seen["body"])

    def test_post_steer_ack_invokes_issue_comment_with_pinned_origin(self):
        with patch("trigger_server.subprocess.run") as run:
            run.return_value = MagicMock(returncode=0, stderr="")
            self.assertTrue(ts.post_steer_ack("owner/repo#42", "owner/repo", 2))
        argv = run.call_args[0][0]
        self.assertEqual(argv[2:4], ["issue-comment", "owner/repo#42"])
        env = run.call_args[1]["env"]
        self.assertEqual(env["_LOKI_ORIGIN_PINNED"], "1")
        self.assertEqual(env["_LOKI_PINNED_ORIGIN"], "https://github.com/owner/repo.git")

    def test_pending_steer_rev_reads_last_header(self):
        d = tempfile.mkdtemp()
        cwd = os.getcwd()
        try:
            os.chdir(d)
            self.assertIsNone(ts._pending_steer_rev())
            Path(".loki").mkdir()
            Path(".loki/HUMAN_INPUT.md").write_text(
                "## Operator directive rev 4 (t) actor=a source=cli\nx\n\n## Operator directive rev 5 (t) actor=a source=cli\ny\n")
            self.assertEqual(ts._pending_steer_rev(), 5)
        finally:
            os.chdir(cwd)

    def test_issue_comment_unauthorized_skipped_no_write(self):
        for assoc in ("NONE", "CONTRIBUTOR", "FIRST_TIMER", None):
            with patch("trigger_server.find_live_run", return_value="run-1"):
                _, status = ts.handle_issue_comment_event(self._make_comment_payload(assoc))
            self.assertIn("skipped", status)
        self.mock_run.assert_not_called()

    def test_issue_comment_bot_edited_deleted_skipped(self):
        cases = [self._make_comment_payload(user_type="Bot"),
                 self._make_comment_payload(login="loki[bot]"),
                 self._make_comment_payload(action="edited"),
                 self._make_comment_payload(action="deleted")]
        for payload in cases:
            with patch("trigger_server.find_live_run", return_value="run-1"):
                _, status = ts.handle_issue_comment_event(payload)
            self.assertIn("skipped", status)
        self.mock_run.assert_not_called()

    def test_issue_comment_no_run_skipped(self):
        with patch("trigger_server.find_live_run", return_value=None):
            _, status = ts.handle_issue_comment_event(self._make_comment_payload("OWNER"))
        self.assertIn("skipped", status)
        self.mock_run.assert_not_called()

    def test_issue_comment_forged_repo_rejected(self):
        with patch("trigger_server.find_live_run", return_value="run-1"):
            _, status = ts.handle_issue_comment_event(self._make_comment_payload("OWNER", repo="--evil"))
        self.assertIn("rejected", status)
        self.mock_run.assert_not_called()

    def test_issue_comment_body_bounded_to_one_line(self):
        body = "line one\nline two\n" + "x" * 5000
        with patch("trigger_server.find_live_run", return_value="run-1"):
            ts.handle_issue_comment_event(self._make_comment_payload("OWNER", body=body))
        note = self.mock_run.call_args[0][0][1]
        self.assertNotIn("\n", note)
        self.assertLessEqual(len(note), 1100)

    def test_find_live_run_matches_issue_ref_with_pid(self):
        import tempfile
        d = tempfile.mkdtemp()
        cwd = os.getcwd()
        try:
            os.chdir(d)
            for rid, ref, pid in (("r-old", "owner/repo#42", False), ("r-live", "owner/repo#42", True), ("r-other", "owner/repo#7", True)):
                rd = Path(".loki/runs") / rid
                rd.mkdir(parents=True)
                (rd / "events.jsonl").write_text(json.dumps({"type": "run.started", "data": {"issue_ref": ref}}) + "\n")
                if pid:
                    (rd / "run.pid").write_text(json.dumps({"pid": os.getpid(), "start": ts._process_start_time(os.getpid()), "run_id": rid}))
            self.assertEqual(ts.find_live_run("owner/repo#42"), "r-live")
            self.assertIsNone(ts.find_live_run("owner/repo#99"))
        finally:
            os.chdir(cwd)

    def test_find_live_run_rejects_recycled_pid(self):
        import tempfile
        d = tempfile.mkdtemp()
        cwd = os.getcwd()
        try:
            os.chdir(d)
            good = ts._process_start_time(os.getpid())
            for rid, rec in (
                ("r-stale", {"pid": os.getpid(), "start": "Thu Jan 1 00:00:00 1970", "run_id": "r-stale"}),
                ("r-nostart", {"pid": os.getpid()}),
                ("r-wrongid", {"pid": os.getpid(), "start": good, "run_id": "other"}),
            ):
                rd = Path(".loki/runs") / rid
                rd.mkdir(parents=True)
                (rd / "events.jsonl").write_text(json.dumps({"type": "run.started", "data": {"issue_ref": "o/r#7"}}) + "\n")
                (rd / "run.pid").write_text(json.dumps(rec))
            self.assertIsNone(ts.find_live_run("o/r#7"))
        finally:
            os.chdir(cwd)

    def test_issues_closed_skipped(self):
        payload = self._make_issues_payload("closed")
        summary, status = ts.handle_issues_event(payload, dry_run=False)
        self.assertIn("skipped", status)
        self.mock_run.assert_not_called()

    def test_issues_opened_dry_run(self):
        payload = self._make_issues_payload("opened", number=5)
        summary, status = ts.handle_issues_event(payload, dry_run=True)
        # dry_run=True passes to run_loki_command; mock returns True either way
        self.assertEqual(status, "fired")
        self.mock_run.assert_called_once()
        call_kwargs = self.mock_run.call_args[1]
        self.assertTrue(call_kwargs.get("dry_run"))

    def test_issues_opened_includes_repo_in_args(self):
        payload = self._make_issues_payload("opened", number=42, repo="myorg/myrepo")
        ts.handle_issues_event(payload, dry_run=False)
        call_args = self.mock_run.call_args[0][0]
        # Should be "myorg/myrepo#42" format
        self.assertTrue(any("myorg/myrepo" in str(a) for a in call_args))

    # Pull request event tests

    def test_pr_synchronize_fires_loki_start(self):
        # v7.79.0: dispatch uses `loki start` (loki run is a deprecated alias).
        payload = self._make_pr_payload("synchronize", number=17)
        summary, status = ts.handle_pull_request_event(payload, dry_run=False)
        self.assertEqual(status, "fired")
        self.assertIn("17", summary)
        call_args = self.mock_run.call_args[0][0]
        self.assertEqual(call_args[0], "start")
        self.assertIn("--detach", call_args)

    def test_pr_opened_skipped(self):
        payload = self._make_pr_payload("opened")
        summary, status = ts.handle_pull_request_event(payload, dry_run=False)
        self.assertIn("skipped", status)
        self.mock_run.assert_not_called()

    def test_pr_synchronize_no_pr_skipped(self):
        payload = {"action": "synchronize", "pull_request": {}, "repository": {}}
        summary, status = ts.handle_pull_request_event(payload, dry_run=False)
        self.assertIn("skipped", status)

    # Workflow run event tests

    def test_workflow_failure_fires_loki_run(self):
        payload = self._make_workflow_payload("completed", "failure")
        summary, status = ts.handle_workflow_run_event(payload, dry_run=False)
        self.assertEqual(status, "fired")
        self.mock_run.assert_called_once()

    def test_workflow_success_skipped(self):
        payload = self._make_workflow_payload("completed", "success")
        summary, status = ts.handle_workflow_run_event(payload, dry_run=False)
        self.assertIn("skipped", status)
        self.mock_run.assert_not_called()

    def test_workflow_not_completed_skipped(self):
        payload = self._make_workflow_payload("in_progress", "")
        summary, status = ts.handle_workflow_run_event(payload, dry_run=False)
        self.assertIn("skipped", status)
        self.mock_run.assert_not_called()


class TestDryRunMode(unittest.TestCase):
    """Tests for dry-run mode (preview without execution)."""

    def setUp(self):
        self.real_run = patch("trigger_server.run_loki_command", wraps=ts.run_loki_command).start()
        self.mock_popen = patch("subprocess.Popen").start()
        self.mock_notify = patch("trigger_server.send_notification").start()
        self.mock_log = patch("trigger_server.log_event").start()

    def tearDown(self):
        patch.stopall()

    def test_dry_run_does_not_call_popen(self):
        """Dry-run should log but never spawn a subprocess."""
        payload = {
            "action": "opened",
            "issue": {"number": 1},
            "repository": {"full_name": "test/repo"},
        }
        ts.handle_issues_event(payload, dry_run=True)
        self.mock_popen.assert_not_called()

    def test_dry_run_schedule(self):
        """Schedule dry-run should not call popen."""
        schedule = {
            "name": "test",
            "cron_expr": "* * * * *",
            "action": "run",
            "args": ["42"],
            "enabled": True,
            "last_run": None,
        }
        with patch("subprocess.Popen") as mock_popen:
            tsc.run_schedule(schedule, dry_run=True)
            mock_popen.assert_not_called()


class TestScheduleParsing(unittest.TestCase):
    """Tests for cron expression parsing and schedule matching."""

    def test_wildcard_matches_any(self):
        dt = datetime(2025, 6, 15, 14, 30)  # Sunday 14:30
        self.assertTrue(tsc.cron_matches("* * * * *", dt))

    def test_exact_minute_match(self):
        dt = datetime(2025, 6, 15, 14, 30)
        self.assertTrue(tsc.cron_matches("30 14 * * *", dt))

    def test_exact_minute_no_match(self):
        dt = datetime(2025, 6, 15, 14, 31)
        self.assertFalse(tsc.cron_matches("30 14 * * *", dt))

    def test_range_field(self):
        dt = datetime(2025, 6, 15, 14, 30)
        self.assertTrue(tsc.cron_matches("25-35 14 * * *", dt))
        self.assertFalse(tsc.cron_matches("0-20 14 * * *", dt))

    def test_step_field(self):
        # Every 15 minutes
        dt_match = datetime(2025, 6, 15, 14, 30)
        dt_no_match = datetime(2025, 6, 15, 14, 31)
        self.assertTrue(tsc.cron_matches("*/15 * * * *", dt_match))
        self.assertFalse(tsc.cron_matches("*/15 * * * *", dt_no_match))

    def test_list_field(self):
        dt = datetime(2025, 6, 15, 14, 30)
        self.assertTrue(tsc.cron_matches("0,15,30,45 14 * * *", dt))
        self.assertFalse(tsc.cron_matches("0,15,45 14 * * *", dt))

    def test_day_of_week(self):
        # Sunday = 0 in cron, 6 in Python weekday
        sunday = datetime(2025, 6, 15)  # This is a Sunday (weekday=6)
        monday = datetime(2025, 6, 16)  # Monday (weekday=0)
        self.assertTrue(tsc.cron_matches("* * * * 0", sunday))
        self.assertFalse(tsc.cron_matches("* * * * 0", monday))

    def test_weekday_range(self):
        # Mon-Fri = 1-5 in cron
        wednesday = datetime(2025, 6, 18)  # weekday=2
        saturday = datetime(2025, 6, 21)   # weekday=5
        self.assertTrue(tsc.cron_matches("* * * * 1-5", wednesday))
        self.assertFalse(tsc.cron_matches("* * * * 1-5", saturday))

    def test_invalid_cron_raises(self):
        with self.assertRaises(ValueError):
            tsc.cron_matches("* * * *", datetime(2025, 1, 1))  # only 4 fields

    def test_should_run_enabled(self):
        schedule = {
            "name": "test",
            "cron_expr": "* * * * *",
            "action": "status",
            "enabled": True,
            "last_run": None,
        }
        now = datetime(2025, 6, 15, 10, 0)
        self.assertTrue(tsc.should_run(schedule, now))

    def test_should_run_disabled(self):
        schedule = {
            "name": "test",
            "cron_expr": "* * * * *",
            "action": "status",
            "enabled": False,
            "last_run": None,
        }
        now = datetime(2025, 6, 15, 10, 0)
        self.assertFalse(tsc.should_run(schedule, now))

    def test_should_not_run_same_minute(self):
        """Should not re-fire in the same minute."""
        schedule = {
            "name": "test",
            "cron_expr": "* * * * *",
            "action": "status",
            "enabled": True,
            "last_run": "2025-06-15T10:00:00Z",
        }
        now = datetime(2025, 6, 15, 10, 0)
        self.assertFalse(tsc.should_run(schedule, now))

    def test_should_run_next_minute(self):
        """Should fire again the next minute."""
        schedule = {
            "name": "test",
            "cron_expr": "* * * * *",
            "action": "status",
            "enabled": True,
            "last_run": "2025-06-15T09:59:00Z",
        }
        now = datetime(2025, 6, 15, 10, 0)
        self.assertTrue(tsc.should_run(schedule, now))


class TestBuildLokiArgs(unittest.TestCase):
    """Tests for building loki CLI arguments from schedule entries."""

    def test_status_action(self):
        schedule = {"action": "status", "args": []}
        self.assertEqual(tsc.build_loki_args(schedule), ["status"])

    def test_quality_review_action(self):
        schedule = {"action": "quality-review", "args": []}
        self.assertEqual(tsc.build_loki_args(schedule), ["review"])

    def test_quality_review_with_args(self):
        schedule = {"action": "quality-review", "args": ["--json"]}
        self.assertEqual(tsc.build_loki_args(schedule), ["review", "--json"])

    def test_run_with_issue_in_args(self):
        schedule = {"action": "run", "args": ["123"]}
        args = tsc.build_loki_args(schedule)
        self.assertEqual(args[0], "run")
        self.assertIn("123", args)

    def test_run_with_issue_in_action(self):
        schedule = {"action": "run 456", "args": []}
        args = tsc.build_loki_args(schedule)
        self.assertEqual(args[0], "run")
        self.assertIn("456", args)


class TestScheduleFileIO(unittest.TestCase):
    """Tests for schedule file persistence."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_cwd = os.getcwd()
        os.chdir(self.tmpdir)

    def tearDown(self):
        os.chdir(self.orig_cwd)

    def test_load_empty_schedules(self):
        """Returns empty list when no file exists."""
        schedules = tsc.load_schedules()
        self.assertEqual(schedules, [])

    def test_save_and_load_schedules(self):
        schedules = [
            {
                "name": "daily",
                "cron_expr": "0 9 * * 1-5",
                "action": "status",
                "args": [],
                "enabled": True,
                "last_run": None,
            }
        ]
        tsc.save_schedules(schedules)
        loaded = tsc.load_schedules()
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0]["name"], "daily")

    def test_add_and_remove_schedule(self):
        tsc.add_schedule("my-sched", "0 8 * * *", "status", [])
        loaded = tsc.load_schedules()
        self.assertEqual(len(loaded), 1)
        tsc.remove_schedule("my-sched")
        loaded = tsc.load_schedules()
        self.assertEqual(len(loaded), 0)

    def test_add_updates_existing(self):
        tsc.add_schedule("my-sched", "0 8 * * *", "status", [])
        tsc.add_schedule("my-sched", "0 9 * * *", "quality-review", [])
        loaded = tsc.load_schedules()
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0]["cron_expr"], "0 9 * * *")
        self.assertEqual(loaded[0]["action"], "quality-review")


if __name__ == "__main__":
    unittest.main(verbosity=2)
