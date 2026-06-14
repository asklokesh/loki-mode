"""
Regression test for ConsolidationPipeline.merge_with_existing field preservation.

Bug (v7.41.3): merge_with_existing constructed the merged SemanticPattern but
omitted importance, access_count, and last_accessed. Those fell back to schema
defaults (importance=0.5, access_count=0, last_accessed=None), so a frequently
accessed, high-importance pattern was reset to the floor on every merge. Decay
(apply_decay) and importance-weighted ranking (retrieval._score_result) then
treated a hot pattern as cold, returning stale/wrong results.

Fix: carry the preserved fields through the merged constructor:
  importance=max(best_match.importance, new_pattern.importance)
  access_count=best_match.access_count
  last_accessed=best_match.last_accessed

These tests build a high-importance, high-access existing pattern, merge a
similar new one, and assert the preserved fields are not reset to defaults.
"""

import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from memory.consolidation import ConsolidationPipeline  # noqa: E402
from memory.schemas import SemanticPattern  # noqa: E402
from memory.storage import MemoryStorage  # noqa: E402


@pytest.fixture
def pipeline(tmp_path):
    """A ConsolidationPipeline backed by a throwaway storage dir."""
    storage = MemoryStorage(base_path=str(tmp_path / "memory"))
    return ConsolidationPipeline(storage=storage)


def _hot_existing_pattern(last_accessed: datetime) -> SemanticPattern:
    """A frequently accessed, high-importance existing pattern."""
    return SemanticPattern(
        id="sem-hot-001",
        pattern="Always validate input before persisting to storage",
        category="error-handling",
        conditions=["user input", "persistence"],
        correct_approach="Validate then write",
        confidence=0.90,
        source_episodes=["ep-1", "ep-2"],
        usage_count=12,
        importance=0.95,
        access_count=37,
        last_accessed=last_accessed,
    )


def _similar_new_pattern() -> SemanticPattern:
    """A similar new pattern with cold/default retrieval fields."""
    return SemanticPattern(
        id="sem-new-002",
        pattern="Always validate input before persisting to storage",
        category="error-handling",
        conditions=["user input", "database write"],
        correct_approach="Validate then write",
        confidence=0.80,
        source_episodes=["ep-3"],
        usage_count=1,
        # importance/access_count/last_accessed left at schema defaults (cold)
    )


def test_merge_preserves_importance_access_and_last_accessed(pipeline):
    last_accessed = datetime.now(timezone.utc) - timedelta(hours=2)
    existing = _hot_existing_pattern(last_accessed)
    new = _similar_new_pattern()

    merged = pipeline.merge_with_existing(new, [existing])

    # Sanity: a merge actually happened (same id as the matched existing pattern).
    assert merged.id == existing.id

    # importance must not be reset to the 0.5 schema default; it must be at least
    # the original hot pattern's importance (max of the two).
    assert merged.importance >= existing.importance
    assert merged.importance == max(existing.importance, new.importance)
    assert merged.importance != SemanticPattern.importance  # not the default 0.5

    # access_count must carry the existing hot count, not reset to 0.
    assert merged.access_count == existing.access_count
    assert merged.access_count != 0

    # last_accessed must carry the existing timestamp, not reset to None.
    assert merged.last_accessed == last_accessed
    assert merged.last_accessed is not None


def test_merge_importance_takes_max_when_new_is_higher(pipeline):
    """If the new pattern is more important, the merged result adopts it."""
    existing = _hot_existing_pattern(datetime.now(timezone.utc))
    existing.importance = 0.40
    new = _similar_new_pattern()
    new.importance = 0.88

    merged = pipeline.merge_with_existing(new, [existing])

    assert merged.id == existing.id
    assert merged.importance == 0.88


def test_merge_still_preserves_existing_correct_logic(pipeline):
    """Confidence bump, source-episode union, usage_count, last_used unchanged."""
    last_used = datetime.now(timezone.utc) - timedelta(days=1)
    existing = _hot_existing_pattern(datetime.now(timezone.utc))
    existing.last_used = last_used
    new = _similar_new_pattern()

    merged = pipeline.merge_with_existing(new, [existing])

    assert merged.confidence == pytest.approx(min(existing.confidence + 0.05, 0.99))
    assert set(merged.source_episodes) == set(existing.source_episodes + new.source_episodes)
    assert merged.usage_count == existing.usage_count
    assert merged.last_used == last_used
