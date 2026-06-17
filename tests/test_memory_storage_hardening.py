#!/usr/bin/env python3
"""
Regression tests for memory storage/retrieval hardening (backlog B10b/B10c/B10d).

Each test drives the REAL storage/retrieval objects against a throwaway
tempdir and asserts one specific failure mode does not recur. The
non-vacuity note on each test states exactly what the pre-fix code would
do (the observable failure the assertion rules out), so a passing run is
meaningful rather than trivially green.

Run directly:  python3 tests/test_memory_storage_hardening.py
"""

import json
import sys
import tempfile
from pathlib import Path

# Make the repo root importable so `import memory.*` resolves regardless of cwd.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from memory.storage import MemoryStorage  # noqa: E402
from memory.retrieval import MemoryRetrieval  # noqa: E402
from memory.schemas import SemanticPattern  # noqa: E402


def _new_storage(tmpdir: str) -> MemoryStorage:
    """Fresh storage rooted at an isolated tempdir."""
    return MemoryStorage(base_path=Path(tmpdir))


def test_b10b_resave_does_not_double_count() -> None:
    """
    B10b: re-saving an existing pattern (same id) must be idempotent and
    keep the on-disk list (and therefore the index count) at a single entry.

    Non-vacuity: blind-append code (the historical bug) would append on the
    second save, producing 2 entries / index topic count 2. We assert the
    count stays exactly 1 after the second save, which only holds if the
    upsert path actually replaces the existing entry. The stable id is
    supplied explicitly so the two saves target the same record (auto-ids
    would defeat the test by producing two distinct records legitimately).
    """
    with tempfile.TemporaryDirectory() as tmp:
        storage = _new_storage(tmp)
        pattern = SemanticPattern(
            id="sem-resave-001",
            pattern="always validate input",
            category="testing",
            confidence=0.9,
        )

        first_id = storage.save_pattern(pattern)
        assert first_id == "sem-resave-001"
        assert len(storage.list_patterns()) == 1, "first save should yield 1"

        # Re-save the SAME pattern (same id). Must not inflate the count.
        storage.save_pattern(pattern)
        assert len(storage.list_patterns()) == 1, (
            "re-save inflated the pattern count (B10b double-count regression)"
        )

        # Index-level fidelity to the bug title ("index double-count"): the
        # rebuilt index must carry exactly one pattern-type topic.
        storage.update_index()
        index = storage.get_index()
        pattern_topics = [t for t in index.get("topics", [])
                          if t.get("type") == "pattern"]
        assert len(pattern_topics) == 1, (
            "index shows more than one pattern topic after re-save (B10b)"
        )


def test_b10c_missing_patterns_key_degrades_to_empty() -> None:
    """
    B10c: a patterns.json that is valid JSON but lacks the "patterns" key
    (partial/external write, version-only file) must NOT crash recall paths;
    it should degrade to an empty result.

    Non-vacuity: pre-fix code indexed `patterns_file["patterns"]` directly,
    which raises KeyError on such a file. We write exactly that shape and
    assert the read paths return empty lists instead of raising.
    """
    with tempfile.TemporaryDirectory() as tmp:
        storage = _new_storage(tmp)
        patterns_path = storage.base_path / "semantic" / "patterns.json"
        patterns_path.parent.mkdir(parents=True, exist_ok=True)
        # Valid JSON, NO "patterns" key.
        patterns_path.write_text(json.dumps({"version": "1.0"}))

        # storage read paths must not raise and must yield nothing.
        assert storage.list_patterns() == []
        assert storage.load_pattern("anything") is None

        # retrieval keyword path over the same broken file must not raise.
        retrieval = MemoryRetrieval(storage, base_path=str(storage.base_path))
        results = retrieval._keyword_search_semantic(["validate"])
        assert results == [], "missing 'patterns' key should yield no results"

        # A subsequent save must still succeed (setdefault recovery) and the
        # file should then contain exactly the one saved pattern.
        storage.save_pattern(
            SemanticPattern(id="sem-recover-1", pattern="x", category="c")
        )
        assert storage.list_patterns() == ["sem-recover-1"]


def test_b10d_non_dict_entry_is_skipped() -> None:
    """
    B10d: a non-dict entry inside the patterns list (corruption, schema
    drift, a bare string) must be skipped rather than crashing.

    Non-vacuity: pre-fix loops called `entry.get(...)` on every list item;
    a string item raises AttributeError ('str' object has no attribute
    'get'). We seed a list mixing a valid dict pattern with a bare string
    and assert the read paths return only the valid pattern, no exception.
    """
    with tempfile.TemporaryDirectory() as tmp:
        storage = _new_storage(tmp)
        patterns_path = storage.base_path / "semantic" / "patterns.json"
        patterns_path.parent.mkdir(parents=True, exist_ok=True)
        patterns_path.write_text(json.dumps({
            "version": "1.0",
            "patterns": [
                {"id": "sem-good-1", "pattern": "validate input",
                 "category": "testing", "confidence": 0.8},
                "i-am-not-a-dict",  # the poison entry
                None,               # also non-dict
            ],
        }))

        # storage paths skip the non-dict entries, keep the good one.
        ids = storage.list_patterns()
        assert ids == ["sem-good-1"], (
            "non-dict entries not skipped in list_patterns (B10d)"
        )
        assert storage.load_pattern("sem-good-1") is not None
        assert storage.load_pattern("i-am-not-a-dict") is None

        # retrieval keyword path must skip the non-dict entries without raising.
        retrieval = MemoryRetrieval(storage, base_path=str(storage.base_path))
        results = retrieval._keyword_search_semantic(["validate"])
        result_ids = [r.get("id") for r in results]
        assert "sem-good-1" in result_ids, (
            "valid pattern lost while skipping non-dict entries (B10d)"
        )

        # update_pattern over a list containing non-dict entries must not raise.
        storage.update_pattern(
            SemanticPattern(id="sem-good-1", pattern="validate input v2",
                            category="testing")
        )
        assert storage.load_pattern("sem-good-1")["pattern"] == \
            "validate input v2"


def _run() -> int:
    tests = [
        test_b10b_resave_does_not_double_count,
        test_b10c_missing_patterns_key_degrades_to_empty,
        test_b10d_non_dict_entry_is_skipped,
    ]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL {t.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(_run())
