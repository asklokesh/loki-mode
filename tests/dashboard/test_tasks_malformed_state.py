"""
tests/dashboard/test_tasks_malformed_state.py

v7.104.4 hardening: GET /api/tasks must never 500 on a malformed or partially
written dashboard-state.json. The state file is user/agent-written; if "tasks"
is not a dict, or a group is not a list, or an item is not a dict, the old code
raised an AttributeError (task_groups.get / task.get) that the surrounding
(JSONDecodeError, KeyError) handler did not catch, blanking the whole board.

These tests call the real server.list_tasks with a crafted state file and assert
it returns cleanly (a list), skipping only the malformed parts.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from dashboard import server


def _write_raw_state(tmp_path: Path, tasks_value) -> Path:
    loki = tmp_path / ".loki"
    loki.mkdir(parents=True, exist_ok=True)
    (loki / "dashboard-state.json").write_text(json.dumps({"tasks": tasks_value}))
    return loki


@pytest.mark.asyncio
async def test_tasks_group_is_dict_not_list_does_not_crash(tmp_path):
    # completed is a dict (malformed) instead of a list.
    loki = _write_raw_state(tmp_path, {
        "pending": [{"id": "prd-001", "title": "story", "type": "task"}],
        "completed": {"oops": "this is a dict, not a list"},
    })
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)
    assert isinstance(result, list)
    # the valid pending task still comes through; the malformed group is skipped
    assert any(t["id"] == "prd-001" for t in result)


@pytest.mark.asyncio
async def test_tasks_is_not_a_dict_does_not_crash(tmp_path):
    # top-level "tasks" is a list (malformed) instead of a dict.
    loki = _write_raw_state(tmp_path, ["not", "a", "dict"])
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)
    assert isinstance(result, list)  # no crash, empty-ish is fine


@pytest.mark.asyncio
async def test_task_with_non_dict_payload_does_not_crash(tmp_path):
    # A well-formed task item whose "payload" is a string (not a dict) must not
    # crash: payload.get(...) in the fallback title/description would raise
    # AttributeError. Found by the v7.104.4 dashboard review.
    loki = _write_raw_state(tmp_path, {
        "pending": [{"id": "prd-003", "payload": "oops-not-a-dict"}],
    })
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)
    assert isinstance(result, list)
    rec = next(t for t in result if t["id"] == "prd-003")
    # falls back cleanly (no payload.action/description available)
    assert isinstance(rec.get("title"), str)


@pytest.mark.asyncio
async def test_tasks_group_item_is_not_dict_does_not_crash(tmp_path):
    # a group contains a bare string / None instead of a task object.
    loki = _write_raw_state(tmp_path, {
        "pending": ["a bare string", None, {"id": "prd-002", "title": "ok", "type": "task"}],
    })
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)
    assert isinstance(result, list)
    # the one valid item survives; the string/None are skipped
    assert any(t["id"] == "prd-002" for t in result)
    assert all(isinstance(t, dict) for t in result)
