"""
tests/dashboard/test_start_build_workspace.py
Track-1 (S1): the OPTIONAL, additive, path-guarded `workspace` param on
POST /api/control/start, plus the trust run_id surfaced on /api/status.

These tests prove three contract guarantees the SaaS BFF (S2/S3) relies on:
  1. OMITTED workspace == today's exact behavior: run.sh is spawned with
     cwd == the engine's project dir and NO workspace-pinning env. This is the
     no-regression proof.
  2. PRESENT + path-guarded workspace: run.sh is spawned with cwd == the
     workspace AND env LOKI_TARGET_DIR / LOKI_DIR pin it there (cwd alone is
     not enough because `loki` exports LOKI_DIR into the dashboard process).
  3. TRAVERSAL / unsafe / out-of-root workspace -> 400, never a spawn.

subprocess.Popen is mocked so NO real run.sh runs (per the host constraint:
fixtures/unit only, never a real build). The mock records the cwd + env it was
called with and returns a fake process that reports a clean, still-running
child so start_build returns 200.

Idiom mirrors test_claude_session_status.py (_ForceLokiDir + TestClient with
raise_server_exceptions=False) and the project's no-real-spawn rule.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class _ForceLokiDir:
    """Pin dashboard.server._get_loki_dir() to a tmp .loki path."""

    def __init__(self, loki_dir: Path):
        self.loki_dir = loki_dir
        self._orig = None

    def __enter__(self):
        from dashboard import server as _server
        self._orig = _server._get_loki_dir
        _server._get_loki_dir = lambda: self.loki_dir
        return self

    def __exit__(self, exc_type, exc, tb):
        from dashboard import server as _server
        if self._orig is not None:
            _server._get_loki_dir = self._orig


class _FakePopen:
    """Stand-in for subprocess.Popen that records the call and never spawns.

    poll() returns None (child still running) so start_build's liveness loop
    sees a healthy process and returns 200. pid is a stable sentinel.
    """

    last_kwargs: dict = {}

    def __init__(self, args, **kwargs):
        type(self).last_kwargs = {"args": args, **kwargs}
        self.pid = 424242

    def poll(self):
        return None


class StartBuildWorkspaceTests(unittest.TestCase):
    def setUp(self):
        # The engine's "own" project dir (the default, no-workspace target).
        self.project = Path(tempfile.mkdtemp(prefix="loki-s1-project-"))
        self.engine_loki = self.project / ".loki"
        self.engine_loki.mkdir(parents=True, exist_ok=True)
        # An operator-allowed workspace root (LOKI_WORKSPACE_ROOTS).
        self.ws_root = Path(tempfile.mkdtemp(prefix="loki-s1-wsroot-"))

    def _client(self):
        from dashboard.server import app
        from fastapi.testclient import TestClient
        return TestClient(app, raise_server_exceptions=False)

    def _post(self, body, env_roots=None):
        """POST /api/control/start with Popen mocked. Returns the response.

        env_roots, when given, is set as LOKI_WORKSPACE_ROOTS for the call.
        """
        env_patch = {}
        if env_roots is not None:
            env_patch["LOKI_WORKSPACE_ROOTS"] = env_roots
        with _ForceLokiDir(self.engine_loki), \
                mock.patch("dashboard.server.subprocess.Popen", _FakePopen), \
                mock.patch.dict(os.environ, env_patch, clear=False):
            return self._client().post("/api/control/start", json=body)

    # --- 1. Regression proof: omitted workspace == today's behavior ----------

    def test_omitted_workspace_uses_project_dir_and_no_pin_env(self):
        _FakePopen.last_kwargs = {}
        resp = self._post({"prd_text": "build a todo app", "provider": "claude"})
        self.assertEqual(resp.status_code, 200, resp.text)
        kwargs = _FakePopen.last_kwargs
        # cwd is the engine's own project dir (the .loki parent).
        self.assertEqual(Path(kwargs["cwd"]).resolve(), self.project.resolve())
        # env is None -> inherit (byte-identical to before this feature).
        self.assertIsNone(kwargs.get("env"))
        body = resp.json()
        # The response echoes an empty workspace for the default path.
        self.assertEqual(body.get("workspace", ""), "")
        self.assertIn("run_id", body)  # field always present, may be ""

    # --- 2. Present workspace: cwd + pin env route run.sh to the workspace ----

    def test_workspace_routes_cwd_and_pins_env(self):
        _FakePopen.last_kwargs = {}
        ws = self.ws_root / "build-abc123"
        resp = self._post(
            {"prd_text": "build a todo app", "provider": "claude",
             "workspace": str(ws)},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        kwargs = _FakePopen.last_kwargs
        # cwd is the workspace, not the engine project dir.
        self.assertEqual(Path(kwargs["cwd"]).resolve(), ws.resolve())
        # env pins LOKI_TARGET_DIR + LOKI_DIR to the workspace so an inherited
        # LOKI_DIR cannot redirect the build back into the engine repo.
        env = kwargs.get("env")
        self.assertIsNotNone(env, "workspace path must pass an explicit env")
        self.assertEqual(Path(env["LOKI_TARGET_DIR"]).resolve(), ws.resolve())
        self.assertEqual(
            Path(env["LOKI_DIR"]).resolve(), (ws / ".loki").resolve()
        )
        # The workspace dir was created (BFF passes <root>/<buildId>, absent
        # until first build).
        self.assertTrue(ws.is_dir())
        # Response echoes the workspace so the caller can derive the proof path.
        self.assertEqual(Path(resp.json()["workspace"]).resolve(), ws.resolve())

    def test_workspace_run_id_read_from_workspace_loki_when_minted(self):
        # If run.sh has already minted the trust-run-id into the WORKSPACE's
        # .loki (not the engine's), the start response surfaces it.
        _FakePopen.last_kwargs = {}
        ws = self.ws_root / "build-rid"
        (ws / ".loki" / "state").mkdir(parents=True, exist_ok=True)
        (ws / ".loki" / "state" / "trust-run-id").write_text(
            "run-20260621120000-9999-7", encoding="utf-8"
        )
        resp = self._post(
            {"prd_text": "x", "provider": "claude", "workspace": str(ws)},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["run_id"], "run-20260621120000-9999-7")

    # --- 3. Path-guard: traversal / unsafe / out-of-root -> 400, no spawn ----

    def test_traversal_workspace_rejected(self):
        _FakePopen.last_kwargs = {}
        resp = self._post(
            {"prd_text": "x", "provider": "claude",
             "workspace": str(self.ws_root) + "/../escape"},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 400, resp.text)
        # No spawn happened.
        self.assertEqual(_FakePopen.last_kwargs, {})

    def test_workspace_outside_allowed_root_rejected(self):
        _FakePopen.last_kwargs = {}
        outside = Path(tempfile.mkdtemp(prefix="loki-s1-outside-")) / "build"
        resp = self._post(
            {"prd_text": "x", "provider": "claude", "workspace": str(outside)},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 400, resp.text)
        self.assertEqual(_FakePopen.last_kwargs, {})

    def test_relative_workspace_rejected(self):
        _FakePopen.last_kwargs = {}
        resp = self._post(
            {"prd_text": "x", "provider": "claude",
             "workspace": "relative/build"},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 400, resp.text)
        self.assertEqual(_FakePopen.last_kwargs, {})

    def test_workspace_rejected_when_no_roots_configured(self):
        # Fail-closed: an absolute, traversal-free workspace is still rejected
        # when LOKI_WORKSPACE_ROOTS is unset (feature opt-in by config).
        _FakePopen.last_kwargs = {}
        ws = self.ws_root / "build-noroot"
        # env_roots=None -> do not set LOKI_WORKSPACE_ROOTS. Clear any inherited
        # value so the test is deterministic regardless of the caller's env.
        with _ForceLokiDir(self.engine_loki), \
                mock.patch("dashboard.server.subprocess.Popen", _FakePopen), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("LOKI_WORKSPACE_ROOTS", None)
            resp = self._client().post(
                "/api/control/start",
                json={"prd_text": "x", "provider": "claude",
                      "workspace": str(ws)},
            )
        self.assertEqual(resp.status_code, 400, resp.text)
        self.assertEqual(_FakePopen.last_kwargs, {})

    # --- /api/status surfaces current_run_id ---------------------------------

    def test_status_surfaces_current_run_id(self):
        (self.engine_loki / "state").mkdir(parents=True, exist_ok=True)
        (self.engine_loki / "state" / "trust-run-id").write_text(
            "run-20260621130000-1234-5", encoding="utf-8"
        )
        with _ForceLokiDir(self.engine_loki):
            resp = self._client().get("/api/status")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn("current_run_id", body)
        self.assertEqual(body["current_run_id"], "run-20260621130000-1234-5")

    def test_status_current_run_id_empty_when_absent(self):
        with _ForceLokiDir(self.engine_loki):
            resp = self._client().get("/api/status")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json().get("current_run_id", ""), "")


if __name__ == "__main__":
    unittest.main()
