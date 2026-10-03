"""tests/dashboard/test_skill_session_ws_running_agents.py
S-222 (BACKLOG 118): the skill-session WebSocket status push must not claim
`running_agents: 0`. That fallback reads session.json, orchestrator.json and
queue files, none of which count agents, so the value is unmeasured and must
be sent as None (clients already render null as unknown).

Drives one iteration of the real _push_loki_state_loop with no
dashboard-state.json and a fresh session.json, and captures the status_update.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


class SkillSessionRunningAgentsTests(unittest.IsolatedAsyncioTestCase):
    async def test_skill_session_push_sends_unmeasured_running_agents(self):
        from dashboard import server as _server

        tmp = tempfile.mkdtemp(prefix="loki-s222-")
        self.addCleanup(shutil.rmtree, tmp, True)
        Path(tmp, "session.json").write_text(json.dumps({
            "status": "running",
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }), encoding="utf-8")
        self.assertFalse(Path(tmp, "dashboard-state.json").exists())

        captured = []

        class _StopLoop(BaseException):
            pass

        class _FakeManager:
            active_connections = [object()]

            async def broadcast(self, message):
                if message.get("type") == "status_update":
                    captured.append(message["data"])
                    raise _StopLoop()

        saved_dir, saved_mgr = _server._get_loki_dir, _server.manager
        saved_env = os.environ.pop("LOKI_BUDGET_LIMIT", None)
        _server._get_loki_dir = lambda: Path(tmp)
        _server.manager = _FakeManager()
        try:
            with self.assertRaises(_StopLoop):
                await _server._push_loki_state_loop()
        finally:
            _server._get_loki_dir, _server.manager = saved_dir, saved_mgr
            if saved_env is not None:
                os.environ["LOKI_BUDGET_LIMIT"] = saved_env

        self.assertEqual(len(captured), 1)
        data = captured[0]
        # Prove this is the skill-session payload, not the dashboard-state one.
        self.assertEqual(data["mode"], "autonomous")
        self.assertEqual(data["status"], "running")
        self.assertIn("running_agents", data)
        self.assertIsNone(data["running_agents"])


if __name__ == "__main__":
    unittest.main()
