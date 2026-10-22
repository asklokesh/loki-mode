#!/usr/bin/env python3
"""
Wave-6 hardening regression tests for memory/storage.py.

Each test drives the REAL MemoryStorage object against a throwaway tempdir
and asserts one specific failure mode does not recur. Every test is
non-vacuous: the docstring states exactly what the pre-fix code did (the
observable failure the assertion rules out), so a passing run is meaningful.

Run directly:  python3 tests/test_storage_wave6.py
Or via pytest: python3 -m pytest tests/test_storage_wave6.py -q
"""

import json
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Make the repo root importable so `import memory.*` resolves regardless of cwd.
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from memory.storage import MemoryStorage  # noqa: E402
from memory.schemas import SemanticPattern  # noqa: E402


def _new_storage(tmpdir: str) -> MemoryStorage:
    """Fresh storage rooted at an isolated tempdir."""
    return MemoryStorage(base_path=Path(tmpdir))


def _old_iso(days: int = 90) -> str:
    """An ISO timestamp `days` in the past (forces decay to do real work)."""
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def test_null_importance_does_not_crash_apply_decay() -> None:
    """
    H1: a record with an explicit null importance must not crash apply_decay.

    Non-vacuity: pre-fix `apply_decay` did
    `current_importance = memory.get("importance", 0.5)`, which returns None
    when the key is present with value null, then `None * decay_factor`
    raises TypeError. A valid OLD last_accessed is supplied so the decay
    arithmetic is actually reached (otherwise ref_time is None and the line
    is skipped, making the test vacuous). We assert no exception and a sane
    decayed importance in [0.01, 1.0].
    """
    with tempfile.TemporaryDirectory() as tmp:
        storage = _new_storage(tmp)
        rec = {"id": "ep-null-imp", "importance": None,
               "last_accessed": _old_iso(90)}
        out = storage.apply_decay([rec])
        result = out[0]["importance"]
        assert isinstance(result, (int, float)), "importance must be numeric"
        assert 0.01 <= result <= 1.0, f"importance out of range: {result}"


def test_null_importance_does_not_crash_boost_on_retrieval() -> None:
    """
    H1: a record with explicit null importance and null access_count must not
    crash boost_on_retrieval.

    Non-vacuity: pre-fix code did `memory.get("importance", 0.5)` ->
    `boost * (1.0 - None)` -> TypeError, and
    `memory.get("access_count", 0) + 1` -> `None + 1` -> TypeError. We feed
    both as null and assert sane numeric results.
    """
    with tempfile.TemporaryDirectory() as tmp:
        storage = _new_storage(tmp)
        rec = {"id": "ep-null-boost", "importance": None,
               "access_count": None}
        out = storage.boost_on_retrieval(rec, boost=0.1)
        assert isinstance(out["importance"], (int, float))
        assert 0.0 <= out["importance"] <= 1.0
        assert out["access_count"] == 1, "null access_count must increment to 1"


def test_null_importance_does_not_crash_calculate_importance() -> None:
    """
    H1 (swept site): calculate_importance must not crash on null importance
    or null access_count.

    Non-vacuity: pre-fix `base = memory.get("importance", 0.5)` returned None
    on an explicit null, and `base + 0.1` (success-outcome branch) raised
    TypeError; likewise `access_count = memory.get("access_count", 0)` -> None
    crashed the `> 0` comparison. We assert a numeric score in [0.0, 1.0].
    """
    with tempfile.TemporaryDirectory() as tmp:
        storage = _new_storage(tmp)
        rec = {"id": "p-null", "importance": None, "access_count": None,
               "outcome": "success"}
        score = storage.calculate_importance(rec)
        assert isinstance(score, float)
        assert 0.0 <= score <= 1.0


def test_null_phase_category_does_not_crash_calculate_importance() -> None:
    """
    H1 (R2-flagged missed siblings): the task-type relevance branch of
    calculate_importance reads phase/category and lowercases them. An explicit
    null phase (in context or top-level) or null category must not crash.

    Non-vacuity: pre-fix `phase = context.get("phase", memory.get("phase",
    "")).lower()` returned None.lower() -> AttributeError on a null phase, and
    `category = memory.get("category", "").lower()` crashed on a null category.
    This branch only runs when task_type is passed, so we pass one. We assert a
    numeric score in [0.0, 1.0].
    """
    with tempfile.TemporaryDirectory() as tmp:
        storage = _new_storage(tmp)
        rec = {
            "id": "p-null-phase",
            "context": {"phase": None},
            "phase": None,
            "category": None,
        }
        score = storage.calculate_importance(rec, task_type="debug")
        assert isinstance(score, float)
        assert 0.0 <= score <= 1.0


def test_decay_semantic_does_not_drop_concurrent_save() -> None:
    """
    H1-storage (lost update): a concurrent save_pattern of a NEW pattern must
    NOT be clobbered by a simultaneous _decay_semantic.

    Non-vacuity: pre-fix `_decay_semantic` read patterns.json under one lock
    scope (_load_json), mutated in memory, then wrote under a separate lock
    scope (_atomic_write). A save_pattern landing between read and write was
    overwritten by the decay's stale snapshot, so the newly-saved pattern
    vanished from patterns.json. We run many barrier-synchronized rounds; each
    round seeds patterns.json with an OLD P1 (so decay actually writes), then
    races a decay thread against a save of a fresh P2. Post-fix the single
    spanning lock serializes them so P2 always survives; pre-fix P2 is dropped
    in a fraction of rounds.

    Threads are joined with a timeout so a regression that reintroduces
    deadlock fails the test instead of hanging the suite.
    """
    rounds = 200
    join_timeout = 10.0
    with tempfile.TemporaryDirectory() as tmp:
        storage = _new_storage(tmp)
        patterns_path = storage.base_path / "semantic" / "patterns.json"
        patterns_path.parent.mkdir(parents=True, exist_ok=True)

        # Seed with MANY old patterns so the decay mutate-loop takes a
        # measurable amount of time, widening the read-to-write window the
        # save must land in to trigger the pre-fix lost update. (One pattern
        # makes the window microscopic and the race rarely fires.)
        seed_patterns = [{
            "id": f"P1-{j}",
            "pattern": "seed pattern",
            "category": "testing",
            "importance": 0.9,
            "last_accessed": _old_iso(120),
        } for j in range(400)]

        for i in range(rounds):
            patterns_path.write_text(json.dumps({
                "version": "1.0",
                "patterns": list(seed_patterns),
            }))

            new_id = f"P2-{i}"
            barrier = threading.Barrier(2)
            errors = []

            def run_decay():
                try:
                    barrier.wait()
                    storage._decay_semantic(decay_rate=0.1, half_life_days=30)
                except Exception as exc:  # noqa: BLE001
                    errors.append(("decay", exc))

            def run_save():
                try:
                    barrier.wait()
                    storage.save_pattern(SemanticPattern(
                        id=new_id, pattern="brand new", category="testing",
                        confidence=0.7,
                    ))
                except Exception as exc:  # noqa: BLE001
                    errors.append(("save", exc))

            t_decay = threading.Thread(target=run_decay)
            t_save = threading.Thread(target=run_save)
            t_decay.start()
            t_save.start()
            t_decay.join(timeout=join_timeout)
            t_save.join(timeout=join_timeout)

            assert not t_decay.is_alive() and not t_save.is_alive(), (
                f"round {i}: thread did not finish (possible deadlock)"
            )
            assert not errors, f"round {i}: thread raised: {errors}"

            on_disk = json.loads(patterns_path.read_text())
            ids = {p.get("id") for p in on_disk.get("patterns", [])
                   if isinstance(p, dict)}
            assert new_id in ids, (
                f"round {i}: concurrent save of {new_id} was dropped "
                f"(lost-update regression). on-disk ids={ids}"
            )


def test_save_episode_rejects_path_traversal() -> None:
    """
    M1-storage (path traversal): a poisoned timestamp must not let an episode
    escape the memory base_path.

    Non-vacuity: pre-fix `save_episode` built
    `base_path / "episodic" / timestamp[:10]` with no validation, so a
    timestamp of "../../../tmp/evil" produced "episodic/../../../tmp" and the
    file landed outside base_path. We save such an episode and assert (a) no
    file exists at the escaped location, and (b) every written file stays
    under base_path.
    """
    with tempfile.TemporaryDirectory() as tmp:
        # Root the memory store a few levels deep inside an isolated sandbox so
        # any escape stays observable WITHIN the sandbox (and never pollutes the
        # shared system temp dir). The pre-fix code would write the file at
        # sandbox/a/b/c/episodic/../../../tmp/evil/.. -> i.e. above base_path
        # but still under the sandbox, where we can detect it.
        sandbox = Path(tmp) / "sandbox"
        base = (sandbox / "a" / "b" / "c").resolve()
        base.mkdir(parents=True, exist_ok=True)
        storage = MemoryStorage(base_path=base)

        storage.save_episode({
            "id": "evil-ep",
            "timestamp": "../../../tmp/evil",
            "importance": 0.5,
        })

        # No episode file may exist anywhere inside the sandbox that is NOT
        # under base_path. Pre-fix the traversal placed it outside base_path.
        all_files = list(sandbox.rglob("task-*.json"))
        assert all_files, "episode was not written at all"
        for p in all_files:
            rp = p.resolve()
            assert base in rp.parents, (
                f"episode escaped base_path (path traversal): {rp}"
            )


def _run() -> int:
    tests = [
        test_null_importance_does_not_crash_apply_decay,
        test_null_importance_does_not_crash_boost_on_retrieval,
        test_null_importance_does_not_crash_calculate_importance,
        test_null_phase_category_does_not_crash_calculate_importance,
        test_decay_semantic_does_not_drop_concurrent_save,
        test_save_episode_rejects_path_traversal,
        test_namespace_cap_evicts_oldest_and_logs,
        test_namespace_cap_never_evicts_patterns_store,
        test_view_file_over_cap_is_truncated,
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

def _ep(i: int, pad: int = 2000) -> dict:
    return {"id": f"cap{i}", "timestamp": "2026-01-01T00:00:00+00:00", "pad": "x" * pad}


def test_namespace_cap_evicts_oldest_and_logs() -> None:
    """Pre-fix, writes past the namespace cap grew storage without bound."""
    import logging
    import os
    import time
    records = []

    class _H(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    lg = logging.getLogger("memory.storage")
    h = _H()
    lg.addHandler(h)
    os.environ["LOKI_MEMORY_NAMESPACE_MAX_BYTES"] = "10000"
    try:
        with tempfile.TemporaryDirectory() as d:
            s = _new_storage(d)
            for i in range(10):  # ~2x the cap
                s.save_episode(_ep(i))
                time.sleep(0.01)
            total = sum(f.stat().st_size for f in (Path(d) / "episodic").rglob("*.json"))
            assert total <= 10000, total
            assert s.load_episode("cap9") is not None
            assert s.load_episode("cap0") is None
            assert any("evicted oldest entry" in m for m in records)
    finally:
        lg.removeHandler(h)
        os.environ.pop("LOKI_MEMORY_NAMESPACE_MAX_BYTES", None)


def test_namespace_cap_never_evicts_patterns_store() -> None:
    """Pre-fix, an oldest semantic/patterns.json was evicted, losing every pattern."""
    import os
    import time
    os.environ["LOKI_MEMORY_NAMESPACE_MAX_BYTES"] = "10000"
    try:
        with tempfile.TemporaryDirectory() as d:
            s = _new_storage(d)
            pat = Path(d) / "semantic" / "patterns.json"
            pat.write_text(json.dumps({"patterns": [{"id": "p"}], "pad": "z" * 4000}))
            time.sleep(0.05)
            for i in range(8):
                s.save_episode(_ep(i))
                time.sleep(0.01)
            assert pat.exists()
            assert s.load_episode("cap7") is not None
    finally:
        os.environ.pop("LOKI_MEMORY_NAMESPACE_MAX_BYTES", None)


def test_view_file_over_cap_is_truncated() -> None:
    """Pre-fix there was no capped read; a large file came back whole."""
    with tempfile.TemporaryDirectory() as d:
        s = _new_storage(d)
        s.write_json("big.json", {"pad": "y" * 5000})
        r = s.view_file("big.json", max_bytes=1000)
        assert r["truncated"] is True and len(r["content"]) == 1000
        r2 = s.view_file("big.json", max_bytes=100000)
        assert r2["truncated"] is False


if __name__ == "__main__":
    sys.exit(_run())
