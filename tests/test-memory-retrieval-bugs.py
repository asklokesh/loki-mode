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


def _run_all():
    tests = [
        test_detect_task_type_handles_none_goal,
        test_keyword_search_skills_handles_null_steps,
        test_optimize_context_preserves_weighted_score_under_budget,
        test_optimize_context_falls_back_to_score_when_no_weighted,
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
