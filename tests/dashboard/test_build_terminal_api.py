"""API contract tests for durable build status and targeted stop."""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from dashboard import build_supervisor as execution
from dashboard import server
from fastapi.testclient import TestClient


class BuildTerminalApiTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="loki-terminal-api-test-"))
        self.env_patch = mock.patch.dict(
            os.environ, {"LOKI_DATA_DIR": str(self.root)}, clear=False
        )
        self.env_patch.start()
        with server._control_limiter._lock:
            server._control_limiter._calls.clear()
        self.client = TestClient(server.app, raise_server_exceptions=False)

    def tearDown(self):
        self.client.close()
        self.env_patch.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def _write(self, execution_id: str, **fields):
        state = {
            "schema_version": execution.SCHEMA_VERSION,
            "execution_id": execution_id,
            "state": "accepted",
            "workspace": "/workspaces/build-a",
            **fields,
        }
        with execution.execution_lock(execution_id):
            execution.write_state_unlocked(execution_id, state)

    def test_status_has_stable_complete_shape_while_accepted(self):
        execution_id = str(uuid.uuid4())
        self._write(execution_id)
        response = self.client.get(f"/api/control/builds/{execution_id}")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        for key in (
            "accepted_at",
            "started_at",
            "exited_at",
            "finished_at",
            "supervisor_pid",
            "runner_pid",
            "runner_pgid",
            "runner_sid",
            "returncode",
            "exit_code",
            "signal",
            "termination_reason",
        ):
            self.assertIn(key, body)
            self.assertIsNone(body[key])
        self.assertEqual(body["run_id"], "")
        self.assertEqual(body["final_tree_sha256"], "")
        self.assertEqual(body["descendants"], execution.empty_descendant_outcome())
        expected_proof = execution.empty_proof_binding(execution_id)
        expected_proof.pop("proof_path")
        self.assertEqual(
            body["proof"],
            expected_proof,
        )
        self.assertFalse(body["supervisor_alive"])
        self.assertFalse(body["runner_alive"])
        self.assertTrue(body["terminal"])
        self.assertEqual(body["lifecycle_health"], "supervisor_lost")
        self.assertEqual(body["reconciliation_reason"], "supervisor_lost")

    def test_status_keeps_exact_terminal_fields(self):
        execution_id = str(uuid.uuid4())
        self._write(
            execution_id,
            state="exited",
            exited_at="2026-07-19T12:00:00Z",
            finished_at="2026-07-19T12:00:00Z",
            returncode=7,
            exit_code=7,
            signal=None,
            termination_reason="crashed",
            run_id="run-20260719120000-1-1",
            final_tree_sha256="abc",
            proof={
                "present": True,
                "bound": False,
                "integrity": {
                    "ok": False,
                    "hash_ok": True,
                    "headline_consistent": False,
                    "gpg_ok": "n/a",
                    "generator_trusted": True,
                    "degraded": [],
                    "reason": "headline mismatch",
                },
            },
        )
        response = self.client.get(f"/api/control/builds/{execution_id}")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["exit_code"], 7)
        self.assertEqual(body["finished_at"], body["exited_at"])
        self.assertTrue(body["proof"]["present"])
        self.assertFalse(body["proof"]["bound"])
        self.assertTrue(body["proof"]["integrity"]["hash_ok"])
        self.assertFalse(body["proof"]["integrity"]["headline_consistent"])
        self.assertNotIn("proof_path", body["proof"])
        self.assertIn("tree_sha256", body["proof"])
        self.assertIn("headline", body["proof"])
        self.assertTrue(body["terminal"])
        self.assertEqual(body["lifecycle_health"], "exited")

    def test_status_marks_a_live_runner_without_supervisor_as_orphaned(self):
        execution_id = str(uuid.uuid4())
        self._write(
            execution_id,
            state="running",
            supervisor_pid=11,
            supervisor_birth_token="supervisor-token",
            runner_pid=22,
            runner_birth_token="runner-token",
        )

        def identity(pid, _token):
            return pid == 22

        with mock.patch(
            "dashboard.server._build_execution.process_identity_matches",
            side_effect=identity,
        ):
            response = self.client.get(f"/api/control/builds/{execution_id}")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["terminal"])
        self.assertEqual(body["lifecycle_health"], "runner_orphaned")
        self.assertEqual(body["reconciliation_reason"], "supervisor_lost")

    def test_proof_endpoint_serves_only_hash_verified_server_snapshot(self):
        execution_id = str(uuid.uuid4())
        raw = b'{"run_id":"run-1","tree_sha256":"tree"}\n'
        snapshot = execution.execution_dir(execution_id) / "proof.json"
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        snapshot.write_bytes(raw)
        digest = execution.sha256_bytes(raw)
        self._write(
            execution_id,
            state="exited",
            proof={
                "present": True,
                "document_sha256": digest,
                "proof_path": str(snapshot),
                "snapshotted": True,
                "bound": True,
            },
        )
        response = self.client.get(
            f"/api/control/builds/{execution_id}/proof"
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, raw)
        self.assertEqual(response.headers["etag"], f'"sha256:{digest}"')

        snapshot.write_bytes(b"tampered")
        response = self.client.get(
            f"/api/control/builds/{execution_id}/proof"
        )
        self.assertEqual(response.status_code, 409, response.text)

    def test_stop_refuses_unverifiable_or_recycled_supervisor(self):
        execution_id = str(uuid.uuid4())
        self._write(
            execution_id,
            state="running",
            supervisor_pid=12345,
            supervisor_birth_token="old-process",
        )
        with mock.patch(
            "dashboard.server._build_execution.process_identity_matches",
            return_value=False,
        ):
            response = self.client.post(
                f"/api/control/builds/{execution_id}/stop"
            )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertNotIn("stop_requested_at", execution.read_state(execution_id))

    def test_stop_marks_only_the_requested_execution(self):
        first = str(uuid.uuid4())
        second = str(uuid.uuid4())
        for execution_id in (first, second):
            self._write(
                execution_id,
                state="running",
                supervisor_pid=12345,
                supervisor_birth_token="same-test-token",
            )
        with mock.patch(
            "dashboard.server._build_execution.process_identity_matches",
            return_value=True,
        ):
            response = self.client.post(f"/api/control/builds/{first}/stop")
        self.assertEqual(response.status_code, 202, response.text)
        self.assertIn("stop_requested_at", execution.read_state(first))
        self.assertNotIn("stop_requested_at", execution.read_state(second))

    def test_unknown_execution_is_not_inferred_from_workspace_state(self):
        response = self.client.get(f"/api/control/builds/{uuid.uuid4()}")
        self.assertEqual(response.status_code, 404, response.text)


if __name__ == "__main__":
    unittest.main()
