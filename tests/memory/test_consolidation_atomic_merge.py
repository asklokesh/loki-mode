"""
Regression tests for two memory data-integrity fixes:

F3 (consolidation lost-update, BUG-MEM C1)
------------------------------------------
The merge during consolidation previously read the existing pattern
(load_pattern) and wrote the merged result (update_pattern) under SEPARATE lock
acquisitions. A concurrent storage.increment_pattern_usage() bump landing
between the read and the write was silently lost. The fix introduces
storage.update_pattern_with_merge(pattern_id, merge_fn), which performs the
read, the caller's merge, and the write inside ONE exclusive lock on
patterns.json (the same path increment_pattern_usage / update_pattern lock), so
the merge always builds on the live on-disk record.

These tests prove:
  * update_pattern_with_merge passes the FRESH on-disk record to the merge
    callback (not a stale snapshot the caller captured earlier);
  * a bump applied to the on-disk record before the merge runs survives, because
    the callback sees it (atomic read-merge-write);
  * a non-existent id returns False (caller falls back to create);
  * the id cannot be orphaned by a merge that changes it.

F4 (vector index staleness, BUG-MEM-002)
----------------------------------------
After consolidation rewrites patterns.json, the in-memory vector index is stale.
retrieve_by_similarity must NOT return results from the stale index. The guard
compares patterns.json mtime against the index build time and falls back to
keyword search when the file is newer. This test proves the stale index is
skipped (the fake vector index's search() is never called) when patterns.json is
modified after the index was built.
"""

import os
import sys
import time
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from memory.schemas import SemanticPattern  # noqa: E402
from memory.storage import MemoryStorage  # noqa: E402
from memory.retrieval import MemoryRetrieval  # noqa: E402


# ---------------------------------------------------------------------------
# F3: storage.update_pattern_with_merge atomicity
# ---------------------------------------------------------------------------


def _pattern(pattern_id: str, usage_count: int = 1) -> SemanticPattern:
    return SemanticPattern(
        id=pattern_id,
        pattern="Validate input before persisting",
        category="error-handling",
        conditions=["input"],
        correct_approach="validate then write",
        confidence=0.8,
        source_episodes=["ep-1"],
        usage_count=usage_count,
    )


@pytest.fixture
def storage(tmp_path):
    return MemoryStorage(base_path=str(tmp_path / "memory"))


def test_update_pattern_with_merge_sees_fresh_on_disk_record(storage):
    """The merge callback must receive the CURRENT on-disk dict, not whatever the
    caller last saw. This is the heart of the lost-update fix: a usage bump that
    landed after the caller's snapshot is visible to the merge."""
    storage.save_pattern(_pattern("sem-1", usage_count=1))

    # Caller captured a stale snapshot (usage_count=1) here.
    # Meanwhile a concurrent increment bumps the on-disk record to 2.
    assert storage.increment_pattern_usage("sem-1") is True

    seen = {}

    def merge_fn(current):
        # Atomicity proof: under the single lock we see the BUMPED value (2),
        # not the caller's stale snapshot (1).
        seen["usage_count"] = current.get("usage_count")
        merged = dict(current)
        merged["confidence"] = 0.99  # represent the merge's own change
        return merged

    assert storage.update_pattern_with_merge("sem-1", merge_fn) is True
    assert seen["usage_count"] == 2, (
        "merge_fn must see the live (bumped) on-disk usage_count, proving the "
        "read happens inside the same lock as the write (no lost update)"
    )

    final = storage.load_pattern("sem-1")
    # Both the bump (usage_count=2) AND the merge's change (confidence=0.99)
    # are persisted -- neither clobbered the other.
    assert final["usage_count"] == 2
    assert final["confidence"] == 0.99


def test_update_pattern_with_merge_returns_false_for_missing_id(storage):
    """A missing id must return False so the caller falls back to a create
    (and the callback must not run)."""
    storage.save_pattern(_pattern("sem-present"))

    called = {"n": 0}

    def merge_fn(current):
        called["n"] += 1
        return current

    assert storage.update_pattern_with_merge("sem-absent", merge_fn) is False
    assert called["n"] == 0, "merge_fn must not run when the pattern id is absent"


def test_update_pattern_with_merge_preserves_id(storage):
    """A merge callback that tries to change the id must not orphan the record;
    the id is forced back to the target."""
    storage.save_pattern(_pattern("sem-keep"))

    def merge_fn(current):
        merged = dict(current)
        merged["id"] = "sem-hijacked"
        return merged

    assert storage.update_pattern_with_merge("sem-keep", merge_fn) is True
    assert storage.load_pattern("sem-keep") is not None
    assert storage.load_pattern("sem-hijacked") is None


def test_update_pattern_with_merge_accepts_semanticpattern_object(storage):
    """The callback may return a SemanticPattern (not just a dict)."""
    storage.save_pattern(_pattern("sem-obj", usage_count=3))

    def merge_fn(current):
        p = SemanticPattern.from_dict(current)
        p.confidence = 0.77
        return p

    assert storage.update_pattern_with_merge("sem-obj", merge_fn) is True
    final = storage.load_pattern("sem-obj")
    assert final["confidence"] == 0.77
    assert final["usage_count"] == 3  # unchanged field carried through


# ---------------------------------------------------------------------------
# F4: retrieval skips a stale vector index after consolidation
# ---------------------------------------------------------------------------


class _FakeEmbeddingEngine:
    def embed(self, text):
        return [0.1, 0.2, 0.3]


class _RecordingVectorIndex:
    """Records whether search() was called, so the test can prove the stale
    index was skipped."""

    def __init__(self):
        self.searched = False

    def search(self, embedding, top_k):
        self.searched = True
        return [("sem-x", 0.99, {"id": "sem-x", "namespace": "default"})]


def test_retrieval_skips_stale_index_when_patterns_modified_after_build(tmp_path):
    base = tmp_path / "memory"
    semantic_dir = base / "semantic"
    semantic_dir.mkdir(parents=True)
    patterns_path = semantic_dir / "patterns.json"
    patterns_path.write_text('{"patterns": []}')

    fake_index = _RecordingVectorIndex()
    retrieval = MemoryRetrieval(
        storage=MemoryStorage(base_path=str(base)),
        embedding_engine=_FakeEmbeddingEngine(),
        vector_indices={"semantic": fake_index},
        base_path=str(base),
    )

    # Simulate an index that was built in the past.
    retrieval._indices_built_at = time.time() - 100

    # Consolidation rewrites patterns.json -> mtime newer than the build time.
    time.sleep(0.01)
    patterns_path.write_text('{"patterns": [{"id": "sem-new"}]}')
    newer = retrieval._indices_built_at + 50
    os.utime(patterns_path, (newer, newer))

    results = retrieval.retrieve_by_similarity("anything", "semantic", top_k=3)

    assert fake_index.searched is False, (
        "stale vector index must NOT be searched after patterns.json was modified "
        "more recently than the index build (BUG-MEM-002): retrieval should fall "
        "back to keyword search"
    )
    # Keyword fallback over an empty store returns nothing -- the point is that
    # the stale index was skipped, not what keyword returns.
    assert isinstance(results, list)


def test_retrieval_uses_index_when_not_stale(tmp_path):
    """Control: when patterns.json is OLDER than the index build, the vector
    index IS used (proves the staleness guard is not blanket-disabling search)."""
    base = tmp_path / "memory"
    semantic_dir = base / "semantic"
    semantic_dir.mkdir(parents=True)
    patterns_path = semantic_dir / "patterns.json"
    patterns_path.write_text('{"patterns": []}')

    fake_index = _RecordingVectorIndex()
    retrieval = MemoryRetrieval(
        storage=MemoryStorage(base_path=str(base)),
        embedding_engine=_FakeEmbeddingEngine(),
        vector_indices={"semantic": fake_index},
        base_path=str(base),
    )

    # Index built AFTER patterns.json's mtime (fresh).
    older = time.time() - 100
    os.utime(patterns_path, (older, older))
    retrieval._indices_built_at = time.time()

    retrieval.retrieve_by_similarity("anything", "semantic", top_k=3)

    assert fake_index.searched is True, (
        "a fresh (non-stale) vector index must be searched"
    )
