"""
tests/dashboard/test_memory_json_parity.py

PR #178 + follow-up: the memory endpoints must agree on a JSON-backed project
whose episodes/skills live in DATED subdirectories (episodic/YYYY-MM-DD/*.json).

Before the fix, /api/memory/summary used a flat glob("*.json") and reported 0
even when episodes existed. PR #178 fixed summary, but /api/memory/episodes and
the skills endpoints still used a flat glob, so the summary count and the
drill-in list disagreed (summary 28, list 0). And latestDate was picked by
filename sort (a hash tiebreak), not by recorded timestamp, so it could report
the wrong episode.

This test builds a JSON memory tree with dated subdirs and asserts:
  1. summary episodic count == /api/memory/episodes list length (parity)
  2. summary skills count == /api/memory/skills list length (parity)
  3. summary latestDate == the true max timestamp (not a filename sort)
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


def _build_json_memory(tmp_path: Path) -> Path:
    loki = tmp_path / ".loki"
    mem = loki / "memory"
    # episodes across two dated subdirs; timestamps deliberately NOT in filename
    # order (the last file by name is NOT the newest by time).
    ep = mem / "episodic"
    (ep / "2026-06-30").mkdir(parents=True, exist_ok=True)
    (ep / "2026-07-01").mkdir(parents=True, exist_ok=True)
    # newest timestamp lives in a file whose name sorts EARLIER, to catch the
    # filename-vs-timestamp bug.
    (ep / "2026-07-01" / "aaaa.json").write_text(json.dumps({"id": "e-new", "timestamp": "2026-07-01T23:59:00Z"}))
    (ep / "2026-07-01" / "zzzz.json").write_text(json.dumps({"id": "e-mid", "timestamp": "2026-07-01T08:00:00Z"}))
    (ep / "2026-06-30" / "mmmm.json").write_text(json.dumps({"id": "e-old", "timestamp": "2026-06-30T12:00:00Z"}))
    # a .lock file that must be ignored
    (ep / "2026-07-01" / "x.json.lock").write_text("lock")
    # skills in a subdir
    sk = mem / "skills"
    (sk / "cat").mkdir(parents=True, exist_ok=True)
    (sk / "cat" / "s1.json").write_text(json.dumps({"id": "s1"}))
    (sk / "cat" / "s2.json").write_text(json.dumps({"id": "s2"}))
    return loki


@pytest.mark.asyncio
async def test_summary_and_episodes_agree_on_dated_dirs(tmp_path):
    loki = _build_json_memory(tmp_path)
    with patch.object(server, "_get_loki_dir", return_value=loki), \
         patch.object(server, "_get_memory_storage", return_value=None):
        summary = await server.get_memory_summary()
        episodes = await server.list_episodes(limit=1000)

    assert summary["backend"] == "json", summary
    assert summary["episodic"]["count"] == 3, summary
    # PARITY: the count must equal the drill-in list length
    assert summary["episodic"]["count"] == len(episodes), (summary["episodic"]["count"], len(episodes))
    # latestDate is the true max timestamp, NOT the last file by name
    assert summary["episodic"]["latestDate"] == "2026-07-01T23:59:00Z", summary["episodic"]["latestDate"]
    # episodes list is newest-first by timestamp
    assert episodes[0].get("id") == "e-new", episodes[0]


@pytest.mark.asyncio
async def test_summary_and_skills_agree_on_subdirs(tmp_path):
    loki = _build_json_memory(tmp_path)
    with patch.object(server, "_get_loki_dir", return_value=loki), \
         patch.object(server, "_get_memory_storage", return_value=None):
        summary = await server.get_memory_summary()
        skills = await server.list_skills() if hasattr(server, "list_skills") else None

    assert summary["procedural"]["skills"] == 2, summary
    if skills is not None:
        assert summary["procedural"]["skills"] == len(skills), (summary["procedural"]["skills"], len(skills))


@pytest.mark.asyncio
async def test_lock_files_are_ignored(tmp_path):
    loki = _build_json_memory(tmp_path)
    ep_dir = loki / "memory" / "episodic"
    files = server._memory_episode_files(ep_dir)
    assert all(not str(f).endswith(".lock") for f in files), files
    assert len(files) == 3, files
