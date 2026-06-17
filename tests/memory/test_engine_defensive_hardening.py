"""
Defensive hardening regression tests for memory/engine.py (v7.41.5).

Covers two LOW-severity defensive bugs:

BUG 1 (index double-count on re-save):
  ``MemoryEngine._update_index_with_episode`` de-duplicated ``episode_ids``
  but incremented ``episode_count``, ``total_cost_usd``, and ``total_tokens``
  unconditionally. On resume/checkpoint the same trace id is re-saved, which
  inflated the aggregate counts and cost surfaced by the dashboard Memory
  panel and ``loki memory index``. The aggregates must now be gated by the
  same de-dup guard, so re-saving the same episode is a no-op for the
  aggregates while a genuinely new episode still increments them.

BUG 2 (non-dict pattern entry AttributeError):
  The pattern-iteration loops in engine.py assumed every element of
  ``patterns.json["patterns"]`` is a dict and called ``.get()`` on it. A
  single non-dict element (corrupt / external write) raised AttributeError
  and aborted the whole read, defeating the per-file resilience intent of
  ``_load_json``. Each loop now skips non-dict entries and keeps returning
  the valid ones.
"""

import sys
from pathlib import Path

import pytest

# Allow `import memory.engine` when run via `pytest` from the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from memory.engine import MemoryEngine  # noqa: E402


@pytest.fixture
def engine(tmp_path):
    """Fresh MemoryEngine rooted in a tmp directory (no shared state)."""
    base = tmp_path / "memory"
    return MemoryEngine(base_path=str(base))


# ---------------------------------------------------------------------------
# BUG 1: index aggregates must not double-count a re-saved episode
# ---------------------------------------------------------------------------

def _topic(index, topic_id):
    for topic in index.get("topics", []):
        if topic.get("id") == topic_id:
            return topic
    return None


def test_resave_same_episode_does_not_double_count(engine):
    """Re-saving the same episode id leaves episode_count / cost / tokens flat."""
    episode = {
        "id": "ep-2026-06-14-001",
        "phase": "implementation",
        "goal": "build feature X",
        "cost_usd": 0.50,
        "tokens_used": 1000,
        "files_modified": ["a.py"],
        "context": {},
    }

    # First store creates the topic.
    engine._update_index_with_episode(episode)
    index = engine.storage.read_json("index.json") or {}
    topic = _topic(index, "implementation")
    assert topic is not None
    assert topic["episode_count"] == 1
    assert topic["total_cost_usd"] == pytest.approx(0.50)
    assert topic["total_tokens"] == 1000
    assert topic["episode_ids"] == ["ep-2026-06-14-001"]

    # Re-save the EXACT same episode id (resume / checkpoint replay).
    engine._update_index_with_episode(episode)
    index = engine.storage.read_json("index.json") or {}
    topic = _topic(index, "implementation")
    # Aggregates must stay flat -- no double counting.
    assert topic["episode_count"] == 1, "re-saved episode double-counted episode_count"
    assert topic["total_cost_usd"] == pytest.approx(0.50), \
        "re-saved episode double-counted total_cost_usd"
    assert topic["total_tokens"] == 1000, "re-saved episode double-counted total_tokens"
    assert topic["episode_ids"] == ["ep-2026-06-14-001"]


def test_new_episode_in_same_topic_increments(engine):
    """A genuinely new episode id in the same phase DOES increment aggregates."""
    base = {
        "phase": "implementation",
        "goal": "build feature X",
        "cost_usd": 0.50,
        "tokens_used": 1000,
        "files_modified": ["a.py"],
        "context": {},
    }
    engine._update_index_with_episode({**base, "id": "ep-2026-06-14-001"})
    engine._update_index_with_episode({**base, "id": "ep-2026-06-14-002"})

    index = engine.storage.read_json("index.json") or {}
    topic = _topic(index, "implementation")
    assert topic is not None
    assert topic["episode_count"] == 2, "second distinct episode did not increment count"
    assert topic["total_cost_usd"] == pytest.approx(1.00), \
        "second distinct episode did not add cost"
    assert topic["total_tokens"] == 2000, "second distinct episode did not add tokens"
    assert set(topic["episode_ids"]) == {"ep-2026-06-14-001", "ep-2026-06-14-002"}


# ---------------------------------------------------------------------------
# BUG 2: non-dict pattern entries are skipped, not fatal
# ---------------------------------------------------------------------------

def _write_patterns_with_junk(engine):
    """Persist a patterns.json mixing a valid dict pattern with junk entries."""
    valid = {
        "id": "pat-valid-1",
        "category": "testing",
        "confidence": 0.9,
        "source_episodes": ["ep-1", "ep-2"],
        "name": "valid pattern",
        "description": "a valid pattern",
    }
    patterns_data = {
        "version": MemoryEngine.CURRENT_SCHEMA_VERSION,
        "patterns": [
            "not a dict, just a string",  # junk (string)
            valid,                         # valid dict
            None,                          # junk (None)
            42,                            # junk (int)
        ],
    }
    engine.storage.write_json("semantic/patterns.json", patterns_data)
    return valid


def test_find_patterns_skips_non_dict_entries(engine):
    """find_patterns returns the valid pattern and ignores junk without raising."""
    valid = _write_patterns_with_junk(engine)
    results = engine.find_patterns(min_confidence=0.5)
    assert len(results) == 1, f"expected 1 valid pattern, got {len(results)}"
    assert results[0].id == valid["id"]


def test_get_pattern_skips_non_dict_entries(engine):
    """get_pattern locates the valid pattern past junk entries without raising."""
    valid = _write_patterns_with_junk(engine)
    found = engine.get_pattern("pat-valid-1")
    assert found is not None
    assert found.id == valid["id"]
    # A non-existent id still returns None gracefully (junk never raises).
    assert engine.get_pattern("pat-does-not-exist") is None


def test_cleanup_old_skips_non_dict_entries(engine):
    """cleanup_old reads source_episodes from valid patterns, skips junk."""
    _write_patterns_with_junk(engine)
    # No episodic dir exists, so cleanup returns 0; the point is it must NOT
    # raise while iterating the junk-laden patterns to collect referenced ids.
    removed = engine.cleanup_old(days=30)
    assert removed == 0


# ---------------------------------------------------------------------------
# BUG 3: index.json missing the "topics" key must not crash store_pattern
# ---------------------------------------------------------------------------
#
# ``_update_index_with_pattern`` indexed ``index["topics"]`` directly. The
# ``or {...}`` default only fires when the WHOLE file is falsy, so an index.json
# that is valid JSON but lacks the ``topics`` key (older/partial writer, or a
# hand edit) raised ``KeyError: 'topics'`` and aborted ``store_pattern``,
# losing the index update. The sibling ``_update_index_with_episode`` already
# guarded this with ``setdefault``; this aligns the pattern path.


def test_store_pattern_with_topicless_index_does_not_crash(engine):
    """store_pattern survives an index.json that omits the 'topics' key."""
    from memory.schemas import SemanticPattern

    engine.initialize()
    # Simulate a partial / older index.json: valid JSON, no 'topics' key.
    engine.storage.write_json(
        "index.json",
        {"version": "1.1.0", "total_memories": 0},  # deliberately no 'topics'
    )

    pattern = SemanticPattern(
        id="pat-topicless-1",
        pattern="always write a regression test",
        category="testing",
        confidence=0.9,
    )
    # Pre-fix this raised KeyError('topics'); post-fix it must complete.
    engine.store_pattern(pattern)

    index = engine.storage.read_json("index.json") or {}
    # The topic for the pattern's category must now be present.
    topic = _topic(index, "testing")
    assert topic is not None, "topic was not created in a topicless index"
    assert topic["id"] == "testing"


# ---------------------------------------------------------------------------
# BUG 4: one corrupt episode timestamp must not crash the whole recent-scan
# ---------------------------------------------------------------------------
#
# ``_dict_to_episode`` called ``datetime.fromisoformat`` with no guard. A single
# episode file with a non-ISO ``timestamp`` value raised ``ValueError`` that
# propagated out of ``get_recent_episodes`` (and therefore ``retrieve_relevant``
# on the RARV hot path), so one corrupt file blinded the engine to every other
# valid episode in the same scan. The parse is now best-effort per episode.


def test_recent_episodes_survives_one_corrupt_timestamp(engine):
    """A single unparseable timestamp does not abort the recent-episodes scan."""
    import json
    from datetime import datetime, timezone

    engine.initialize()
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    epdir = Path(engine.base_path) / "episodic" / day
    epdir.mkdir(parents=True, exist_ok=True)

    # One corrupt episode (bad timestamp) and one valid episode.
    (epdir / "task-ep-corrupt.json").write_text(
        json.dumps({"id": "ep-corrupt", "timestamp": "not-a-timestamp", "context": {}})
    )
    (epdir / "task-ep-valid.json").write_text(
        json.dumps(
            {"id": "ep-valid", "timestamp": "2026-06-15T10:00:00Z",
             "context": {"goal": "real work"}}
        )
    )

    # Pre-fix this raised ValueError before returning anything; post-fix BOTH
    # episodes come back (the corrupt one with a fallback timestamp).
    episodes = engine.get_recent_episodes(limit=10)
    ids = {ep.id for ep in episodes}
    assert ids == {"ep-corrupt", "ep-valid"}, (
        f"corrupt timestamp dropped valid episodes; got {sorted(ids)}"
    )
    # The corrupt episode's timestamp was replaced with a valid datetime, not
    # left as a raw string, so downstream sorting/serialization stays sound.
    corrupt = next(ep for ep in episodes if ep.id == "ep-corrupt")
    assert isinstance(corrupt.timestamp, datetime)
    assert corrupt.timestamp.tzinfo is not None
