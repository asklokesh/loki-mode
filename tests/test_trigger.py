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

    def _make_issues_payload(self, action, number=42, repo="owner/repo"):
        return {
            "action": action,
            "issue": {"number": number, "title": "Test issue"},
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
