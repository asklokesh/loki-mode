#!/usr/bin/env python3
"""
Regression tests for three correctness bugs in the memory retrieval path.

Covers:
  (a) detect_task_type crashed on a present-but-None context field
      ({"goal": None} -> None.lower() -> AttributeError).
  (b) the skills keyword-search step join crashed when `steps` was null or
      held non-str elements (" ".join(None) -> TypeError).
  (c) CRITICAL: a token budget threw away task-aware ranking. retrieve_*
      computes a task-aware `_weighted_score` (task-strategy weight x
      importance x confidence x recency) and sorts by it, but optimize_context
      re-ranked from scratch on the raw `_score`, ignoring `_weighted_score`.
      A budget therefore discarded all task-aware weighting. The fix makes
      optimize_context prefer `_weighted_score` when present.

NOTE ON DISCOVERY: this file's name is hyphenated, so pytest's default
`python_files` (test_*.py / *_test.py) will NOT collect it by recursion. Run
it by explicit path (`python3 -m pytest tests/test-memory-retrieval-bugs.py`)
or standalone (`python3 tests/test-memory-retrieval-bugs.py`). The __main__
block below runs every test function so a green here is real, not a
false-green from a 0-collected discovery miss.
"""

import os
import sys

# Make the repo root importable so `import memory.*` resolves regardless of cwd.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from memory.retrieval import MemoryRetrieval
from memory.token_economics import optimize_context


class _FakeFile:
    """Minimal stand-in for the path objects storage.list_files returns."""

    def __init__(self, name: str):
        self.name = name


class _FakeStorage:
    """In-memory storage exposing only the methods the retriever touches."""

    def __init__(self, skills_by_file):
        # skills_by_file: {"some.json": {...skill dict...}}
        self._skills = skills_by_file

    def list_files(self, collection, pattern="*"):
        if collection == "skills":
            return [_FakeFile(name) for name in self._skills]
        return []

    def read_json(self, rel_path):
        # rel_path looks like "skills/<file>.json"
        key = rel_path.split("/", 1)[1] if "/" in rel_path else rel_path
        return self._skills.get(key)


def test_detect_task_type_handles_none_goal():
    """(a) Present-but-None context fields must not crash detect_task_type.

    Non-vacuity: against the OLD code (`context.get("goal", "").lower()`), a
    present {"goal": None} returns None and None.lower() raises
    AttributeError, so this call would have crashed before reaching the
    assertion. The fix `(context.get("goal") or "")` returns "" instead.
    """
    retriever = MemoryRetrieval(storage=_FakeStorage({}))

    # All three guarded fields present and None at once.
    result = retriever.detect_task_type(
        {"goal": None, "action_type": None, "phase": None}
    )

    # A valid task type is still returned (defaults to implementation).
    assert isinstance(result, str) and result, (
        "detect_task_type should return a non-empty task type, got %r" % result
    )


def test_keyword_search_skills_handles_null_steps():
    """(b) A skill with steps=None (or non-str elements) must not crash.

    Non-vacuity: against the OLD code (`" ".join(data.get("steps", []))`), a
    skill whose `steps` is None yields `" ".join(None)` which raises
    TypeError; non-str elements raise TypeError inside join too. The fix
    filters to str elements over `(data.get("steps") or [])`. Without the fix
    this call raises before returning, failing the test.
    """
    storage = _FakeStorage({
        # steps is null, and a second skill with mixed non-str elements.
        "skill_null.json": {
            "name": "deploy helper",
            "description": "helps deploy x",
            "steps": None,
        },
        "skill_mixed.json": {
            "name": "deploy mixer",
            "description": "deploy y",
            "steps": ["valid step", None, 42, {"nested": "obj"}],
        },
    })
    retriever = MemoryRetrieval(storage=storage)

    # "deploy" matches the names, so the join + score path is exercised.
    results = retriever._keyword_search_skills(["deploy"])

    # The search completes (no crash) and returns the matching skills.
    assert isinstance(results, list), "expected a list of results"
    assert len(results) == 2, (
        "both skills match 'deploy' and should survive the join, got %d"
        % len(results)
    )


def test_optimize_context_preserves_weighted_score_under_budget():
    """(c) CRITICAL: token-budget trimming must preserve task-aware ranking.

    Two memories with OPPOSITE relevance signals and otherwise-equal fields:
      A: high task-aware _weighted_score (0.9), low raw _score (0.1)
      B: low task-aware _weighted_score (0.1), high raw _score (0.9)
    Everything else equal (same confidence/usage_count, no timestamp so
    recency defaults to 0.5 for both, near-equal token size). The budget is
    large enough that BOTH fit, so this is a pure ordering check, not a
    membership/budget-edge check.

    Non-vacuity: against the OLD code, optimize_context read
    `memory.get("_score", 0.5)` and ranked by raw score, returning [B, A];
    `result[0] is A` would FAIL. The fix prefers `_weighted_score` when
    present, returning [A, B] so the task-aware order survives the budget.
    """
    memory_a = {
        "id": "A",
        "_weighted_score": 0.9,
        "_score": 0.1,
        "confidence": 0.5,
        "usage_count": 0,
        "content": "aaaa",
    }
    memory_b = {
        "id": "B",
        "_weighted_score": 0.1,
        "_score": 0.9,
        "confidence": 0.5,
        "usage_count": 0,
        "content": "bbbb",
    }

    # Budget large enough to hold both -> isolates ordering from selection.
    result = optimize_context([memory_b, memory_a], budget=10_000)

    assert len(result) == 2, (
        "budget holds both memories; expected 2, got %d" % len(result)
    )
    assert result[0] is memory_a, (
        "high-_weighted_score / low-_score memory A must rank first; the old "
        "code ranked by raw _score and would put B first. Got order: %s"
        % [m["id"] for m in result]
    )
    assert result[1] is memory_b, "memory B must rank second"


def test_optimize_context_falls_back_to_score_when_no_weighted():
    """(c-guard) When _weighted_score is absent, raw _score still drives order.

    Non-vacuity: if the fix had unconditionally read _weighted_score (with a
    constant default), both memories would tie on the default and order would
    be arbitrary. This asserts the fallback branch is real: with no
    _weighted_score key, the higher _score wins.
    """
    hi = {"id": "hi", "_score": 0.9, "confidence": 0.5, "content": "hhhh"}
    lo = {"id": "lo", "_score": 0.1, "confidence": 0.5, "content": "llll"}

    result = optimize_context([lo, hi], budget=10_000)

    assert result[0] is hi, (
        "without _weighted_score, the higher raw _score must rank first; "
        "got %s" % [m["id"] for m in result]
    )


def test_retrieve_by_temporal_filters_within_day():
    """(d) retrieve_by_temporal honored only day-granularity, not the time.

    Two episodes on the same UTC day (08:00 and 20:00). Asking for episodes
    `since` 14:00 must return ONLY the 20:00 one. A third episode with no
    timestamp must still come back (day-level fallback, never silently dropped).

    Non-vacuity: against the OLD code, the date-dir match included every
    episode in the matching day directory regardless of its own timestamp, so
    the 08:00 episode leaked into a `since`-14:00 query; this assertion would
    fail. The fix filters each episode by its parsed timestamp.
    """
    import json
    import tempfile
    from datetime import datetime, timezone
    from pathlib import Path

    from memory.storage import MemoryStorage

    base = tempfile.mkdtemp()
    storage = MemoryStorage(base_path=base)
    date_dir = Path(base) / "episodic" / "2026-06-19"
    date_dir.mkdir(parents=True)
    (date_dir / "task-morning.json").write_text(json.dumps({
        "id": "task-morning",
        "timestamp": "2026-06-19T08:00:00+00:00",
        "context": {"goal": "m"},
    }))
    (date_dir / "task-evening.json").write_text(json.dumps({
        "id": "task-evening",
        "timestamp": "2026-06-19T20:00:00+00:00",
        "context": {"goal": "e"},
    }))
    (date_dir / "task-notime.json").write_text(json.dumps({
        "id": "task-notime",
        "context": {"goal": "x"},
    }))

    retriever = MemoryRetrieval(storage=storage)
    since = datetime(2026, 6, 19, 14, 0, 0, tzinfo=timezone.utc)
    until = datetime(2026, 6, 19, 23, 59, 0, tzinfo=timezone.utc)
    ids = {e.get("id") for e in retriever.retrieve_by_temporal(since=since, until=until)}

    assert "task-morning" not in ids, (
        "08:00 episode must be excluded from a since-14:00 query; got %s" % ids
    )
    assert "task-evening" in ids, "20:00 episode must be included"
    assert "task-notime" in ids, "no-timestamp episode must not be dropped"


def test_retrieve_by_temporal_accepts_naive_bounds():
    """(d-guard) A naive `since` must not raise on tz-aware episode timestamps.

    Non-vacuity: the per-episode comparison `since <= ep_ts <= until` against a
    tz-aware ep_ts would raise TypeError if `since` stayed naive; the fix
    normalizes the bounds to UTC. A naive full-day window returns both timed
    episodes.
    """
    import json
    import tempfile
    from datetime import datetime
    from pathlib import Path

    from memory.storage import MemoryStorage

    base = tempfile.mkdtemp()
    storage = MemoryStorage(base_path=base)
    date_dir = Path(base) / "episodic" / "2026-06-19"
    date_dir.mkdir(parents=True)
    (date_dir / "task-a.json").write_text(json.dumps({
        "id": "task-a", "timestamp": "2026-06-19T08:00:00+00:00",
        "context": {"goal": "a"},
    }))
    (date_dir / "task-b.json").write_text(json.dumps({
        "id": "task-b", "timestamp": "2026-06-19T20:00:00+00:00",
        "context": {"goal": "b"},
    }))

    retriever = MemoryRetrieval(storage=storage)
    # Naive since (no tzinfo) -- must not raise.
    res = retriever.retrieve_by_temporal(since=datetime(2026, 6, 19, 0, 0, 0))
    ids = {e.get("id") for e in res}
    assert {"task-a", "task-b"} <= ids, (
        "naive-bound full-day query should return both episodes; got %s" % ids
    )


class _PatternStorage:
    """In-memory storage exposing the JSON files the keyword/merge paths read."""

    def __init__(self, jsons):
        # jsons: {"semantic/patterns.json": {...}, ...}
        self._j = jsons

    def list_files(self, collection, pattern="*"):
        return []

    def read_json(self, rel_path):
        return self._j.get(rel_path)


def test_anti_pattern_not_returned_twice():
    """(e) An anti-pattern record must not appear in BOTH source buckets.

    Consolidation writes anti-patterns into semantic/patterns.json as records
    with category="anti-pattern". _keyword_search_anti_patterns already bridges
    those into the anti_patterns source. _keyword_search_semantic scans the same
    patterns.json; before the fix it had no category filter, so the SAME record
    came back twice (once as semantic, once as anti_patterns), double-counting it
    and wasting token budget.

    Non-vacuity: against the OLD code, the id is present in BOTH lists; the
    assertion that it is absent from the semantic list would fail.
    """
    storage = _PatternStorage({
        "semantic/patterns.json": {"patterns": [{
            "id": "pat-anti-1",
            "category": "anti-pattern",
            "pattern": "fix timeout error bug",
            "incorrect_approach": "fix timeout error bug",
            "description": "why it fails",
            "correct_approach": "do it right",
        }]},
        "semantic/anti-patterns.json": {"anti_patterns": []},
    })
    retriever = MemoryRetrieval(storage=storage)
    keywords = ["timeout", "error", "bug"]

    semantic = retriever._keyword_search_semantic(keywords)
    anti = retriever._keyword_search_anti_patterns(keywords)

    semantic_ids = [r.get("id") for r in semantic]
    anti_ids = [r.get("id") for r in anti]

    assert "pat-anti-1" not in semantic_ids, (
        "anti-pattern must be excluded from the semantic source; got %s"
        % semantic_ids
    )
    assert "pat-anti-1" in anti_ids, (
        "anti-pattern must still surface in the anti_patterns source; got %s"
        % anti_ids
    )


def test_semantic_non_anti_pattern_still_returned():
    """(e-guard) A normal (non-anti) pattern must still surface in semantic.

    Non-vacuity: if the fix had skipped all patterns, this would return empty.
    The category filter must only drop category=="anti-pattern".
    """
    storage = _PatternStorage({
        "semantic/patterns.json": {"patterns": [{
            "id": "pat-good-1",
            "category": "best-practice",
            "pattern": "fix timeout error bug",
            "correct_approach": "use a deadline",
            "confidence": 1.0,
        }]},
    })
    retriever = MemoryRetrieval(storage=storage)
    results = retriever._keyword_search_semantic(["timeout", "error", "bug"])
    assert [r.get("id") for r in results] == ["pat-good-1"], (
        "a non-anti-pattern must still be returned from semantic; got %s"
        % [r.get("id") for r in results]
    )


def test_merge_results_dedups_by_id():
    """(e2) _merge_results collapses duplicate ids, keeping the best-scoring copy.

    Defense-in-depth for the double-return class: even if the same record reaches
    two collection buckets, the merged output must contain it once. The higher
    _weighted_score copy survives.

    Non-vacuity: against the OLD code (no dedup), both copies survive and the
    count for the shared id is 2; this assertion would fail.
    """
    retriever = MemoryRetrieval(storage=_PatternStorage({}))
    merged = retriever._merge_results(
        {
            # Same id "dup" in two buckets; semantic copy has the higher
            # importance so it should win after dedup.
            "semantic": [{"id": "dup", "importance": 0.9, "_score": 1.0}],
            "anti_patterns": [{"id": "dup", "importance": 0.1, "_score": 1.0}],
            "skills": [{"id": "uniq", "_score": 1.0}],
        },
        weights={"semantic": 1.0, "anti_patterns": 1.0, "skills": 1.0},
        top_k=10,
    )
    ids = [m.get("id") for m in merged]
    assert ids.count("dup") == 1, (
        "duplicate id must be collapsed to one entry; got %s" % ids
    )
    assert "uniq" in ids, "unique id must be preserved"
    # The surviving copy is the higher-scoring one (semantic, importance 0.9).
    surviving = next(m for m in merged if m.get("id") == "dup")
    assert surviving.get("_source") == "semantic", (
        "the higher-scoring copy (semantic) must survive; got source %s"
        % surviving.get("_source")
    )


def test_merge_results_keeps_id_less_records_separate():
    """(e2-guard) Records without an id are never collapsed together.

    Non-vacuity: if dedup keyed on a default (e.g. None) it would drop all but
    one id-less record. Two distinct id-less records must both survive.
    """
    retriever = MemoryRetrieval(storage=_PatternStorage({}))
    merged = retriever._merge_results(
        {
            "semantic": [{"pattern": "a", "_score": 1.0}],
            "anti_patterns": [{"what_fails": "b", "_score": 1.0}],
        },
        weights={"semantic": 1.0, "anti_patterns": 1.0},
        top_k=10,
    )
    assert len(merged) == 2, (
        "two id-less records must both survive dedup; got %d" % len(merged)
    )


def test_recency_boost_ignores_future_timestamps():
    """(f) A future-dated record must not be treated as the freshest record.

    A record timestamped 100 days in the future has a negative age. Against the
    OLD code, age_days = (now - item_time).days was negative, passed the
    `age_days < 30` gate, and produced boost = boost_factor * (1 - negative/30),
    a boost ABOVE the intended cap, so the future record's score was inflated
    beyond every real record. The fix gates on `0 <= age_days < 30`.

    Non-vacuity: against the OLD code the future score is > 1.0 (here ~1.43);
    this assertion that it stays at 1.0 (no boost) would fail.
    """
    from datetime import datetime, timezone, timedelta

    retriever = MemoryRetrieval(storage=_PatternStorage({}))
    future = (datetime.now(timezone.utc) + timedelta(days=100)).isoformat()
    out = retriever._apply_recency_boost(
        [{"id": "future", "_weighted_score": 1.0, "timestamp": future}],
        boost_factor=0.1,
    )
    assert out[0]["_weighted_score"] == 1.0, (
        "future-dated record must get no recency boost; got %r"
        % out[0]["_weighted_score"]
    )


def test_recency_boost_caps_recent_and_decays_continuously():
    """(f-guard) Recent records are boosted up to the cap and decay continuously.

    A just-now record gets the full boost_factor (10%); a 15-day record gets
    ~half. This guards that the gate did not over-restrict legitimate boosts and
    that the continuous total_seconds() math (not truncated .days) is used.

    Non-vacuity: if the fix had dropped ALL boosts, the recent score would stay
    1.0 and this assertion (strictly > 1.0) would fail. The 15-day check fails
    if the code reverted to whole-day truncation only at the boundaries.
    """
    from datetime import datetime, timezone, timedelta

    retriever = MemoryRetrieval(storage=_PatternStorage({}))
    now = datetime.now(timezone.utc).isoformat()
    out_now = retriever._apply_recency_boost(
        [{"id": "now", "_weighted_score": 1.0, "timestamp": now}],
        boost_factor=0.1,
    )
    assert 1.0 < out_now[0]["_weighted_score"] <= 1.1 + 1e-9, (
        "a just-now record must be boosted up to the 10%% cap; got %r"
        % out_now[0]["_weighted_score"]
    )

    fifteen = (datetime.now(timezone.utc) - timedelta(days=15)).isoformat()
    out_15 = retriever._apply_recency_boost(
        [{"id": "d15", "_weighted_score": 1.0, "timestamp": fifteen}],
        boost_factor=0.1,
    )
    # 15 days is half of the 30-day window -> ~half the 10%% boost (~5%%).
    assert abs(out_15[0]["_weighted_score"] - 1.05) < 0.01, (
        "a 15-day record should get ~half the boost (~1.05); got %r"
        % out_15[0]["_weighted_score"]
    )


def test_similarity_dimension_mismatch_falls_back_to_keyword():
    """Fix B: when the vector index raises ValueError on a query-vs-index
    dimension mismatch (the embedding engine fell back to a different model since
    the index was built), retrieve_by_similarity must DEGRADE to keyword search
    -- never crash and never return wrong-dimension neighbors. This regression
    guards the exact failure mode the prior Fix B attempt left untested."""
    retriever = MemoryRetrieval(storage=_FakeStorage({}))

    class _MismatchIndex:
        # Mirrors VectorSearchIndex.search raising on a dimension mismatch.
        def search(self, query_embedding, top_k):
            raise ValueError("query dimension 640 != index dimension 384")

    class _Engine:
        def embed(self, text):
            return [0.0] * 640

    retriever.embedding_engine = _Engine()
    retriever.vector_indices = {"semantic": _MismatchIndex()}
    retriever._indices_built_at = None  # skip the staleness branch; force the search path

    keyword_called = {"hit": False}

    def _fake_keyword(words, collection):
        keyword_called["hit"] = True
        return [{"id": "kw1", "_source": collection}]

    retriever.retrieve_by_keyword = _fake_keyword

    # Must not raise; must return the keyword fallback result.
    out = retriever.retrieve_by_similarity("hello world", "semantic", top_k=3)
    assert keyword_called["hit"], "dimension mismatch did not degrade to keyword search"
    assert out == [{"id": "kw1", "_source": "semantic"}], (
        "expected the keyword fallback result, got %r" % (out,)
    )


def _run_all():
    tests = [
        test_detect_task_type_handles_none_goal,
        test_keyword_search_skills_handles_null_steps,
        test_optimize_context_preserves_weighted_score_under_budget,
        test_optimize_context_falls_back_to_score_when_no_weighted,
        test_retrieve_by_temporal_filters_within_day,
        test_retrieve_by_temporal_accepts_naive_bounds,
        test_anti_pattern_not_returned_twice,
        test_semantic_non_anti_pattern_still_returned,
        test_merge_results_dedups_by_id,
        test_merge_results_keeps_id_less_records_separate,
        test_recency_boost_ignores_future_timestamps,
        test_recency_boost_caps_recent_and_decays_continuously,
        test_similarity_dimension_mismatch_falls_back_to_keyword,
    ]
    failures = 0
    for fn in tests:
        try:
            fn()
            print("PASS: %s" % fn.__name__)
        except Exception as exc:  # noqa: BLE001 - report-and-continue for CLI run
            failures += 1
            print("FAIL: %s -> %s: %s" % (fn.__name__, type(exc).__name__, exc))
    print("\n%d passed, %d failed" % (len(tests) - failures, failures))
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run_all() else 0)
