#!/usr/bin/env python3
"""
Regression test for B10a: memory consolidation merge data-loss.

Bug: in ConsolidationPipeline._consolidate_locked the merge loop iterates over
an in-memory `existing_patterns` list. When two new patterns produced in the
SAME consolidation run both merge into the SAME existing pattern, the second
merge used to read the STALE pre-merge copy of the existing pattern (the loop
never refreshed the in-memory object after the first merge). Because
storage.update_pattern() fully overwrites the stored entry, the second merge's
update silently dropped the first merge's contributions (conditions,
source_episodes, confidence bump).

Fix: refresh existing_patterns[idx] with the merged pattern after each merge so
later merges in the same run build on the just-merged state.

This test drives the REAL _consolidate_locked merge loop through a subclass that
substitutes only the clustering and pattern-extraction inputs, backed by a fake
in-memory storage. It asserts that contributions from BOTH new patterns survive.

Non-vacuity argument:
- The test fails on the pre-fix code. Pre-fix, the second merge (N2) is computed
  from the stale base E and its update_pattern() overwrites storage, so the
  final stored pattern contains only N2's condition/episode, NOT N1's. The
  asserts on "cond-from-N1" and "ep-from-N1" being present would then fail.
- The test passes only because the fix refreshes the in-memory copy between the
  two merges, so the second merge accumulates onto the first.
- The test is not trivially true: both new patterns are deliberately similar to
  the same existing pattern (shared description + category) so both take the
  merge branch (not the create branch), and each carries a UNIQUE condition and
  UNIQUE source episode whose survival is independently asserted.
"""

import os
import sys

# Make the repo root importable so `import memory.*` resolves.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory.consolidation import ConsolidationPipeline, Cluster
from memory.schemas import SemanticPattern


class FakeStorage:
    """Minimal in-memory MemoryStorage stand-in for the merge loop."""

    def __init__(self, existing):
        # patterns keyed by id; store SemanticPattern objects
        self.patterns = {p.id: p for p in existing}

    # --- episode side: we drive clusters directly, so report none here ---
    def list_episodes(self, since=None, limit=1000):
        return []

    def load_episode(self, episode_id):
        return None

    # --- pattern side ---
    def list_patterns(self):
        return list(self.patterns.keys())

    def load_pattern(self, pattern_id):
        # Return the object form (the pipeline accepts dict or object).
        return self.patterns.get(pattern_id)

    def save_pattern(self, pattern):
        self.patterns[pattern.id] = pattern
        return pattern.id

    def update_pattern(self, pattern):
        # Mirror real storage semantics: full overwrite of the entry by id.
        if pattern.id not in self.patterns:
            return False
        self.patterns[pattern.id] = pattern
        return True


class FakeEpisode:
    """Marker episode; only its presence in a cluster matters for this test."""

    def __init__(self, ep_id):
        self.id = ep_id
        self.outcome = "success"


class MergeDrivingPipeline(ConsolidationPipeline):
    """
    Subclass that substitutes ONLY the inputs to the real merge loop:
    - episodes are taken straight from a preset list (bypass storage loading)
    - clustering returns two preset clusters
    - extract_common_pattern returns a preset new pattern per cluster
    All merge/save logic under test runs unmodified.
    """

    def __init__(self, storage, clusters, new_patterns):
        super().__init__(storage=storage, embedding_engine=None, base_path=None)
        self._clusters = clusters
        self._new_patterns = list(new_patterns)
        self._call = 0

    def consolidate(self, since_hours=24):
        # Bypass the file lock (base_path=None) and call the locked body directly.
        return self._consolidate_locked(since_hours)

    # _consolidate_locked starts by loading episodes from storage; FakeStorage
    # returns none, which short-circuits. So we override the locked body's early
    # data sources by feeding episodes through the clustering hooks instead.
    def cluster_by_task_type(self, episodes):
        # Not used directly because we override _clusters_from_task_type below,
        # but keep a sane return for safety.
        return {}

    def _clusters_from_task_type(self, _grouped):
        return self._clusters

    def extract_common_pattern(self, episodes):
        pat = self._new_patterns[self._call]
        self._call += 1
        return pat

    def extract_anti_patterns(self, failed_episodes):
        return []

    def create_zettelkasten_links(self, pattern, all_patterns):
        return []


def _patch_episode_loading(pipeline, episodes):
    """
    _consolidate_locked returns early when storage yields no episodes. Drive it
    by patching the two episode-loading calls to return our fake episodes so the
    clustering/extraction path (and therefore the merge loop) executes.
    """
    pipeline.storage.list_episodes = lambda since=None, limit=1000: [e.id for e in episodes]
    by_id = {e.id: e for e in episodes}
    pipeline.storage.load_episode = lambda eid: by_id.get(eid)


def main():
    # Pre-existing pattern E that both new patterns will merge into.
    existing = SemanticPattern(
        id="sem-E",
        pattern="retry network calls with backoff",
        category="error-handling",
        conditions=["When a request times out"],
        correct_approach="exponential backoff",
        confidence=0.80,
        source_episodes=["ep-existing"],
        importance=0.9,
        access_count=7,
    )

    storage = FakeStorage([existing])

    # Two episodes, one per cluster.
    ep1 = FakeEpisode("ep-N1")
    ep2 = FakeEpisode("ep-N2")
    clusters = [Cluster(episodes=[ep1, ep1]), Cluster(episodes=[ep2, ep2])]

    # Two NEW patterns, both similar to E (same description + category so the
    # similarity score clears the merge threshold), each with a UNIQUE condition
    # and UNIQUE source episode whose survival we assert independently.
    new1 = SemanticPattern(
        id="sem-N1",
        pattern="retry network calls with backoff",
        category="error-handling",
        conditions=["cond-from-N1"],
        source_episodes=["ep-from-N1"],
        confidence=0.80,
    )
    new2 = SemanticPattern(
        id="sem-N2",
        pattern="retry network calls with backoff",
        category="error-handling",
        conditions=["cond-from-N2"],
        source_episodes=["ep-from-N2"],
        confidence=0.80,
    )

    pipeline = MergeDrivingPipeline(storage, clusters, [new1, new2])
    _patch_episode_loading(pipeline, [ep1, ep2])

    result = pipeline.consolidate(since_hours=24)

    # Both new patterns must have merged into the single existing pattern.
    assert result.patterns_merged == 2, (
        f"expected 2 merges into the existing pattern, got {result.patterns_merged}; "
        "both new patterns should match the existing pattern's merge branch"
    )
    assert "sem-E" in storage.patterns, "existing pattern id must remain the merge target"
    assert len(storage.patterns) == 1, (
        f"expected a single consolidated pattern, got {len(storage.patterns)}: "
        f"{list(storage.patterns)}"
    )

    final = storage.patterns["sem-E"]
    conds = set(final.conditions)
    eps = set(final.source_episodes)

    # Core data-loss assertions: N1's UNIQUE contributions must NOT be dropped by
    # N2's merge. Pre-fix these fail because N2 overwrote storage from a stale base.
    assert "cond-from-N1" in conds, (
        f"DATA LOSS: N1's condition was dropped during the second merge. "
        f"final conditions={sorted(conds)}"
    )
    assert "cond-from-N2" in conds, f"N2's condition missing. final conditions={sorted(conds)}"
    assert "ep-from-N1" in eps, (
        f"DATA LOSS: N1's source episode was dropped during the second merge. "
        f"final source_episodes={sorted(eps)}"
    )
    assert "ep-from-N2" in eps, f"N2's source episode missing. final source_episodes={sorted(eps)}"

    # The original existing data must also be preserved across both merges.
    assert "When a request times out" in conds, "original existing condition dropped"
    assert "ep-existing" in eps, "original existing source episode dropped"

    # Confidence should reflect BOTH merges (two +0.05 bumps from 0.80), not just one.
    assert final.confidence >= 0.80 + 0.05 + 0.05 - 1e-9, (
        f"confidence did not accumulate across both merges: {final.confidence}"
    )

    # Retrieval/decay-relevant fields preserved (guards the existing merge fix too).
    assert final.importance == 0.9, f"importance reset: {final.importance}"
    assert final.access_count == 7, f"access_count reset: {final.access_count}"

    print("PASS: consolidation merge preserves all entries across same-run merges")
    print(f"  merges={result.patterns_merged} conditions={sorted(conds)}")
    print(f"  source_episodes={sorted(eps)} confidence={final.confidence:.2f}")


if __name__ == "__main__":
    main()
