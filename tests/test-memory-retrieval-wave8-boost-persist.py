#!/usr/bin/env python3
"""
Wave-8 regression test for retrieval-F1: retrieval-time importance boost is
never persisted to disk.

FINDING (retrieval-F1): TaskAwareRetrieval.retrieve_task_aware calls
`self.storage.boost_on_retrieval(memory, boost=0.05)` for each returned memory
(memory/retrieval.py:480-482) to implement the "use it or lose it" principle:
frequently retrieved memories should keep their importance while unused ones
decay. The intent is that repeated retrieval reinforces a memory's stored
importance.

ROOT CAUSE (lives in memory/storage.py, NOT retrieval.py):
`MemoryStorage.boost_on_retrieval` (memory/storage.py:1346-1384) only mutates
the in-memory dict and returns it. It never writes the boosted record back to
disk: there is no `_atomic_write` and no `_file_lock` read-mutate-write, unlike
the decay path (`_decay_episodic`, memory/storage.py:1438-1452, which DOES
persist under a lock). That asymmetry is the bug. Because retrieval also boosts
shallow copies of the records (memory/retrieval.py:1004 `item = dict(item)`),
even the in-memory mutation lands on a throwaway dict, but fixing the copy
alone changes nothing observable: the storage method writes nothing regardless.

WHY THIS TEST IS xfail(strict=True):
The fix must change memory/storage.py (out of scope for the retrieval-F1
slice, which is restricted to memory/retrieval.py). Until storage.boost_on_retrieval
does its own atomic read-mutate-write keyed off memory["id"]/memory["_source"]
(mirroring _decay_episodic), this assertion cannot pass. Marking it
strict-xfail keeps the suite green today and AUTO-TRIPS (xpass -> failure) the
moment the storage fix lands, forcing this test to be flipped to a normal
assertion. The RED/xfail run below is the non-vacuity proof that the bug is
real: a real MemoryStorage on a tmp dir, retrieve, then re-read the record from
disk, and the stored importance has NOT increased.

NOTE ON DISCOVERY: this file's name is hyphenated, so pytest's default
`python_files` (test_*.py / *_test.py) will NOT collect it by recursion. Run it
by explicit path (`python3 -m pytest tests/test-memory-retrieval-wave8-boost-persist.py`)
or standalone (`python3 tests/test-memory-retrieval-wave8-boost-persist.py`).
The __main__ block runs the repro directly and prints the observed before/after
stored importance so a human can confirm the bug without pytest.
"""

import os
import sys
import tempfile

import pytest

# Make the repo root importable so `import memory.*` resolves regardless of cwd.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from memory.retrieval import MemoryRetrieval
from memory.storage import MemoryStorage


def _seed_episode(storage, importance):
    """Write one episodic record matching the keyword 'payment' and return its id."""
    episode = {
        "id": "ep-boost-persist",
        "timestamp": "2026-06-15T00:00:00+00:00",
        "context": {"goal": "implement payment checkout", "phase": "implementation"},
        "importance": importance,
        "access_count": 0,
    }
    return storage.save_episode(episode)


def _stored_importance(storage, episode_id):
    """Read the persisted record straight off disk and return its importance."""
    data = storage.load_episode(episode_id)
    assert data is not None, "episode should still exist on disk"
    return data.get("importance")


def test_retrieval_boost_is_persisted_to_disk():
    """Repeated retrieval must reinforce the stored importance on disk.

    Non-vacuity: with a real MemoryStorage on a tmp dir, we seed one episodic
    record at importance 0.5, run retrieve_task_aware (which calls
    storage.boost_on_retrieval AND storage.persist_boost on it), then RE-READ
    the record from disk. If the boost persisted, the stored importance is
    strictly greater than the seeded 0.5.

    PRE-FIX this assertion FAILED: storage.boost_on_retrieval mutated a
    throwaway in-memory dict and never wrote to disk, so the re-read importance
    stayed 0.5 (this file was @pytest.mark.xfail(strict=True) until the
    persist_boost read-mutate-write landed in memory/storage.py). It now XPASSes
    as a normal assertion.
    """
    with tempfile.TemporaryDirectory(prefix="loki-test-boost-") as base:
        storage = MemoryStorage(base_path=base)
        episode_id = _seed_episode(storage, importance=0.5)

        before = _stored_importance(storage, episode_id)
        assert before == 0.5, "test setup: seeded importance should be 0.5"

        retriever = MemoryRetrieval(storage=storage, base_path=base)
        results = retriever.retrieve_task_aware(
            {"goal": "payment", "task_type": "implementation"},
            top_k=5,
            persist_boost=True,
        )
        assert any(r.get("id") == episode_id for r in results), (
            "test setup: the seeded episode must be among the retrieved results "
            "so that boost_on_retrieval is invoked on it"
        )

        after = _stored_importance(storage, episode_id)
        assert after > before, (
            "retrieval-time boost must persist: stored importance should rise "
            "above the seeded %r after retrieval, but disk still shows %r "
            "(boost was applied to a throwaway dict and/or never written)"
            % (before, after)
        )


def test_persist_boost_does_not_clobber_concurrent_content_edit():
    """A boost must apply only the importance/access delta, never blind-write.

    Race-safety intent (the WAVE6 lost-update class): persist_boost holds one
    exclusive lock spanning a FRESH read -> apply only the boost delta to the
    just-read record -> atomic write. So a content edit another writer landed
    between retrieval and persistence survives.

    Deterministic interleave (no threads): seed the record with a content
    field, build the STALE in-memory dict a retriever would hold (id +
    _source=episodic + the old importance), then externally mutate the on-disk
    record (change the content field) to simulate the concurrent writer, THEN
    call persist_boost with the stale dict. Assert the importance rose AND the
    concurrent content edit survived.

    Non-vacuity: a blind write of the passed-in dict (the naive fix) would
    write back the stale snapshot and DROP the concurrent content edit, failing
    the content-survival assertion below.
    """
    with tempfile.TemporaryDirectory(prefix="loki-test-boost-race-") as base:
        storage = MemoryStorage(base_path=base)
        episode_id = "ep-boost-race"
        storage.save_episode({
            "id": episode_id,
            "timestamp": "2026-06-15T00:00:00+00:00",
            "context": {"goal": "implement payment checkout"},
            "content": "original-content",
            "importance": 0.5,
            "access_count": 0,
        })

        # Stale in-memory dict a retriever holds (carries old importance and a
        # source marker; deliberately lacks the concurrent edit).
        stale = {
            "id": episode_id,
            "_source": "episodic",
            "importance": 0.5,
            "access_count": 0,
        }

        # Concurrent writer lands a content edit on disk AFTER retrieval read.
        on_disk = storage.load_episode(episode_id)
        on_disk["content"] = "edited-by-concurrent-writer"
        storage.save_episode(on_disk)

        # Persist the boost using the stale dict.
        persisted = storage.persist_boost(stale, boost=0.1)
        assert persisted is True, "persist_boost should find and write the record"

        after = storage.load_episode(episode_id)
        assert after["importance"] > 0.5, (
            "boost delta must be applied to the freshly-read record"
        )
        assert after["content"] == "edited-by-concurrent-writer", (
            "concurrent content edit must survive: persist_boost must apply "
            "only the importance/access delta to the fresh on-disk record, not "
            "blind-write the stale passed-in dict"
        )
        assert after["access_count"] == 1, (
            "access_count must increment on the freshly-read record"
        )


def test_default_retrieval_does_not_persist_boost():
    """The default retrieve_task_aware (persist_boost=False) must NOT write to
    disk -- manual/on-demand surfaces (loki memory CLI, dashboard, MCP) should
    not silently reinforce importance. Only the autonomous RARV loop opts in.

    Non-vacuity: with persist_boost=True the sibling test above proves the disk
    importance rises; here, omitting the flag must leave the stored importance
    unchanged.
    """
    with tempfile.TemporaryDirectory(prefix="loki-test-boost-default-") as base:
        storage = MemoryStorage(base_path=base)
        episode_id = _seed_episode(storage, importance=0.5)
        before = _stored_importance(storage, episode_id)
        assert before == 0.5, "test setup: seeded importance should be 0.5"

        retriever = MemoryRetrieval(storage=storage, base_path=base)
        results = retriever.retrieve_task_aware(
            {"goal": "payment", "task_type": "implementation"},
            top_k=5,
        )
        assert any(r.get("id") == episode_id for r in results), (
            "test setup: the seeded episode must be among the retrieved results"
        )

        after = _stored_importance(storage, episode_id)
        assert after == before, (
            "default retrieval (persist_boost=False) must NOT persist the boost: "
            "stored importance should stay %r but disk shows %r" % (before, after)
        )


def _run_standalone():
    """Print the observed before/after stored importance without pytest.

    Returns 0 if the bug is FIXED (importance rose on disk), 1 if the bug
    REPRODUCES (importance unchanged). This makes the red state human-visible.
    """
    with tempfile.TemporaryDirectory(prefix="loki-test-boost-") as base:
        storage = MemoryStorage(base_path=base)
        episode_id = _seed_episode(storage, importance=0.5)
        before = _stored_importance(storage, episode_id)

        retriever = MemoryRetrieval(storage=storage, base_path=base)
        results = retriever.retrieve_task_aware(
            {"goal": "payment", "task_type": "implementation"},
            top_k=5,
            persist_boost=True,
        )
        retrieved = any(r.get("id") == episode_id for r in results)
        after = _stored_importance(storage, episode_id)

        print("retrieved seeded episode: %s" % retrieved)
        print("stored importance before retrieval: %r" % before)
        print("stored importance after  retrieval: %r" % after)
        if after > before:
            print("RESULT: FIXED -- boost persisted to disk")
            return 0
        print("RESULT: BUG REPRODUCES -- boost not persisted (retrieval-F1)")
        return 1


if __name__ == "__main__":
    sys.exit(_run_standalone())
