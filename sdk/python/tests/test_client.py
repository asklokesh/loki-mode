"""Tests for the Autonomi Python SDK.

All HTTP calls are mocked via unittest.mock -- no real server needed.
"""

from __future__ import annotations

import io
import json
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

import sys
import os

# Ensure the package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from autonomi.client import (
    AutonomiClient,
    AutonomiError,
    AuthenticationError,
    ForbiddenError,
    NotFoundError,
)
from autonomi.auth import TokenAuth
from autonomi.types import (
    ApiKey,
    AuditEntry,
    Project,
    Run,
    RunEvent,
    Task,
    Tenant,
)
from autonomi.sessions import SessionManager
from autonomi.tasks import TaskManager
from autonomi.events import EventStream


def _mock_response(data, status=200):
    """Create a mock urllib response."""
    body = json.dumps(data).encode("utf-8") if data is not None else b""
    resp = MagicMock()
    resp.status = status
    resp.read.return_value = body
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _mock_http_error(code, reason="Error", body=None):
    """Create a mock HTTPError."""
    if body is None:
        body = json.dumps({"detail": reason})
    fp = io.BytesIO(body.encode("utf-8") if isinstance(body, str) else body)
    return HTTPError(
        url="http://localhost:57374/api/test",
        code=code,
        msg=reason,
        hdrs={},
        fp=fp,
    )


class TestTokenAuth(unittest.TestCase):
    def test_headers(self):
        auth = TokenAuth("loki_abc123")
        self.assertEqual(
            auth.headers(), {"Authorization": "Bearer loki_abc123"}
        )

    def test_empty_token_raises(self):
        with self.assertRaises(ValueError):
            TokenAuth("")

    def test_repr_masks_token(self):
        auth = TokenAuth("loki_secret_value")
        self.assertEqual(repr(auth), "TokenAuth(token='loki_****')")


class TestClientInit(unittest.TestCase):
    def test_default_base_url(self):
        client = AutonomiClient()
        self.assertEqual(client.base_url, "http://localhost:57374")

    def test_custom_base_url_strips_trailing_slash(self):
        client = AutonomiClient(base_url="http://example.com/")
        self.assertEqual(client.base_url, "http://example.com")

    def test_token_creates_auth(self):
        client = AutonomiClient(token="loki_test")
        self.assertIsNotNone(client._auth)
        self.assertEqual(client._auth.headers(), {"Authorization": "Bearer loki_test"})

    def test_no_token_no_auth(self):
        client = AutonomiClient()
        self.assertIsNone(client._auth)

    def test_timeout(self):
        client = AutonomiClient(timeout=60)
        self.assertEqual(client.timeout, 60)


class TestRequestMethod(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(
            base_url="http://localhost:57374", token="loki_test"
        )

    @patch("autonomi.client.urllib.request.urlopen")
    def test_get_request(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"status": "ok"})
        result = self.client._get("/api/status")
        self.assertEqual(result, {"status": "ok"})
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertEqual(req.get_method(), "GET")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_post_request_with_data(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"id": "proj-1"})
        result = self.client._post("/api/projects", data={"name": "test"})
        self.assertEqual(result, {"id": "proj-1"})
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(json.loads(req.data), {"name": "test"})

    @patch("autonomi.client.urllib.request.urlopen")
    def test_put_request(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"updated": True})
        result = self.client._put("/api/tasks/1", data={"status": "done"})
        self.assertEqual(result, {"updated": True})
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertEqual(req.get_method(), "PUT")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_delete_request(self, mock_urlopen):
        resp = _mock_response(None, status=204)
        resp.read.return_value = b""
        mock_urlopen.return_value = resp
        self.client._delete("/api/projects/1")
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertEqual(req.get_method(), "DELETE")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_auth_headers_included(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"ok": True})
        self.client._get("/api/status")
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertEqual(req.get_header("Authorization"), "Bearer loki_test")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_query_params(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response([])
        self.client._get("/api/runs", params={"status": "running"})
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertIn("status=running", req.full_url)


class TestErrorHandling(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(token="loki_test")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_401_raises_authentication_error(self, mock_urlopen):
        mock_urlopen.side_effect = _mock_http_error(401, "Unauthorized")
        with self.assertRaises(AuthenticationError) as ctx:
            self.client.get_status()
        self.assertEqual(ctx.exception.status_code, 401)

    @patch("autonomi.client.urllib.request.urlopen")
    def test_403_raises_forbidden_error(self, mock_urlopen):
        mock_urlopen.side_effect = _mock_http_error(403, "Forbidden")
        with self.assertRaises(ForbiddenError) as ctx:
            self.client.get_status()
        self.assertEqual(ctx.exception.status_code, 403)

    @patch("autonomi.client.urllib.request.urlopen")
    def test_404_raises_not_found_error(self, mock_urlopen):
        mock_urlopen.side_effect = _mock_http_error(404, "Not Found")
        with self.assertRaises(NotFoundError) as ctx:
            self.client.get_project("nonexistent")
        self.assertEqual(ctx.exception.status_code, 404)

    @patch("autonomi.client.urllib.request.urlopen")
    def test_500_raises_autonomi_error(self, mock_urlopen):
        mock_urlopen.side_effect = _mock_http_error(500, "Internal Server Error")
        with self.assertRaises(AutonomiError) as ctx:
            self.client.get_status()
        self.assertEqual(ctx.exception.status_code, 500)

    @patch("autonomi.client.urllib.request.urlopen")
    def test_error_includes_response_body(self, mock_urlopen):
        body = json.dumps({"detail": "Rate limit exceeded"})
        mock_urlopen.side_effect = _mock_http_error(429, "Too Many Requests", body)
        with self.assertRaises(AutonomiError) as ctx:
            self.client.get_status()
        self.assertIn("Rate limit exceeded", str(ctx.exception))
        self.assertIn("Rate limit exceeded", ctx.exception.response_body)


class TestListProjects(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(token="loki_test")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_list_projects_returns_project_objects(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {
                "projects": [
                    {"id": "p1", "name": "Alpha", "status": "active"},
                    {"id": "p2", "name": "Beta", "status": "archived"},
                ]
            }
        )
        projects = self.client.list_projects()
        self.assertEqual(len(projects), 2)
        self.assertIsInstance(projects[0], Project)
        self.assertEqual(projects[0].id, "p1")
        self.assertEqual(projects[0].name, "Alpha")
        self.assertEqual(projects[1].status, "archived")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_list_projects_handles_array_response(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            [{"id": "p1", "name": "Solo"}]
        )
        projects = self.client.list_projects()
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0].name, "Solo")


class TestCreateProject(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(token="loki_test")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_create_project(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {"id": "p-new", "name": "New Project", "description": "Test desc"}
        )
        project = self.client.create_project("New Project", description="Test desc")
        self.assertIsInstance(project, Project)
        self.assertEqual(project.id, "p-new")
        self.assertEqual(project.description, "Test desc")

        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        body = json.loads(req.data)
        self.assertEqual(body["name"], "New Project")
        self.assertEqual(body["description"], "Test desc")


class TestListRuns(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(token="loki_test")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_list_runs_returns_run_objects(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {
                "runs": [
                    {
                        "id": "r1",
                        "project_id": "p1",
                        "status": "running",
                        "trigger": "manual",
                    },
                    {
                        "id": "r2",
                        "project_id": "p1",
                        "status": "completed",
                        "trigger": "schedule",
                    },
                ]
            }
        )
        runs = self.client.list_runs(project_id="p1")
        self.assertEqual(len(runs), 2)
        self.assertIsInstance(runs[0], Run)
        self.assertEqual(runs[0].status, "running")
        self.assertEqual(runs[1].trigger, "schedule")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_list_runs_with_status_filter(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"runs": []})
        self.client.list_runs(status="failed")
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertIn("status=failed", req.full_url)


class TestCancelRun(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(token="loki_test")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_cancel_run(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {"id": "r1", "project_id": "p1", "status": "cancelled"}
        )
        run = self.client.cancel_run("r1")
        self.assertIsInstance(run, Run)
        self.assertEqual(run.status, "cancelled")
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertTrue(req.full_url.endswith("/api/v2/runs/r1/cancel"))
        self.assertEqual(req.get_method(), "POST")


class TestQueryAudit(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(token="loki_test")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_query_audit_returns_entries(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {
                "entries": [
                    {
                        "timestamp": "2026-02-21T10:00:00Z",
                        "action": "project.create",
                        "resource_type": "project",
                        "resource_id": "p1",
                        "user_id": "u1",
                        "success": True,
                    }
                ]
            }
        )
        entries = self.client.query_audit(action="project.create", limit=50)
        self.assertEqual(len(entries), 1)
        self.assertIsInstance(entries[0], AuditEntry)
        self.assertEqual(entries[0].action, "project.create")
        self.assertTrue(entries[0].success)

    @patch("autonomi.client.urllib.request.urlopen")
    def test_query_audit_params(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response({"entries": []})
        self.client.query_audit(
            start_date="2026-01-01", end_date="2026-02-01", limit=10
        )
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertIn("start_date=2026-01-01", req.full_url)
        self.assertIn("end_date=2026-02-01", req.full_url)
        self.assertIn("limit=10", req.full_url)


class TestDataclasses(unittest.TestCase):
    def test_project_from_dict(self):
        p = Project.from_dict(
            {"id": "p1", "name": "Test", "status": "active", "tenant_id": "t1"}
        )
        self.assertEqual(p.id, "p1")
        self.assertEqual(p.tenant_id, "t1")

    def test_task_from_dict(self):
        t = Task.from_dict(
            {
                "id": "t1",
                "project_id": "p1",
                "title": "Do thing",
                "status": "in_progress",
                "priority": "high",
            }
        )
        self.assertEqual(t.title, "Do thing")
        self.assertEqual(t.priority, "high")

    def test_run_from_dict_with_config(self):
        r = Run.from_dict(
            {
                "id": "r1",
                "project_id": "p1",
                "config": {"parallelism": 4},
            }
        )
        self.assertEqual(r.config, {"parallelism": 4})

    def test_run_event_from_dict(self):
        e = RunEvent.from_dict(
            {
                "id": "e1",
                "run_id": "r1",
                "event_type": "phase_start",
                "phase": "build",
                "timestamp": "2026-02-21T10:00:00Z",
            }
        )
        self.assertEqual(e.event_type, "phase_start")
        self.assertEqual(e.phase, "build")

    def test_tenant_from_dict(self):
        t = Tenant.from_dict({"id": "t1", "name": "Acme", "slug": "acme"})
        self.assertEqual(t.slug, "acme")

    def test_api_key_from_dict(self):
        k = ApiKey.from_dict(
            {"id": "k1", "name": "ci-key", "role": "admin", "scopes": ["read", "write"]}
        )
        self.assertEqual(k.role, "admin")
        self.assertEqual(k.scopes, ["read", "write"])

    def test_audit_entry_from_dict(self):
        a = AuditEntry.from_dict(
            {
                "timestamp": "2026-02-21T10:00:00Z",
                "action": "key.rotate",
                "resource_type": "api_key",
                "resource_id": "k1",
                "success": False,
            }
        )
        self.assertFalse(a.success)


class TestTaskManager(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(token="loki_test")
        self.tasks = TaskManager(self.client)

    @patch("autonomi.client.urllib.request.urlopen")
    def test_create_task(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {"id": "t1", "project_id": "p1", "title": "Build UI", "priority": "high"}
        )
        task = self.tasks.create_task("p1", "Build UI", priority="high")
        self.assertIsInstance(task, Task)
        self.assertEqual(task.title, "Build UI")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_update_task(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {"id": "t1", "project_id": "p1", "title": "Build UI", "status": "done"}
        )
        task = self.tasks.update_task("t1", status="done")
        self.assertEqual(task.status, "done")


class TestSessionManager(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(token="loki_test")
        self.sessions = SessionManager(self.client)

    @patch("autonomi.client.urllib.request.urlopen")
    def test_list_sessions(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {"sessions": [{"id": "s1", "status": "active"}]}
        )
        sessions = self.sessions.list_sessions("p1")
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["id"], "s1")


class TestEventStream(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(token="loki_test")
        self.events = EventStream(self.client)

    @patch("autonomi.client.urllib.request.urlopen")
    def test_poll_events(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {
                "events": [
                    {
                        "id": "e1",
                        "run_id": "r1",
                        "event_type": "task_complete",
                        "timestamp": "2026-02-21T10:05:00Z",
                    }
                ]
            }
        )
        events = self.events.poll_events("r1", since="2026-02-21T10:00:00Z")
        self.assertEqual(len(events), 1)
        self.assertIsInstance(events[0], RunEvent)
        self.assertEqual(events[0].event_type, "task_complete")


class TestApiKeys(unittest.TestCase):
    def setUp(self):
        self.client = AutonomiClient(token="loki_test")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_create_api_key(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {"id": "k1", "name": "ci", "token": "loki_secret", "role": "admin"}
        )
        result = self.client.create_api_key("ci", role="admin")
        self.assertEqual(result["token"], "loki_secret")

    @patch("autonomi.client.urllib.request.urlopen")
    def test_rotate_api_key(self, mock_urlopen):
        mock_urlopen.return_value = _mock_response(
            {"id": "k1", "new_token": "loki_rotated", "grace_until": "2026-02-22"}
        )
        result = self.client.rotate_api_key("k1", grace_period_hours=48)
        self.assertEqual(result["new_token"], "loki_rotated")
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        body = json.loads(req.data)
        self.assertEqual(body["grace_period_hours"], 48)


if __name__ == "__main__":
    unittest.main()
