"""
Wave-5 memory-core hardening tests (lane: memory/engine.py, memory/storage.py).

Covers three confirmed wave-5 findings:

  (2) storage.calculate_importance: log1p(access_count) must not crash on a
      non-numeric or negative access_count (corrupt/hand-edited record). The
      pre-fix `or 0` guard only handled an explicit null; a stored string raised
      TypeError on `"5" > 0` and a negative <= -1 raised a math domain error.

  (3) storage.with_namespace: validation was incomplete. An empty/None/non-str
      namespace silently resolved to the default (un-namespaced) root instead of
      being rejected; charset validation was duplicated and could drift.

  (4) engine._dict_to_episode (and the sibling _dict_to_pattern/_dict_to_skill):
      a corrupt `last_accessed` on ONE record raised out of the converter via an
      unguarded datetime.fromisoformat, crashing the whole retrieval batch
      list-comp (get_recent_episodes) and dropping EVERY record in the scan. It
      must now tolerate the bad value (fall back to None) so the record is still
      retrievable.

Finding (1) ("engine.py episode de-dup on resume SKIPs updates when the id
changes") was inspected and SKIPPED as not realizable in engine.py: the episode
JSON file is unconditionally overwritten by id at store_episode, so a same-id
update always persists; the only id-dedup (the index topic stat-counter) does
not drop episodes, and a CHANGED id is a new id that is never dropped. See the
agent report for the refuted op-sequence.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from memory.engine import MemoryEngine
from memory.storage import MemoryStorage


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _engine() -> MemoryEngine:
    d = tempfile.mkdtemp(prefix="loki-wave5-eng-")
    eng = MemoryEngine(base_path=d)
    eng.initialize()
    return eng


def _storage(tmp_path: Path) -> MemoryStorage:
    root = tmp_path / "memory"
    root.mkdir()
    return MemoryStorage(base_path=str(root))


# ---------------------------------------------------------------------------
# Finding (2): calculate_importance access_count type/negative safety
# ---------------------------------------------------------------------------

def test_importance_survives_string_access_count(tmp_path: Path):
    """A stored non-numeric access_count must not crash importance scoring.

    Pre-fix: `"5" or 0` -> "5", then `"5" > 0` raised TypeError.
    """
    storage = _storage(tmp_path)
    result = storage.calculate_importance({"importance": 0.5, "access_count": "5"})
    # No boost is applied (string coerced to 0), so importance stays at base.
    assert result == pytest.approx(0.5)


def test_importance_survives_negative_access_count(tmp_path: Path):
    """A negative access_count must not reach log1p (domain error for <= -1)."""
    storage = _storage(tmp_path)
    result = storage.calculate_importance({"importance": 0.5, "access_count": -10})
    # Negative coerced to 0 -> no boost -> base preserved.
    assert result == pytest.approx(0.5)


def test_importance_survives_list_access_count(tmp_path: Path):
    """A structurally-corrupt (list) access_count must not crash scoring."""
    storage = _storage(tmp_path)
    result = storage.calculate_importance({"importance": 0.5, "access_count": [1, 2]})
    assert result == pytest.approx(0.5)


def test_importance_still_boosts_on_valid_access_count(tmp_path: Path):
    """Non-vacuity: a real positive access_count STILL boosts importance.

    Guards against a fix that just zeroes everything.
    """
    storage = _storage(tmp_path)
    base = storage.calculate_importance({"importance": 0.5, "access_count": 0})
    boosted = storage.calculate_importance({"importance": 0.5, "access_count": 100})
    assert boosted > base


def test_importance_bool_access_count_is_not_counted(tmp_path: Path):
    """A stray boolean True must not be treated as access_count == 1."""
    storage = _storage(tmp_path)
    with_true = storage.calculate_importance({"importance": 0.5, "access_count": True})
    with_zero = storage.calculate_importance({"importance": 0.5, "access_count": 0})
    assert with_true == pytest.approx(with_zero)


# ---------------------------------------------------------------------------
# Finding (3): with_namespace validation (non-empty, charset, reject bad input)
# ---------------------------------------------------------------------------

def test_with_namespace_rejects_empty_string(tmp_path: Path):
    """An empty namespace must be rejected, not silently resolve to default."""
    storage = _storage(tmp_path)
    with pytest.raises(ValueError):
        storage.with_namespace("")


def test_with_namespace_rejects_none(tmp_path: Path):
    """None must be rejected: with_namespace is an explicit switch call."""
    storage = _storage(tmp_path)
    with pytest.raises(ValueError):
        storage.with_namespace(None)  # type: ignore[arg-type]


def test_with_namespace_rejects_whitespace_only(tmp_path: Path):
    """A whitespace-only namespace is meaningless and must be rejected."""
    storage = _storage(tmp_path)
    with pytest.raises(ValueError):
        storage.with_namespace("   ")


def test_with_namespace_rejects_path_traversal(tmp_path: Path):
    """Charset validation must still reject traversal/separators."""
    storage = _storage(tmp_path)
    for bad in ["../evil", "a/b", "a b", "a.b", "na\x00me"]:
        with pytest.raises(ValueError):
            storage.with_namespace(bad)


def test_with_namespace_accepts_valid(tmp_path: Path):
    """Non-vacuity: a valid namespace still produces a namespaced instance."""
    storage = _storage(tmp_path)
    ns = storage.with_namespace("project-a_1")
    assert ns.namespace == "project-a_1"
    # The namespaced root is a child segment of the original root.
    assert ns.base_path == storage.root_path / "project-a_1"


def test_init_still_accepts_none_namespace(tmp_path: Path):
    """Backward-compat guard: __init__ must keep accepting namespace=None."""
    root = tmp_path / "memory"
    root.mkdir()
    storage = MemoryStorage(base_path=str(root))  # namespace defaults to None
    assert storage.namespace is None
    # Charset validation must still apply on a bad non-default namespace.
    with pytest.raises(ValueError):
        MemoryStorage(base_path=str(root), namespace="../evil")


# ---------------------------------------------------------------------------
# Finding (4): corrupt last_accessed on ONE episode must not drop the batch
# ---------------------------------------------------------------------------

def _write_episode(eng: MemoryEngine, date: str, eid: str, extra: dict) -> None:
    rec = {
        "id": eid,
        "timestamp": f"{date}T10:00:00+00:00",
        "context": {"goal": "wave5 retrieval", "phase": "discovery"},
    }
    rec.update(extra)
    eng.storage.ensure_directory(f"episodic/{date}")
    eng.storage.write_json(f"episodic/{date}/task-{eid}.json", rec)


def test_corrupt_last_accessed_does_not_drop_episode():
    """A single episode with a corrupt last_accessed must still be retrieved.

    Pre-fix: datetime.fromisoformat("not-a-date") raised ValueError out of
    _dict_to_episode, crashing the list-comp in get_recent_episodes and dropping
    EVERY episode in the scan.
    """
    eng = _engine()
    _write_episode(eng, "2026-06-01", "ep-good", {"last_accessed": "2026-06-01T09:00:00+00:00"})
    _write_episode(eng, "2026-06-01", "ep-bad", {"last_accessed": "not-a-date"})

    episodes = eng.get_recent_episodes(limit=10)
    ids = {e.id for e in episodes}
    assert "ep-good" in ids
    assert "ep-bad" in ids, "corrupt last_accessed dropped the episode (and the batch)"

    # The corrupt one falls back to None (never-accessed), not a crash.
    bad = next(e for e in episodes if e.id == "ep-bad")
    assert bad.last_accessed is None


def test_corrupt_last_accessed_one_bad_does_not_drop_siblings():
    """Non-vacuity: a corrupt record must not take down its valid siblings."""
    eng = _engine()
    for i in range(3):
        _write_episode(eng, "2026-06-02", f"ep-ok-{i}",
                       {"last_accessed": "2026-06-02T08:00:00+00:00"})
    _write_episode(eng, "2026-06-02", "ep-corrupt", {"last_accessed": "garbage"})

    episodes = eng.get_recent_episodes(limit=20)
    ids = {e.id for e in episodes}
    assert {"ep-ok-0", "ep-ok-1", "ep-ok-2", "ep-corrupt"}.issubset(ids)


def test_valid_last_accessed_still_parsed():
    """Non-vacuity: a valid last_accessed is still parsed to a tz-aware dt."""
    eng = _engine()
    _write_episode(eng, "2026-06-03", "ep-v", {"last_accessed": "2026-06-03T07:00:00Z"})
    episodes = eng.get_recent_episodes(limit=5)
    ep = next(e for e in episodes if e.id == "ep-v")
    assert ep.last_accessed is not None
    assert ep.last_accessed.tzinfo is not None


def test_parse_optional_datetime_helper():
    """Unit-level coverage of the shared tolerant parser."""
    assert MemoryEngine._parse_optional_datetime(None) is None
    assert MemoryEngine._parse_optional_datetime("") is None
    assert MemoryEngine._parse_optional_datetime("nonsense") is None
    parsed = MemoryEngine._parse_optional_datetime("2026-06-03T07:00:00Z")
    assert parsed is not None and parsed.tzinfo is not None


def test_corrupt_pattern_datetimes_do_not_crash_conversion():
    """A corrupt last_used OR last_accessed on a pattern must not crash.

    _dict_to_pattern parses both datetimes on the find_patterns retrieval hot
    path; pre-fix BOTH used a raw fromisoformat. The pattern must still convert.
    """
    eng = _engine()
    pattern = eng._dict_to_pattern({
        "id": "pat-bad",
        "pattern": "x",
        "category": "c",
        "last_used": "not-a-date",
        "last_accessed": "also-garbage",
    })
    assert pattern.id == "pat-bad"
    assert pattern.last_used is None
    assert pattern.last_accessed is None


def test_corrupt_skill_last_accessed_does_not_crash_conversion():
    """A corrupt last_accessed on a skill must not crash _dict_to_skill."""
    eng = _engine()
    skill = eng._dict_to_skill({
        "id": "sk-bad",
        "name": "n",
        "description": "d",
        "last_accessed": "garbage",
    })
    assert skill.id == "sk-bad"
    assert skill.last_accessed is None


def test_valid_pattern_last_used_still_parsed():
    """Non-vacuity: a valid pattern last_used is still parsed (not nulled)."""
    eng = _engine()
    pattern = eng._dict_to_pattern({
        "id": "pat-ok",
        "pattern": "x",
        "category": "c",
        "last_used": "2026-06-03T07:00:00Z",
    })
    assert pattern.last_used is not None
    assert pattern.last_used.tzinfo is not None


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
