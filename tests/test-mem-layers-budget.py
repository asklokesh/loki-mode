#!/usr/bin/env python3
"""Regression tests for two memory bugs:

1. Double-Z ISO timestamps in cross_project.py / knowledge_graph.py
   (`datetime.now(timezone.utc).isoformat() + 'Z'` -> '...+00:00Z', which is
   invalid ISO 8601 and raises in datetime.fromisoformat / breaks max()).
2. Layer-2 (timeline) of the progressive loader was loaded and appended
   unconditionally, with no affordability check against the remaining token
   budget, so an oversized timeline could overspend max_tokens.

Run directly: python3 tests/test-mem-layers-budget.py
"""

import os
import sys
import json
import tempfile
from datetime import datetime

# Make the repo root importable so `import memory...` resolves.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory.cross_project import CrossProjectIndex
from memory.knowledge_graph import OrganizationKnowledgeGraph
from memory.layers.loader import ProgressiveLoader
from memory.layers.index_layer import Topic


def test_cross_project_timestamps_parse():
    """build_index() timestamps must be valid ISO 8601.

    Non-vacuity: datetime.fromisoformat() raises ValueError on the old
    '...+00:00Z' double-Z form, so this assertion FAILS against the pre-fix
    code and PASSES only once the trailing 'Z' is dropped.
    """
    with tempfile.TemporaryDirectory() as tmp:
        # A discovered project must have a .loki/memory dir under a search dir
        # to populate 'discovered_at'.
        proj = os.path.join(tmp, "proj_a")
        os.makedirs(os.path.join(proj, ".loki", "memory"))

        index = CrossProjectIndex(search_dirs=[tmp]).build_index()

        # 'built_at' is always present.
        assert "built_at" in index, "build_index() must emit built_at"
        parsed = datetime.fromisoformat(index["built_at"])  # raises on double-Z
        assert parsed is not None

        # 'discovered_at' on the discovered project must also parse.
        assert index["projects"], "expected proj_a to be discovered"
        disc = index["projects"][0]["discovered_at"]
        datetime.fromisoformat(disc)  # raises on double-Z
        print("PASS test_cross_project_timestamps_parse:",
              "built_at=%s discovered_at=%s" % (index["built_at"], disc))


def test_knowledge_graph_timestamps_parse():
    """build_graph() 'built_at' must be valid ISO 8601.

    Non-vacuity: same as above -- fromisoformat raises on the old double-Z
    form, so this guards the knowledge_graph.py fix specifically.
    """
    with tempfile.TemporaryDirectory() as tmp:
        proj = os.path.join(tmp, "proj_a")
        os.makedirs(os.path.join(proj, ".loki", "memory", "semantic"))
        graph = OrganizationKnowledgeGraph().build_graph([proj])
        assert "built_at" in graph, "build_graph() must emit built_at"
        parsed = datetime.fromisoformat(graph["built_at"])  # raises on double-Z
        assert parsed is not None
        print("PASS test_knowledge_graph_timestamps_parse:",
              "built_at=%s" % graph["built_at"])


class _FakeIndexLayer:
    """Index layer with a small footprint and one relevant topic."""

    def __init__(self, token_count, topics, total_available):
        self._token_count = token_count
        self._topics = topics
        self._total_available = total_available

    def load(self):
        return {"total_tokens_available": self._total_available}

    def get_token_count(self):
        return self._token_count

    def find_relevant_topics(self, query, threshold=0.5):
        return self._topics


class _FakeTimelineLayer:
    """Timeline layer whose total cost is configurable (to make it oversized)."""

    def __init__(self, token_count, entries_per_topic):
        self._token_count = token_count
        self._entries = entries_per_topic

    def load(self):
        return {}

    def get_token_count(self):
        return self._token_count

    def get_recent_for_topic(self, topic_id):
        return list(self._entries)


def test_layer2_respects_budget():
    """An oversized timeline must NOT push total token usage past max_tokens.

    Scenario: layer1 is small (50) so the budget is still positive after
    Layer 1, but the timeline costs far more than the remaining budget
    (5000 >> 100). Pre-fix, Layer 2 loaded + counted all 5000 tokens
    unconditionally, so metrics.total_tokens would be >> max_tokens.
    The affordability gate must keep total usage within max_tokens.

    Non-vacuity: max_tokens (100) is strictly between layer1 (50) and
    layer1+layer2 (5050), so an unguarded Layer 2 provably overspends and
    this assertion FAILS without the fix.
    """
    max_tokens = 100
    layer1_tokens = 50
    timeline_tokens = 5000

    # High-relevance topic whose own full-memory cost also exceeds the
    # remaining budget, so Layer 3 cannot load it either (keeps the test
    # focused on the Layer-2 overspend path; topic_id has no backing store).
    topic = Topic(id="t1", summary="s", relevance_score=0.9, token_count=9999)

    loader = ProgressiveLoader(
        base_path=tempfile.mkdtemp(prefix="loki-mem-test-"),
        index_layer=_FakeIndexLayer(layer1_tokens, [topic], total_available=10000),
        timeline_layer=_FakeTimelineLayer(timeline_tokens,
                                          entries_per_topic=[{"x": 1}]),
    )

    memories, metrics = loader.load_relevant_context("recent work", max_tokens=max_tokens)

    assert metrics.total_tokens <= max_tokens, (
        "Layer-2 overspend: total_tokens=%d exceeds max_tokens=%d"
        % (metrics.total_tokens, max_tokens)
    )
    # The oversized timeline must not have been charged to the budget.
    assert metrics.layer2_tokens <= max_tokens, (
        "oversized timeline was charged: layer2_tokens=%d" % metrics.layer2_tokens
    )
    print("PASS test_layer2_respects_budget:",
          "total_tokens=%d layer2_tokens=%d (max=%d)"
          % (metrics.total_tokens, metrics.layer2_tokens, max_tokens))


def test_layer2_loads_when_affordable():
    """Control case: an affordable timeline IS loaded and appended.

    Non-vacuity: this proves the affordability gate does not simply disable
    Layer 2 for everyone -- when the timeline fits the budget, its entries
    are returned and its cost is charged. Without a working append path this
    would return zero timeline memories.
    """
    max_tokens = 2000
    layer1_tokens = 50
    timeline_tokens = 100  # fits comfortably

    topic = Topic(id="t1", summary="s", relevance_score=0.6, token_count=10)
    loader = ProgressiveLoader(
        base_path=tempfile.mkdtemp(prefix="loki-mem-test-"),
        index_layer=_FakeIndexLayer(layer1_tokens, [topic], total_available=10000),
        timeline_layer=_FakeTimelineLayer(timeline_tokens,
                                          entries_per_topic=[{"x": 1}]),
    )

    memories, metrics = loader.load_relevant_context("recent work", max_tokens=max_tokens)

    timeline_mem = [m for m in memories if m.get("type") == "timeline"]
    assert timeline_mem, "affordable timeline should yield timeline memories"
    assert metrics.layer2_tokens == timeline_tokens, (
        "affordable timeline cost should be charged: layer2_tokens=%d"
        % metrics.layer2_tokens
    )
    assert metrics.total_tokens <= max_tokens
    print("PASS test_layer2_loads_when_affordable:",
          "timeline_memories=%d layer2_tokens=%d"
          % (len(timeline_mem), metrics.layer2_tokens))


class _FakeStorage:
    """Storage stub that can load any topic id as an episode."""

    def load_episode(self, topic_id):
        return {"id": topic_id, "content": "full memory body"}

    def load_pattern(self, topic_id):
        return None

    def load_skill(self, topic_id):
        return None


def test_layer3_gate_uses_effective_score():
    """A keyword-boosted topic must clear the Layer-3 high-relevance gate.

    After WT9 the keyword boost lives on the transient match_score
    (effective_score), never on the stored relevance_score. The loader's
    Layer-3 gate must therefore test effective_score, not relevance_score.

    Scenario: a topic with stored relevance 0.6 but a query boost lifting
    effective_score to 0.9 (>= the 0.8 high-relevance gate). The timeline is
    empty (no timeline context), so the run must fall through to Layer 3 and
    load the topic's full memory.

    Non-vacuity: pre-fix the gate read relevance_score (0.6 < 0.8), so the
    topic was filtered out of high_relevance and NO full memory was loaded;
    this assertion FAILS. Post-fix the gate reads effective_score (0.9 >= 0.8)
    and the full memory is loaded.
    """
    # Stored relevance below the gate; boosted match_score above it.
    topic = Topic(id="t1", summary="deploy kubernetes",
                  relevance_score=0.6, token_count=20, match_score=0.9)
    assert topic.relevance_score < ProgressiveLoader.HIGH_RELEVANCE_THRESHOLD
    assert topic.effective_score >= ProgressiveLoader.HIGH_RELEVANCE_THRESHOLD

    loader = ProgressiveLoader(
        base_path=tempfile.mkdtemp(prefix="loki-mem-test-"),
        index_layer=_FakeIndexLayer(50, [topic], total_available=10000),
        # Empty timeline so get_recent_for_topic yields nothing and the run
        # falls through to Layer 3 instead of returning timeline context.
        timeline_layer=_FakeTimelineLayer(100, entries_per_topic=[]),
    )
    loader._storage = _FakeStorage()

    memories, metrics = loader.load_relevant_context("deploy kubernetes",
                                                     max_tokens=2000)
    full = [m for m in memories if m.get("type") in ("episode", "pattern", "skill")]
    assert full, (
        "Layer-3 gate dropped a keyword-boosted topic (effective_score=%.2f); "
        "gate must use effective_score, not stored relevance_score"
        % topic.effective_score
    )
    assert metrics.layer3_tokens == topic.token_count, (
        "boosted topic was not charged to Layer 3: layer3_tokens=%d"
        % metrics.layer3_tokens
    )
    print("PASS test_layer3_gate_uses_effective_score:",
          "full=%d layer3_tokens=%d" % (len(full), metrics.layer3_tokens))


def main():
    tests = [
        test_cross_project_timestamps_parse,
        test_knowledge_graph_timestamps_parse,
        test_layer2_respects_budget,
        test_layer2_loads_when_affordable,
        test_layer3_gate_uses_effective_score,
    ]
    for t in tests:
        t()
    print("\nALL %d TESTS PASSED" % len(tests))


if __name__ == "__main__":
    main()
