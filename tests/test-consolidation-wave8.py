"""Wave-8 regression tests for memory/consolidation.py.

Covers two findings:

C2 (MEDIUM, null-field crashes): an explicit JSON null goal/tool reaches the
consolidation helpers as None (EpisodeTrace.from_dict uses .get(key, default),
which returns None on an explicit null, not the default). Several str ops and
joins crashed on None. These tests prove the helpers and the full consolidate()
run survive None goals and None tools.

C1 (HIGH, lost-update): consolidate() snapshots all patterns once, then performs
merge writes. A concurrent usage bump landing after the snapshot was clobbered
because merge_with_existing() built the merged record from the stale snapshot's
usage_count/last_used. The fix performs the merge inside
storage.update_pattern_with_merge -- an atomic read-merge-write under a single
lock on patterns.json -- so the merge callback always sees the live on-disk
record. This test forces the merge branch and asserts the merged result reflects
the fresh in-lock read, not the snapshot value.

Run:
    cd /Users/lokesh/git/loki-mode && python3.12 -m pytest tests/test-consolidation-wave8.py -q
"""

import os
import sys
import tempfile
from datetime import datetime, timezone

import pytest

# Make the repo root importable so `import memory.*` works regardless of cwd.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory.consolidation import (  # noqa: E402
    ConsolidationPipeline,
    compress_episode_to_summary,
    compress_episodes_to_pattern_desc,
)
from memory.schemas import (  # noqa: E402
    ActionEntry,
    EpisodeTrace,
    SemanticPattern,
)
from memory.storage import MemoryStorage  # noqa: E402


def _episode(ep_id, goal, tools, outcome="success"):
    """Build an EpisodeTrace with the given goal and tool list.

    goal may be None (simulating an explicit-null goal). Each entry in `tools`
    may be None (simulating an explicit-null tool key).
    """
    return EpisodeTrace(
        id=ep_id,
        task_id="t-1",
        timestamp=datetime.now(timezone.utc),
        duration_seconds=1,
        agent="dev",
        phase="ACT",
        goal=goal,
        action_log=[ActionEntry(tool=t, input="x", output="y", timestamp=0) for t in tools],
        outcome=outcome,
    )


# ---------------------------------------------------------------------------
# C2: null goal / null tool must not crash
# ---------------------------------------------------------------------------


def _pipeline(tmp_path):
    storage = MemoryStorage(base_path=tmp_path)
    # embedding_engine=None forces the text/task-type fallback path, exercising
    # _generate_cluster_label / _infer_task_type / extract_common_pattern.
    return ConsolidationPipeline(storage=storage, embedding_engine=None, base_path=tmp_path)


def test_c2_episode_to_text_null_goal(tmp_path):
    """_episode_to_text joins parts; a None goal crashed the join pre-fix."""
    pipe = _pipeline(str(tmp_path))
    ep = _episode("ep-1", None, ["Read", None, "Edit"])
    # Pre-fix: TypeError sequence item 0: expected str instance, NoneType found.
    text = pipe._episode_to_text(ep)
    assert isinstance(text, str)


def test_c2_generate_cluster_label_null_goal(tmp_path):
    """_generate_cluster_label calls episode.goal.lower(); None crashed pre-fix."""
    pipe = _pipeline(str(tmp_path))
    eps = [_episode("ep-1", None, ["Read"]), _episode("ep-2", None, ["Edit"])]
    label = pipe._generate_cluster_label(eps)
    assert isinstance(label, str)


def test_c2_extract_common_pattern_null_tool(tmp_path):
    """extract_common_pattern builds common_tools then joins; None tool crashed."""
    pipe = _pipeline(str(tmp_path))
    # Two episodes with a None tool and a None goal; cluster size >= 2.
    eps = [_episode("ep-1", None, [None, None]), _episode("ep-2", None, [None, None])]
    pattern = pipe.extract_common_pattern(eps)
    # Should not raise; returns a SemanticPattern (or None, but never crash).
    assert pattern is None or isinstance(pattern, SemanticPattern)


def test_c2_extract_anti_patterns_null_tool(tmp_path):
    """extract_anti_patterns feeds tools into _summarize_actions join."""
    from memory.schemas import ErrorEntry

    pipe = _pipeline(str(tmp_path))
    ep = EpisodeTrace(
        id="ep-f1",
        task_id="t-1",
        timestamp=datetime.now(timezone.utc),
        duration_seconds=1,
        agent="dev",
        phase="ACT",
        goal=None,
        action_log=[ActionEntry(tool=None, input="x", output="y", timestamp=0)],
        outcome="failure",
        errors_encountered=[ErrorEntry(error_type="TypeError", message="boom", resolution="")],
    )
    anti = pipe.extract_anti_patterns([ep])
    assert isinstance(anti, list)


def test_c2_compress_functions_null_goal():
    """Module-level compress_* slice/lower episode.goal; None crashed pre-fix."""
    ep = _episode("ep-1", None, ["Read"])
    assert isinstance(compress_episode_to_summary(ep), str)
    # Single-episode branch (f-string, no slice).
    assert isinstance(compress_episodes_to_pattern_desc([ep]), str)
    # Multi-episode branch hits both .lower() and the [:100] fallback slice.
    eps = [_episode("ep-1", None, ["Read"]), _episode("ep-2", None, ["Edit"])]
    assert isinstance(compress_episodes_to_pattern_desc(eps), str)


def test_c2_full_consolidate_with_null_fields(tmp_path):
    """End-to-end: a stored episode with explicit-null goal and tool must not
    crash the whole consolidation run."""
    storage = MemoryStorage(base_path=str(tmp_path))
    # Persist two success episodes (same null goal) so they cluster together and
    # form a pattern, plus a failure episode for the anti-pattern path. We write
    # the raw dict with explicit JSON nulls to exercise from_dict's None return.
    for i in range(2):
        d = _episode(f"ep-s{i}", "build api", ["Read"]).to_dict()
        d["context"]["goal"] = None
        d["action_log"][0]["action"] = None  # explicit-null tool
        # Round-trip through from_dict so the stored episode carries the None
        # goal/tool exactly as a JSON-null load would produce.
        storage.save_episode(EpisodeTrace.from_dict(d))
    pipe = ConsolidationPipeline(storage=storage, embedding_engine=None, base_path=str(tmp_path))
    # Pre-fix this raised TypeError/AttributeError deep in the pipeline.
    result = pipe.consolidate(since_hours=24 * 365)
    assert result is not None


# ---------------------------------------------------------------------------
# C1: merge must re-read fresh state, not the stale snapshot
# ---------------------------------------------------------------------------


def test_c1_merge_reads_fresh_usage_count_atomically(tmp_path):
    """Force the cluster-merge branch and simulate a concurrent usage bump that
    lands on disk AFTER the step-4 snapshot but BEFORE the merge runs. The merged
    pattern must carry the bumped usage_count, because the merge now reads the
    live on-disk record inside storage.update_pattern_with_merge's single lock.

    Pre-fix: merge_with_existing built from the step-4 snapshot copy
    (usage_count=0), so the merged record clobbered the concurrent bump.
    Post-fix: the merge callback receives the FRESH on-disk dict (usage_count=42),
    so the bump is preserved -- an atomic read-merge-write, not a re-read in a
    separate lock.

    The test models the concurrency deterministically: the existing pattern is
    saved with usage_count=0 (the value the step-4 snapshot captures), then the
    on-disk record is bumped to 42 before consolidate() runs the merge. Since
    update_pattern_with_merge reads the current record at merge time, the merge
    builds on 42, not 0.
    """
    storage = MemoryStorage(base_path=str(tmp_path))

    # An existing on-disk pattern. The pipeline's step-4 snapshot will capture
    # this object (usage_count=0).
    existing = SemanticPattern.create(
        pattern="build api endpoints",
        category="implementation",
        conditions=["When building"],
        correct_approach="Use Edit",
    )
    existing.usage_count = 0
    storage.save_pattern(existing)

    # Two success episodes that will cluster and produce a candidate pattern.
    for i in range(2):
        storage.save_episode(_episode(f"ep-s{i}", "build api endpoints", ["Edit", "Read"]))

    pipe = ConsolidationPipeline(storage=storage, embedding_engine=None, base_path=str(tmp_path))

    # Force the merge branch deterministically (avoids depending on the exact
    # similarity score clearing 0.8). Both gates must be forced: _patterns_similar
    # selects the existing pattern in the loop, and _pattern_similarity_score
    # (used inside merge_with_existing) must clear 0.5 or merge returns the new
    # pattern unchanged under its own id.
    pipe._patterns_similar = lambda a, b, threshold=0.8: True
    pipe._pattern_similarity_score = lambda a, b: 1.0

    # Model the concurrent bump: it lands on disk AFTER the in-memory step-4
    # snapshot (which still holds usage_count=0) but BEFORE the merge fires. We
    # do this by wrapping update_pattern_with_merge so that, the first time it is
    # invoked for the existing id, it bumps the on-disk record to 42 and THEN
    # delegates to the real atomic merge. Because the real method reads the
    # record fresh under its lock, the merge callback sees 42.
    real_merge = storage.update_pattern_with_merge
    persisted = {}

    def bumping_merge(pattern_id, merge_fn):
        if pattern_id == existing.id and "bumped" not in persisted:
            persisted["bumped"] = True
            on_disk = storage.load_pattern(pattern_id)
            on_disk = SemanticPattern.from_dict(on_disk)
            on_disk.usage_count = 42
            storage.update_pattern(on_disk)

        def capturing(current):
            merged = merge_fn(current)
            if pattern_id == existing.id:
                persisted["pattern"] = merged
            return merged

        return real_merge(pattern_id, capturing)

    storage.update_pattern_with_merge = bumping_merge

    pipe.consolidate(since_hours=24 * 365)

    assert "pattern" in persisted, "merge branch did not fire; test would be vacuous"
    merged = persisted["pattern"]
    assert merged.id == existing.id
    # The crux: merged usage_count reflects the fresh on-disk read (42), not the
    # stale step-4 snapshot (0). This is the atomic lost-update guard.
    assert merged.usage_count == 42, (
        f"expected merged usage_count=42 from the fresh in-lock read, got "
        f"{merged.usage_count} (merge built from stale snapshot -> C1 lost-update)"
    )
    # And the persisted on-disk record carries it too.
    final = storage.load_pattern(existing.id)
    assert final["usage_count"] == 42


# ---------------------------------------------------------------------------
# C4: re-running consolidate() over an unchanged episode set must be a no-op
# for pattern confidence (idempotency). Pre-fix, merge_with_existing applied a
# flat +0.05 boost on every run because consolidate() reloads every in-window
# episode each run (storage.list_episodes has no consolidated-state filter), so
# identical patterns re-matched and confidence ratcheted up with no new data.
# ---------------------------------------------------------------------------


def _confidence_of_only_pattern(storage):
    """Return the confidence of the single semantic (non-anti) pattern on disk.

    The fixtures below produce exactly one created pattern, so this both fetches
    the value under test and asserts the store shape is what the test assumes.
    """
    pattern_ids = storage.list_patterns()
    patterns = [
        SemanticPattern.from_dict(storage.load_pattern(pid))
        for pid in pattern_ids
    ]
    # Ignore anti-patterns; the success episodes produce one positive pattern.
    positive = [p for p in patterns if not p.incorrect_approach]
    assert len(positive) == 1, (
        f"expected exactly one positive pattern, found {len(positive)}"
    )
    return positive[0].confidence


def test_c4_rerun_does_not_inflate_confidence(tmp_path):
    """Run consolidate() twice over the SAME episodes.

    Run 1 (clean store): creates a pattern -> patterns_created >= 1. Capture its
    confidence c1 (proves the test is non-vacuous: consolidation did real work).

    Run 2 (unchanged episodes): the same episodes re-cluster into the same
    pattern, which re-matches the now-existing pattern -> the merge branch fires
    (patterns_merged >= 1). Because no NEW source episode is present, confidence
    must stay exactly c1.

    Pre-fix: run 2 applied a flat +0.05 -> confidence == c1 + 0.05 -> FAILS.
    Post-fix: the source_episodes diff is empty -> no boost -> confidence == c1.
    """
    storage = MemoryStorage(base_path=str(tmp_path))
    for i in range(2):
        storage.save_episode(_episode(f"ep-s{i}", "build api endpoints", ["Edit", "Read"]))

    pipe = ConsolidationPipeline(storage=storage, embedding_engine=None, base_path=str(tmp_path))

    r1 = pipe.consolidate(since_hours=24 * 365)
    assert r1.patterns_created >= 1, "run 1 created no pattern; test would be vacuous"
    c1 = _confidence_of_only_pattern(storage)

    r2 = pipe.consolidate(since_hours=24 * 365)
    # The merge path MUST have executed; otherwise the assertion below would pass
    # trivially (nothing happened). This is the discriminating guard.
    assert r2.patterns_merged >= 1, "run 2 did not merge; test would be vacuous"
    c2 = _confidence_of_only_pattern(storage)

    assert c2 == pytest.approx(c1), (
        f"confidence inflated on re-run with no new episodes: {c1} -> {c2} "
        "(consolidation-C4 idempotency regression)"
    )


def test_c4_new_episode_still_boosts_confidence(tmp_path):
    """The idempotency fix must NOT suppress legitimate reinforcement.

    After an initial pattern exists, a genuinely NEW similar episode arriving in
    a later run introduces a new source_episodes id, so the merge SHOULD still
    boost confidence. This proves the fix gates on new evidence rather than
    blanket-disabling the boost.
    """
    storage = MemoryStorage(base_path=str(tmp_path))
    for i in range(2):
        storage.save_episode(_episode(f"ep-s{i}", "build api endpoints", ["Edit", "Read"]))

    pipe = ConsolidationPipeline(storage=storage, embedding_engine=None, base_path=str(tmp_path))

    pipe.consolidate(since_hours=24 * 365)
    c1 = _confidence_of_only_pattern(storage)

    # A new, similar success episode arrives. Its id is not in the pattern's
    # source_episodes, so the merge introduces new evidence and should boost.
    storage.save_episode(_episode("ep-s2", "build api endpoints", ["Edit", "Read"]))
    r2 = pipe.consolidate(since_hours=24 * 365)
    assert r2.patterns_merged >= 1, "run 2 did not merge; test would be vacuous"
    c2 = _confidence_of_only_pattern(storage)

    assert c2 > c1, (
        f"a new similar episode should reinforce confidence, but {c1} -> {c2} "
        "(fix wrongly suppressed legitimate reinforcement)"
    )


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
