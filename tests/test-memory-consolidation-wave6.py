#!/usr/bin/env python3
"""
Wave-6 regression tests for memory/consolidation.py.

Covers two findings in ConsolidationPipeline._consolidate_locked:

M1 (dedup asymmetry -> duplicate patterns within one run):
  In the cluster-extraction step the create branch saved a new cluster pattern
  but did NOT append it to the in-memory `existing_patterns` list used for
  similarity dedup (the anti-pattern step DID append). So if two clusters in
  one run produced >=0.8-similar patterns, the second was never deduped against
  the first, yielding two near-duplicate patterns. Fix: append the saved
  cluster pattern to existing_patterns, mirroring the anti-pattern step.

L1 (dropped links + inflated stat):
  In the Zettelkasten-link step, links were attempted for ALL anti_patterns,
  including MERGED ones. A merged anti-pattern is persisted under the existing
  pattern's id (via update_pattern(merged_pattern)); its own fresh uuid was
  never saved. So update_pattern(anti_pattern) returned False and the links
  were dropped, yet links_created was incremented regardless, inflating it.
  Fix: only link patterns persisted under their own id this run, and only count
  links when update_pattern() actually returned True.

Both tests drive the REAL _consolidate_locked body via a thin subclass that
substitutes only clustering / extraction inputs, backed by a fake in-memory
storage that mirrors real save/update semantics (update_pattern returns False
for an unknown id). Each test is non-vacuous: it fails on the pre-fix code.
"""

import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory.consolidation import ConsolidationPipeline, Cluster
from memory.schemas import SemanticPattern


class FakeStorage:
    """In-memory MemoryStorage stand-in mirroring real save/update semantics."""

    def __init__(self, existing):
        self.patterns = {p.id: p for p in existing}
        # Record every (id, n_links) pair update_pattern was asked to persist,
        # plus whether it succeeded, so tests can audit the link path.
        self.update_calls = []

    def list_episodes(self, since=None, limit=1000):
        return []

    def load_episode(self, episode_id):
        return None

    def list_patterns(self):
        return list(self.patterns.keys())

    def load_pattern(self, pattern_id):
        return self.patterns.get(pattern_id)

    def save_pattern(self, pattern):
        self.patterns[pattern.id] = pattern
        return pattern.id

    def update_pattern(self, pattern):
        # Real semantics: a never-saved id is not found and returns False.
        ok = pattern.id in self.patterns
        self.update_calls.append((pattern.id, len(pattern.links), ok))
        if ok:
            self.patterns[pattern.id] = pattern
        return ok

    def update_pattern_with_merge(self, pattern_id, merge_fn):
        # Mirror real storage: read the current record fresh, run the caller's
        # merge under the (here implicit) lock, write the result. Returns False
        # for a missing id (caller falls back to create); the merge callback
        # receives the current record as a dict, as the real backend does.
        if pattern_id not in self.patterns:
            return False
        current = self.patterns[pattern_id]
        current_dict = current.to_dict() if hasattr(current, "to_dict") else dict(current)
        merged = merge_fn(current_dict)
        if not hasattr(merged, "id"):
            merged = SemanticPattern.from_dict(merged)
        merged.id = pattern_id
        self.patterns[pattern_id] = merged
        return True


class FakeEpisode:
    def __init__(self, ep_id):
        self.id = ep_id
        self.outcome = "success"


class DrivingPipeline(ConsolidationPipeline):
    """Substitutes ONLY the inputs to the real merge/link loops."""

    def __init__(self, storage, clusters=None, new_patterns=None,
                 anti_patterns=None, links_for=None):
        super().__init__(storage=storage, embedding_engine=None, base_path=None)
        self._clusters = clusters or []
        self._new_patterns = list(new_patterns or [])
        self._anti_patterns = list(anti_patterns or [])
        # links_for: callable(pattern) -> list[Link] to inject per pattern.
        self._links_for = links_for or (lambda pattern, all_patterns: [])
        self._call = 0

    def consolidate(self, since_hours=24):
        return self._consolidate_locked(since_hours)

    def cluster_by_task_type(self, episodes):
        return {}

    def _clusters_from_task_type(self, _grouped):
        return self._clusters

    def extract_common_pattern(self, episodes):
        pat = self._new_patterns[self._call]
        self._call += 1
        return pat

    def extract_anti_patterns(self, failed_episodes):
        return list(self._anti_patterns)

    def create_zettelkasten_links(self, pattern, all_patterns):
        return self._links_for(pattern, all_patterns)


def _patch_episode_loading(pipeline, episodes):
    pipeline.storage.list_episodes = lambda since=None, limit=1000: [e.id for e in episodes]
    by_id = {e.id: e for e in episodes}
    pipeline.storage.load_episode = lambda eid: by_id.get(eid)


def test_m1_two_similar_clusters_dedup_into_one_pattern():
    """M1: two clusters that extract >=0.8-similar patterns must not produce
    two near-duplicate patterns. The second must dedupe against the first."""
    # No pre-existing patterns: both new cluster patterns take the create branch
    # on the FIRST cluster; the SECOND must merge into the first post-fix.
    storage = FakeStorage([])

    ep1 = FakeEpisode("ep-c1")
    ep2 = FakeEpisode("ep-c2")
    clusters = [Cluster(episodes=[ep1, ep1]), Cluster(episodes=[ep2, ep2])]

    # Two cluster patterns, identical description + category + conditions so the
    # pair-similarity score is 1.0 (>= 0.8 threshold). Distinct ids/episodes.
    p1 = SemanticPattern(
        id="sem-c1",
        pattern="validate inputs before persisting",
        category="validation",
        conditions=["before write"],
        source_episodes=["ep-c1"],
        confidence=0.70,
    )
    p2 = SemanticPattern(
        id="sem-c2",
        pattern="validate inputs before persisting",
        category="validation",
        conditions=["before write"],
        source_episodes=["ep-c2"],
        confidence=0.70,
    )

    pipeline = DrivingPipeline(storage, clusters=clusters, new_patterns=[p1, p2])
    _patch_episode_loading(pipeline, [ep1, ep2])

    result = pipeline.consolidate(since_hours=24)

    # Pre-fix: both create -> patterns_created == 2, two near-dup patterns stored.
    # Post-fix: first created, second merged -> created == 1, merged == 1, one stored.
    assert result.patterns_created == 1, (
        f"expected 1 created pattern, got {result.patterns_created}: the second "
        "similar cluster pattern was not deduped against the first (M1 dedup asymmetry)"
    )
    assert result.patterns_merged == 1, (
        f"expected the second cluster pattern to MERGE, got merged={result.patterns_merged}"
    )
    assert len(storage.patterns) == 1, (
        f"expected a single consolidated pattern, got {len(storage.patterns)}: "
        f"{list(storage.patterns)}"
    )

    # The surviving pattern must carry BOTH source episodes (proof of a real merge).
    final = next(iter(storage.patterns.values()))
    assert set(final.source_episodes) >= {"ep-c1", "ep-c2"}, (
        f"merged pattern lost a source episode: {sorted(final.source_episodes)}"
    )


def test_l1_links_counted_only_for_persisted_patterns():
    """L1: links_created must count only links that actually persisted. A merged
    anti-pattern is stored under the existing id, not its own fresh id, so
    linking against its own id fails and must not inflate the stat."""
    # Pre-existing anti-pattern that the incoming anti-pattern will merge into.
    existing_anti = SemanticPattern(
        id="sem-existing-anti",
        pattern="Avoid: TimeoutError",
        category="anti-pattern",
        conditions=["When encountering: TimeoutError"],
        incorrect_approach="retry without backoff",
        confidence=0.60,
        source_episodes=["ep-old"],
    )
    storage = FakeStorage([existing_anti])

    # Incoming anti-pattern with a FRESH uuid, similar enough to merge (>=0.6).
    incoming_anti = SemanticPattern.create(
        pattern="Avoid: TimeoutError",
        category="anti-pattern",
        conditions=["When encountering: TimeoutError"],
        incorrect_approach="retry without backoff",
    )
    incoming_anti.source_episodes = ["ep-new"]

    fresh_uuid = incoming_anti.id

    # Inject one link for whatever pattern step 7 tries to link. If step 7
    # (incorrectly) links the merged anti-pattern under its fresh uuid, the
    # update fails but the buggy code still counts the link.
    from memory.schemas import Link

    def links_for(pattern, all_patterns):
        return [Link(to_id="sem-some-target", relation="related_to", strength=0.5)]

    pipeline = DrivingPipeline(
        storage,
        clusters=[],
        new_patterns=[],
        anti_patterns=[incoming_anti],
        links_for=links_for,
    )
    # At least one episode is required so _consolidate_locked does not early-return
    # before step 6. extract_anti_patterns is overridden, so the episode's content
    # is irrelevant; only its presence matters.
    _patch_episode_loading(pipeline, [FakeEpisode("ep-drive")])

    result = pipeline.consolidate(since_hours=24)

    # The incoming anti-pattern merged, so it was never saved under fresh_uuid.
    assert result.patterns_merged == 1, (
        f"setup invariant: incoming anti-pattern should merge, got "
        f"merged={result.patterns_merged} anti_created={result.anti_patterns_created}"
    )
    assert fresh_uuid not in storage.patterns, (
        "setup invariant: merged anti-pattern must not be persisted under its fresh uuid"
    )

    # Pre-fix: step 7 attempts to link the merged anti-pattern under fresh_uuid,
    # update_pattern returns False (link dropped) but links_created += 1 anyway.
    # Post-fix: merged anti-patterns are excluded from step 7, so no link attempt
    # is made and links_created stays 0.
    assert result.links_created == 0, (
        f"links_created inflated to {result.links_created}: a link was counted for a "
        "pattern that was never persisted under its own id (L1 inflated stat)"
    )

    # And no failed update_pattern call should have been counted as a link.
    failed_link_updates = [
        c for c in storage.update_calls if c[1] > 0 and not c[2]
    ]
    assert not failed_link_updates, (
        f"a link update targeted a non-persisted id (links dropped): {failed_link_updates}"
    )


def test_l1_real_link_on_persisted_pattern_is_counted():
    """Complementary guard: a link on a genuinely persisted (created) pattern
    is still counted, so the L1 fix does not under-count real links."""
    storage = FakeStorage([])

    ep1 = FakeEpisode("ep-x")
    clusters = [Cluster(episodes=[ep1, ep1])]
    created = SemanticPattern(
        id="sem-created",
        pattern="cache expensive lookups",
        category="performance",
        conditions=["hot path"],
        source_episodes=["ep-x"],
        confidence=0.70,
    )

    from memory.schemas import Link

    def links_for(pattern, all_patterns):
        if pattern.id == "sem-created":
            return [Link(to_id="sem-other", relation="related_to", strength=0.5)]
        return []

    pipeline = DrivingPipeline(
        storage, clusters=clusters, new_patterns=[created], links_for=links_for
    )
    _patch_episode_loading(pipeline, [ep1])

    result = pipeline.consolidate(since_hours=24)

    assert result.patterns_created == 1, "setup: pattern should be created and persisted"
    assert result.links_created == 1, (
        f"a real link on a persisted pattern must be counted, got {result.links_created}"
    )


if __name__ == "__main__":
    test_m1_two_similar_clusters_dedup_into_one_pattern()
    test_l1_links_counted_only_for_persisted_patterns()
    test_l1_real_link_on_persisted_pattern_is_counted()
    print("PASS: wave-6 consolidation M1 + L1 regression tests")
