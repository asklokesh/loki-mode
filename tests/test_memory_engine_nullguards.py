"""Regression tests for memory/engine.py null-guard and aggregation bugs.

Deep bug-hunt (engine.py) findings:
  Lead 1: cleanup_old() crashed with TypeError when a semantic pattern carried
          an explicit JSON null source_episodes (set.update(None)).
  Lead 3: rebuild_index() crashed with TypeError when a single episode had a
          missing/null timestamp ("str > None" in the last_accessed compare).
  Lead 6: get_stats()["total_memories"] undercounted episodes that shared a
          phase (incremented per-topic, while rebuild_index counts per-episode),
          so the two functions in the same file disagreed on the same field.

Each test fails on pre-fix engine.py and passes post-fix. Non-vacuity is shown
by also exercising the positive/normal path.
"""

import tempfile

import pytest

from memory.engine import MemoryEngine
from memory.schemas import EpisodeTrace


def _engine():
    d = tempfile.mkdtemp(prefix="loki-eng-nullguard-")
    eng = MemoryEngine(base_path=d)
    eng.initialize()
    return eng


# ---------------------------------------------------------------------------
# Lead 1: cleanup_old null source_episodes
# ---------------------------------------------------------------------------

def test_cleanup_old_survives_null_source_episodes():
    """A pattern with explicit null source_episodes must not crash cleanup_old."""
    eng = _engine()
    eng.storage.write_json(
        "semantic/patterns.json",
        {"patterns": [{"id": "p1", "source_episodes": None}]},
    )
    # Pre-fix this raised TypeError: 'NoneType' object is not iterable.
    removed = eng.cleanup_old(days=0)
    assert removed == 0


def test_cleanup_old_honors_real_source_episodes():
    """Non-vacuity: a real (non-null) source_episodes list still protects refs."""
    import os

    eng = _engine()
    eng.storage.write_json(
        "semantic/patterns.json",
        {"patterns": [{"id": "p1", "source_episodes": ["ep-keep"]}]},
    )
    os.makedirs(os.path.join(eng.base_path, "episodic", "2000-01-01"), exist_ok=True)
    # Referenced episode (old) must be retained; unreferenced (old) removed.
    eng.storage.write_json(
        "episodic/2000-01-01/task-ep-keep.json", {"id": "ep-keep"}
    )
    eng.storage.write_json(
        "episodic/2000-01-01/task-ep-drop.json", {"id": "ep-drop"}
    )
    removed = eng.cleanup_old(days=0)
    assert removed == 1
    assert eng.storage.read_json("episodic/2000-01-01/task-ep-keep.json") is not None
    assert eng.storage.read_json("episodic/2000-01-01/task-ep-drop.json") is None


# ---------------------------------------------------------------------------
# Lead 3: rebuild_index null timestamp
# ---------------------------------------------------------------------------

def test_rebuild_index_survives_null_timestamp():
    """A single episode with a missing timestamp must not crash rebuild_index."""
    import os

    eng = _engine()
    os.makedirs(os.path.join(eng.base_path, "episodic", "2026-01-01"), exist_ok=True)
    eng.storage.write_json(
        "episodic/2026-01-01/task-ep1.json",
        {"id": "ep1", "context": {"phase": "dev", "goal": "x"}},  # no timestamp
    )
    # Pre-fix this raised TypeError: '>' not supported between 'str' and 'NoneType'.
    eng.rebuild_index()
    index = eng.get_index()
    assert any(t.get("id") == "dev" for t in index.get("topics", []))


def test_rebuild_index_tracks_latest_timestamp():
    """Non-vacuity: last_accessed reflects the newest timestamp in a phase."""
    import os

    eng = _engine()
    os.makedirs(os.path.join(eng.base_path, "episodic", "2026-01-01"), exist_ok=True)
    eng.storage.write_json(
        "episodic/2026-01-01/task-epA.json",
        {"id": "epA", "context": {"phase": "dev"}, "timestamp": "2026-01-01T00:00:00"},
    )
    eng.storage.write_json(
        "episodic/2026-01-01/task-epB.json",
        {"id": "epB", "context": {"phase": "dev"}, "timestamp": "2026-06-01T00:00:00"},
    )
    eng.rebuild_index()
    topic = next(t for t in eng.get_index()["topics"] if t["id"] == "dev")
    assert topic["last_accessed"] == "2026-06-01T00:00:00"


# ---------------------------------------------------------------------------
# Lead 6: total_memories aggregation parity
# ---------------------------------------------------------------------------

def test_total_memories_counts_every_episode_in_a_phase():
    """get_stats total_memories must match rebuild_index (per-episode count)."""
    eng = _engine()
    for i in range(3):
        eng.store_episode(
            EpisodeTrace.create(task_id=f"t{i}", agent="a", goal="g", phase="dev")
        )
    # Pre-fix: get_stats reported 1 (per-topic), rebuild_index reported 3.
    assert eng.get_stats()["total_memories"] == 3
    eng.rebuild_index()
    assert eng.get_stats()["total_memories"] == 3


def test_total_memories_does_not_double_count_resave():
    """Non-vacuity: re-saving the same episode id must not inflate the count."""
    eng = _engine()
    trace = EpisodeTrace.create(task_id="t", agent="a", goal="g", phase="dev")
    eng.store_episode(trace)
    eng.store_episode(trace)  # resume/checkpoint re-save, same id
    assert eng.get_stats()["total_memories"] == 1


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
