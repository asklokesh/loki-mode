"""BACKLOG 112: drive the WebSocket status push payload itself.

GET /api/session/status is pinned by the P7 moat's web-app leg. The /ws
status push builds its own payload in _push_state_to_client; this test drives
that coroutine with a fake socket and reads the pushed status block.
Unmeasured cost and an unset iteration cap must be null, never 0.0 or 10.
"""
import asyncio
import json

import pytest

import server


class _OneShotSocket:
    """Records the first push, then raises so the push loop returns."""

    def __init__(self):
        self.sent = []

    async def send_json(self, payload):
        self.sent.append(payload)
        raise RuntimeError("stop after first push")


def _pushed_status(project_dir):
    ws = _OneShotSocket()
    asyncio.run(asyncio.wait_for(server._push_state_to_client(ws), timeout=10))
    assert len(ws.sent) == 1, ws.sent
    msg = ws.sent[0]
    assert msg["type"] == "state_update"
    return msg["data"]["status"]


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.delenv("LOKI_MAX_ITERATIONS", raising=False)
    monkeypatch.setattr(server.session, "project_dir", str(tmp_path))
    monkeypatch.setattr(server.session, "process", None)
    monkeypatch.setattr(server.session, "running", False)
    loki = tmp_path / ".loki"
    loki.mkdir()
    return loki


@pytest.mark.parametrize("state", [
    None,  # no dashboard-state.json at all
    {"phase": "act", "iteration": 1, "tokens": {"cost_usd": 0.0}},  # zero, nothing counted
    {"phase": "act", "iteration": 1, "tokens": {"input": 0, "output": 0, "cost_usd": 0}},
])
def test_unmeasured_push_sends_null_cost_and_cap(project, state):
    if state is not None:
        (project / "dashboard-state.json").write_text(json.dumps(state))
    status = _pushed_status(project)
    assert "cost" in status and status["cost"] is None, status
    assert "max_iterations" in status and status["max_iterations"] is None, status


def test_priced_tokens_push_a_number(project):
    (project / "dashboard-state.json").write_text(json.dumps({
        "phase": "act", "iteration": 3,
        "tokens": {"input": 1000, "output": 500, "cost_usd": 2.5},
    }))
    (project / "autonomy-state.json").write_text(json.dumps({"maxIterations": 8}))
    status = _pushed_status(project)
    assert status["cost"] == 2.5 and not isinstance(status["cost"], bool), status
    assert status["max_iterations"] == 8, status
