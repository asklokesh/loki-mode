#!/usr/bin/env python3
"""
Regression tests for the index/timeline layer dead `_cache` field and the
non-idempotent relevance boost in find_relevant_topics (WT9).

Each test drives the REAL IndexLayer / TimelineLayer objects against a
throwaway tempdir. The non-vacuity note on each assertion states exactly
what the pre-fix code did (the observable defect the assertion rules out),
so a passing run is meaningful rather than trivially green.

Decision recorded: the dead `_cache` field was REMOVED (option b), not
turned into a real cache. index.json / timeline.json are tiny and are
written by a separate process (dashboard server.py reads them while the
orchestrator writes them), so an in-memory cache invalidated only on
same-instance _save() would serve stale memory across processes. An honest
fresh read every call beats a fake cache for retrieval accuracy.

Run directly:  python3 tests/test-index-layer-cache.py
"""

import json
import sys
import tempfile
from pathlib import Path

# Make the repo root importable so `import memory.*` resolves regardless of cwd.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from memory.layers.index_layer import IndexLayer, Topic  # noqa: E402
from memory.layers.timeline_layer import TimelineLayer  # noqa: E402


def test_index_dead_cache_field_removed():
    """The dead `_cache` attribute must not exist on a fresh IndexLayer.

    Non-vacuity: pre-fix, __init__ set `self._cache = None` and load() wrote
    `self._cache = json.load(f)` that no other method ever consulted before a
    disk read. This asserts the dead field is gone (option-b removal), not
    silently reintroduced as a fake cache.
    """
    with tempfile.TemporaryDirectory() as d:
        layer = IndexLayer(base_path=d)
        assert not hasattr(layer, "_cache"), (
            "IndexLayer still carries the dead _cache field"
        )


def test_timeline_dead_cache_field_removed():
    """The dead `_cache` attribute must not exist on a fresh TimelineLayer.

    Non-vacuity: pre-fix TimelineLayer had the identical dead-cache pattern
    (set in load()/_save, never read). This asserts it is gone too.
    """
    with tempfile.TemporaryDirectory() as d:
        layer = TimelineLayer(base_path=d)
        assert not hasattr(layer, "_cache"), (
            "TimelineLayer still carries the dead _cache field"
        )


def test_index_load_reflects_external_write():
    """load() must re-read from disk so a write by another process is seen.

    Non-vacuity: a same-instance in-memory cache would return the first
    snapshot forever; an external writer (the dashboard or a second
    IndexLayer) would be invisible. This writes index.json out-of-band
    between two load() calls and asserts the second load sees the new value.
    """
    with tempfile.TemporaryDirectory() as d:
        layer = IndexLayer(base_path=d)
        # First read: empty index (file does not exist yet).
        first = layer.load()
        assert first.get("total_memories", 0) == 0

        # Out-of-band write, as a different process / instance would do.
        index_path = Path(d) / "index.json"
        index_path.write_text(json.dumps({
            "version": "1.0",
            "topics": [{"id": "x", "summary": "alpha beta",
                        "relevance_score": 0.9, "token_count": 10}],
            "total_memories": 1,
            "total_tokens_available": 10,
        }))

        second = layer.load()
        assert second.get("total_memories") == 1, (
            "load() served a stale cached snapshot after an external write"
        )


def test_timeline_load_reflects_external_write():
    """TimelineLayer.load() must re-read from disk after an external write.

    Non-vacuity: same staleness risk as the index layer; a cached snapshot
    would never reflect the dashboard or orchestrator appending an action.
    """
    with tempfile.TemporaryDirectory() as d:
        layer = TimelineLayer(base_path=d)
        assert len(layer.load().get("recent_actions", [])) == 0

        timeline_path = Path(d) / "timeline.json"
        timeline_path.write_text(json.dumps({
            "version": "1.0",
            "recent_actions": [{"action": "did x", "outcome": "ok"}],
            "key_decisions": [],
            "active_context": {"current_focus": "", "blocked_by": [], "next_up": []},
        }))

        second = layer.load()
        assert len(second.get("recent_actions", [])) == 1, (
            "TimelineLayer.load() served a stale cached snapshot"
        )


def test_load_reads_disk_each_call(monkeypatch):
    """Each load() performs a real disk read (no hidden cache short-circuit).

    Non-vacuity: if a cache were silently consulted, the second load() would
    skip open()/json.load entirely. We count open() calls on the index file
    across two no-write load() calls and assert BOTH hit disk. This is the
    direct counterpart of the 'assert called once' a real cache would need;
    here, honest no-cache means called-every-time.
    """
    with tempfile.TemporaryDirectory() as d:
        layer = IndexLayer(base_path=d)
        # Seed a real file so load() takes the open()/json.load path.
        (Path(d) / "index.json").write_text(json.dumps({
            "version": "1.0", "topics": [], "total_memories": 0,
            "total_tokens_available": 0,
        }))

        import builtins
        real_open = builtins.open
        calls = {"n": 0}

        def counting_open(file, *args, **kwargs):
            if str(file) == str(layer.index_path):
                calls["n"] += 1
            return real_open(file, *args, **kwargs)

        monkeypatch.setattr(builtins, "open", counting_open)

        layer.load()
        layer.load()
        assert calls["n"] == 2, (
            f"expected 2 disk reads (one per load), got {calls['n']} "
            "- a hidden cache short-circuited a read"
        )


def test_find_relevant_topics_does_not_mutate_stored_relevance():
    """Returned topics keep their STORED relevance_score; boost is separate.

    Non-vacuity: pre-fix, find_relevant_topics did
    `topic.relevance_score = min(1.0, relevance + boost)`, so a stored 0.6
    topic matching the query came back claiming relevance 0.9. Callers (and
    the loader's 0.8 Layer-3 gate) then read a boosted value as if it were
    stored. This asserts relevance_score equals the stored 0.6, while the
    transient match_score / effective_score carries the boost.
    """
    with tempfile.TemporaryDirectory() as d:
        layer = IndexLayer(base_path=d)
        layer.update([
            {"id": "match", "summary": "deploy kubernetes cluster",
             "relevance_score": 0.6, "token_count": 10},
            {"id": "weak", "summary": "billing invoice pdf",
             "relevance_score": 0.55, "token_count": 10},
        ])

        results = layer.find_relevant_topics("deploy kubernetes", threshold=0.5)
        by_id = {t.id: t for t in results}

        assert "match" in by_id, "keyword-matching topic was dropped"
        matched = by_id["match"]
        assert matched.relevance_score == 0.6, (
            f"stored relevance_score was mutated to {matched.relevance_score}; "
            "must stay the stored 0.6"
        )
        # The boost lives on the transient match_score, above the stored value.
        assert matched.match_score is not None and matched.match_score > 0.6, (
            "keyword boost was not recorded on the transient match_score"
        )
        assert matched.effective_score == matched.match_score, (
            "effective_score should expose the boosted match_score for ranking"
        )


def test_find_relevant_topics_ranks_strong_match_first():
    """Ranking still surfaces a strong keyword match ahead of a weak one.

    Non-vacuity: with the boost moved off relevance_score, a naive sort on
    stored relevance could rank a higher-stored-but-non-matching topic above
    the real query match. This asserts the sort uses effective_score so the
    matching topic leads, preserving the original ranking intent.
    """
    with tempfile.TemporaryDirectory() as d:
        layer = IndexLayer(base_path=d)
        layer.update([
            # Strong keyword match but lower stored relevance.
            {"id": "match", "summary": "deploy kubernetes cluster",
             "relevance_score": 0.6, "token_count": 10},
            # Higher stored relevance, zero keyword overlap with the query.
            {"id": "highstored", "summary": "quarterly finance report",
             "relevance_score": 0.75, "token_count": 10},
        ])

        results = layer.find_relevant_topics("deploy kubernetes", threshold=0.5)
        assert results, "no topics returned for a matching query"
        assert results[0].id == "match", (
            "strong keyword match did not rank first; "
            f"got order {[t.id for t in results]}"
        )
        # And the strong match's boosted effective score clears the loader's
        # Layer-3 high-relevance gate (0.8), so it remains pullable.
        assert results[0].effective_score >= 0.8, (
            f"boosted match effective_score {results[0].effective_score} "
            "should clear the 0.8 Layer-3 gate"
        )


def test_add_topic_visible_on_next_load():
    """add_topic persists and is visible on the next load (no stale cache).

    Non-vacuity: this is the write-invalidation counterpart. With a real
    cache it would need explicit invalidation; with the honest no-cache
    design every load() simply re-reads. Either way, an added topic must
    appear, never masked by a stale snapshot.
    """
    with tempfile.TemporaryDirectory() as d:
        layer = IndexLayer(base_path=d)
        layer.update([])  # establish an empty index file
        assert layer.get_token_count() > 0  # forces a load of the empty index

        layer.add_topic({"id": "new", "summary": "fresh topic",
                          "relevance_score": 0.7, "token_count": 5})

        ids = {t.id for t in layer.get_topics()}
        assert "new" in ids, (
            "added topic not visible on next load (stale cache masked the write)"
        )


def _run():
    # Minimal monkeypatch shim so the file runs without pytest.
    class _MP:
        def __init__(self):
            self._undo = []

        def setattr(self, obj, name, value):
            self._undo.append((obj, name, getattr(obj, name)))
            setattr(obj, name, value)

        def undo(self):
            for obj, name, old in reversed(self._undo):
                setattr(obj, name, old)
            self._undo.clear()

    tests = [
        ("test_index_dead_cache_field_removed", test_index_dead_cache_field_removed, False),
        ("test_timeline_dead_cache_field_removed", test_timeline_dead_cache_field_removed, False),
        ("test_index_load_reflects_external_write", test_index_load_reflects_external_write, False),
        ("test_timeline_load_reflects_external_write", test_timeline_load_reflects_external_write, False),
        ("test_load_reads_disk_each_call", test_load_reads_disk_each_call, True),
        ("test_find_relevant_topics_does_not_mutate_stored_relevance",
         test_find_relevant_topics_does_not_mutate_stored_relevance, False),
        ("test_find_relevant_topics_ranks_strong_match_first",
         test_find_relevant_topics_ranks_strong_match_first, False),
        ("test_add_topic_visible_on_next_load", test_add_topic_visible_on_next_load, False),
    ]
    failed = 0
    for name, fn, needs_mp in tests:
        try:
            if needs_mp:
                mp = _MP()
                try:
                    fn(mp)
                finally:
                    mp.undo()
            else:
                fn()
            print(f"PASS  {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {name}: {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"ERROR {name}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run())
