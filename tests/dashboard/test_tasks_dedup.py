"""
tests/dashboard/test_tasks_dedup.py

v7.104.2 task-list accuracy -- GET /api/tasks must dedup by id with a
terminal-wins rule.

The list_tasks() endpoint reads dashboard-state.json task groups first, then
merges queue files. Real anonima data showed the SAME id in more than one column
(iteration-13 in inProgress AND completed AND failed; iteration-1 five times in
completed). The dashboard must render each id exactly once, and a completed
(terminal) iteration must NOT keep showing in in-progress/todo -- so the winner
is the terminal (done) record, not the naive in_progress > done.

We call list_tasks() directly (bypassing FastAPI DI) with _get_loki_dir mocked
to a temp dir holding a crafted dashboard-state.json.
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


def _write_state(tmp_path: Path, tasks: dict) -> Path:
    loki = tmp_path / ".loki"
    loki.mkdir(parents=True, exist_ok=True)
    (loki / "dashboard-state.json").write_text(json.dumps({"tasks": tasks}))
    return loki


def _write_queue(tmp_path: Path, files: dict) -> Path:
    # Write ONLY queue files, NO dashboard-state.json, to exercise the
    # queue-file read path (the source R1 found the fake-green hole in).
    loki = tmp_path / ".loki"
    (loki / "queue").mkdir(parents=True, exist_ok=True)
    for name, items in files.items():
        (loki / "queue" / name).write_text(json.dumps(items))
    return loki


@pytest.mark.asyncio
async def test_terminal_wins_dedup_pulls_completed_out_of_inprogress(tmp_path):
    # iteration-13 appears in inProgress AND completed (the reported "completed
    # still shows in in-progress" bug). Terminal (done) must win over in_progress.
    tasks = {
        "pending": [{"id": "prd-001", "title": "story 1", "type": "task"}],
        "inProgress": [
            {"id": "iteration-13", "title": "borrowed PRD story",
             "type": "iteration", "logs": ["a"]}
        ],
        "review": [],
        "completed": [
            {"id": "iteration-13", "title": "Iteration 13 complete - implement",
             "type": "iteration", "description": "done", "completedAt": "2026-07-01T10:05:00Z"},
        ],
        "failed": [],
    }
    loki = _write_state(tmp_path, tasks)
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)

    ids = [t["id"] for t in result]
    # exactly once, no duplicates
    assert ids.count("iteration-13") == 1, ids
    i13 = next(t for t in result if t["id"] == "iteration-13")
    # terminal-wins: it lands in done, not in_progress
    assert i13["status"] == "done", i13
    # and it kept the honest completed title/description
    assert "complete" in i13["title"], i13


@pytest.mark.asyncio
async def test_failed_wins_over_completed_never_fake_green(tmp_path):
    # Trust-critical: an id present in BOTH completed AND failed (stale/partial
    # state) must resolve to FAILED, never masked behind the completed record.
    # A same-id success hiding a real failure is a fake-green the trust model
    # forbids. Verified by both Reviewer 1 (CONCERN) and Reviewer 3.
    tasks = {
        "pending": [], "inProgress": [], "review": [],
        "completed": [
            {"id": "iteration-9", "title": "Iteration 9", "type": "iteration",
             "status": "completed", "exitCode": 0, "provider": "claude",
             "completedAt": "2026-07-01T10:00:00Z"},
        ],
        "failed": [
            {"id": "iteration-9", "title": "Iteration 9", "type": "iteration",
             "status": "failed", "exitCode": 3, "provider": "claude",
             "completedAt": "2026-07-01T10:01:00Z"},
        ],
    }
    loki = _write_state(tmp_path, tasks)
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)

    recs = [t for t in result if t["id"] == "iteration-9"]
    assert len(recs) == 1, recs
    rec = recs[0]
    # the failed record wins; description must not claim success
    assert rec.get("_terminal_outcome") == "failed", rec
    assert "complete" not in rec["description"].lower(), rec["description"]
    assert "fail" in rec["description"].lower() or "exit 3" in rec["description"], rec["description"]


@pytest.mark.asyncio
async def test_queue_file_failed_wins_over_completed_no_state(tmp_path):
    # R1's blocking finding: when there is NO dashboard-state.json and the same id
    # is in BOTH queue/completed.json AND queue/failed.json, the old skip guard
    # dropped the failed sibling before it could be tagged, so a completed card
    # masked a real failure. The queue read path must now let terminal records
    # through so the failed-outranks-completed dedup resolves it honestly.
    loki = _write_queue(tmp_path, {
        "completed.json": [
            {"id": "iteration-9", "type": "iteration", "title": "Iteration 9",
             "status": "completed", "exitCode": 0, "provider": "claude"},
        ],
        "failed.json": [
            {"id": "iteration-9", "type": "iteration", "title": "Iteration 9",
             "status": "failed", "exitCode": 3, "provider": "claude"},
        ],
    })
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)

    recs = [t for t in result if t["id"] == "iteration-9"]
    assert len(recs) == 1, recs
    rec = recs[0]
    assert rec.get("_terminal_outcome") == "failed", rec
    assert "complete" not in rec["description"].lower(), rec["description"]
    assert "exit 3" in rec["description"] or "fail" in rec["description"].lower(), rec["description"]


@pytest.mark.asyncio
async def test_queue_file_completed_only_still_renders(tmp_path):
    # Guard against over-correction: a completed-only queue id (no failed sibling)
    # must still render honestly as completed.
    loki = _write_queue(tmp_path, {
        "completed.json": [
            {"id": "iteration-2", "type": "iteration", "title": "Iteration 2",
             "status": "completed", "exitCode": 0, "provider": "claude"},
        ],
        "failed.json": [],
    })
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)
    rec = next(t for t in result if t["id"] == "iteration-2")
    assert rec["status"] == "done"
    assert "cleanly" in rec["description"], rec["description"]


@pytest.mark.asyncio
async def test_failed_without_exitcode_is_never_called_completed(tmp_path):
    # R1's exact finding: a failed iteration lacking an integer exitCode used to
    # fall through the synthesis to the generic "completed" verb. It must not.
    tasks = {
        "pending": [], "inProgress": [], "review": [], "completed": [],
        "failed": [
            {"id": "iteration-7", "title": "Iteration 7", "type": "iteration",
             "status": "failed", "provider": "claude",
             "completedAt": "2026-07-01T10:00:00Z"},  # no exitCode
        ],
    }
    loki = _write_state(tmp_path, tasks)
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)
    rec = next(t for t in result if t["id"] == "iteration-7")
    assert "complete" not in rec["description"].lower(), rec["description"]
    assert "fail" in rec["description"].lower(), rec["description"]


@pytest.mark.asyncio
async def test_repeated_completed_id_collapses_to_one(tmp_path):
    # iteration-1 five times in completed (pre-fix blind append) -> one card.
    tasks = {
        "pending": [],
        "inProgress": [],
        "review": [],
        "completed": [
            {"id": "iteration-1", "title": f"Iteration 1", "type": "iteration",
             "completedAt": "2026-07-01T10:0%d:00Z" % n}
            for n in range(5)
        ],
        "failed": [],
    }
    loki = _write_state(tmp_path, tasks)
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)

    ids = [t["id"] for t in result]
    assert ids.count("iteration-1") == 1, ids


@pytest.mark.asyncio
async def test_legacy_thin_done_marker_gets_honest_description(tmp_path):
    # Pre-fix thin markers carry exitCode/provider/completedAt but no description
    # (the "empty done card" symptom). The read path must synthesize an honest
    # one-liner from real fields - never invent an outcome, never mutate state.
    tasks = {
        "pending": [],
        "inProgress": [],
        "review": [],
        "completed": [
            {"id": "iteration-12", "type": "iteration", "title": "Iteration 12",
             "status": "completed", "exitCode": 0, "provider": "claude",
             "completedAt": "2026-07-01T16:09:39Z"},
        ],
        "failed": [
            {"id": "iteration-14", "type": "iteration", "title": "Iteration 14",
             "status": "failed", "exitCode": 2, "provider": "claude",
             "completedAt": "2026-07-01T16:10:00Z"},
        ],
    }
    loki = _write_state(tmp_path, tasks)
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)

    by_id = {t["id"]: t for t in result}
    # exit 0 -> honest clean-completion line, mentioning the provider
    assert by_id["iteration-12"]["description"] == "Iteration completed cleanly (exit 0), built by claude."
    # exit 2 -> honest non-zero-exit line (never says "cleanly")
    d14 = by_id["iteration-14"]["description"]
    assert "exit 2" in d14 and "cleanly" not in d14, d14
    # no empty done cards
    done = [t for t in result if t["status"] == "done"]
    assert all(t.get("description") or t.get("logs") for t in done), done


@pytest.mark.asyncio
async def test_new_card_description_is_not_overwritten(tmp_path):
    # A post-fix card already carries a real description; synthesis must not touch it.
    tasks = {
        "pending": [], "inProgress": [], "review": [], "failed": [],
        "completed": [
            {"id": "iteration-20", "type": "iteration",
             "title": "Iteration 20 complete - implement",
             "description": "Iteration 20 finished cleanly in the implement phase (exit 0, 3s).",
             "status": "completed", "exitCode": 0, "provider": "claude",
             "completedAt": "2026-07-01T17:00:00Z"},
        ],
    }
    loki = _write_state(tmp_path, tasks)
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)
    rec = next(t for t in result if t["id"] == "iteration-20")
    assert rec["description"] == "Iteration 20 finished cleanly in the implement phase (exit 0, 3s)."


@pytest.mark.asyncio
async def test_distinct_ids_all_survive(tmp_path):
    # No collision -> nothing dropped; pending stories + iterations both render.
    tasks = {
        "pending": [{"id": f"prd-00{n}", "title": f"story {n}", "type": "task"} for n in range(1, 4)],
        "inProgress": [{"id": "iteration-4", "title": "wip", "type": "iteration"}],
        "review": [],
        "completed": [
            {"id": f"iteration-{n}", "title": f"Iteration {n}", "type": "iteration",
             "completedAt": "2026-07-01T10:00:00Z"} for n in range(1, 4)
        ],
        "failed": [],
    }
    loki = _write_state(tmp_path, tasks)
    with patch.object(server, "_get_loki_dir", return_value=loki):
        result = await server.list_tasks(project_id=None, status=None)

    ids = sorted(t["id"] for t in result)
    assert ids == ["iteration-1", "iteration-2", "iteration-3", "iteration-4",
                   "prd-001", "prd-002", "prd-003"], ids
    # column integrity: pending stays pending, wip stays in_progress
    by_id = {t["id"]: t for t in result}
    assert by_id["prd-001"]["status"] == "pending"
    assert by_id["iteration-4"]["status"] == "in_progress"
    assert by_id["iteration-1"]["status"] == "done"
