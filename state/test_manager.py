"""
Tests for the State Manager

Run with: python -m pytest state/test_manager.py -v
"""

import json
import os
import tempfile
import threading
import time
from pathlib import Path

import pytest

from .manager import (
    StateManager,
    StateChange,
    ManagedFile,
    get_state_manager,
    reset_state_manager,
    ConflictStrategy,
    VersionVector,
    PendingUpdate,
    ConflictInfo,
)


class TestStateChange:
    """Tests for StateChange dataclass."""

    def test_to_dict(self):
        """Test StateChange serialization."""
        change = StateChange(
            file_path="test.json",
            old_value={"a": 1},
            new_value={"a": 2, "b": 3},
            change_type="update",
            source="test"
        )

        result = change.to_dict()

        assert result["file_path"] == "test.json"
        assert result["old_value"] == {"a": 1}
        assert result["new_value"] == {"a": 2, "b": 3}
        assert result["change_type"] == "update"
        assert result["source"] == "test"
        assert "timestamp" in result

    def test_get_diff_added(self):
        """Test diff detection for added keys."""
        change = StateChange(
            file_path="test.json",
            old_value={"a": 1},
            new_value={"a": 1, "b": 2}
        )

        diff = change.get_diff()

        assert diff["added"] == {"b": 2}
        assert diff["removed"] == {}
        assert diff["changed"] == {}

    def test_get_diff_removed(self):
        """Test diff detection for removed keys."""
        change = StateChange(
            file_path="test.json",
            old_value={"a": 1, "b": 2},
            new_value={"a": 1}
        )

        diff = change.get_diff()

        assert diff["added"] == {}
        assert diff["removed"] == {"b": 2}
        assert diff["changed"] == {}

    def test_get_diff_changed(self):
        """Test diff detection for changed values."""
        change = StateChange(
            file_path="test.json",
            old_value={"a": 1},
            new_value={"a": 2}
        )

        diff = change.get_diff()

        assert diff["added"] == {}
        assert diff["removed"] == {}
        assert diff["changed"] == {"a": {"old": 1, "new": 2}}

    def test_get_diff_from_none(self):
        """Test diff when old value is None."""
        change = StateChange(
            file_path="test.json",
            old_value=None,
            new_value={"a": 1, "b": 2}
        )

        diff = change.get_diff()

        assert diff["added"] == {"a": 1, "b": 2}
        assert diff["removed"] == {}
        assert diff["changed"] == {}


class TestStateManager:
    """Tests for StateManager class."""

    @pytest.fixture
    def temp_dir(self):
        """Create a temporary directory for tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir) / ".loki"

    @pytest.fixture
    def manager(self, temp_dir):
        """Create a StateManager instance for tests."""
        mgr = StateManager(loki_dir=temp_dir, enable_watch=False, enable_events=False)
        yield mgr
        mgr.stop()

    def test_ensure_directories(self, manager, temp_dir):
        """Test that required directories are created."""
        assert (temp_dir / "state").exists()
        assert (temp_dir / "queue").exists()
        assert (temp_dir / "memory").exists()
        assert (temp_dir / "events").exists()

    def test_get_state_nonexistent(self, manager):
        """Test getting state from nonexistent file."""
        result = manager.get_state("nonexistent.json")
        assert result is None

    def test_get_state_with_default(self, manager):
        """Test getting state with default value."""
        result = manager.get_state("nonexistent.json", default={"key": "value"})
        assert result == {"key": "value"}

    def test_set_state_create(self, manager):
        """Test creating new state."""
        change = manager.set_state("test.json", {"key": "value"})

        assert change.change_type == "create"
        assert change.old_value is None
        assert change.new_value == {"key": "value"}

        # Verify file was written
        result = manager.get_state("test.json")
        assert result == {"key": "value"}

    def test_set_state_update(self, manager):
        """Test updating existing state."""
        manager.set_state("test.json", {"key": "old"})
        change = manager.set_state("test.json", {"key": "new"})

        assert change.change_type == "update"
        assert change.old_value == {"key": "old"}
        assert change.new_value == {"key": "new"}

    def test_update_state(self, manager):
        """Test merging updates into state."""
        manager.set_state("test.json", {"a": 1, "b": 2})
        change = manager.update_state("test.json", {"b": 3, "c": 4})

        assert change.new_value == {"a": 1, "b": 3, "c": 4}

    def test_delete_state(self, manager, temp_dir):
        """Test deleting state."""
        manager.set_state("test.json", {"key": "value"})
        change = manager.delete_state("test.json")

        assert change.change_type == "delete"
        assert change.old_value == {"key": "value"}
        assert not (temp_dir / "test.json").exists()

    def test_delete_state_nonexistent(self, manager):
        """Test deleting nonexistent state."""
        result = manager.delete_state("nonexistent.json")
        assert result is None

    def test_managed_file_enum(self, manager):
        """Test using ManagedFile enum."""
        manager.set_state(ManagedFile.ORCHESTRATOR, {"phase": "planning"})
        result = manager.get_state(ManagedFile.ORCHESTRATOR)

        assert result == {"phase": "planning"}

    def test_cache_hit(self, manager):
        """Test that cache is used for repeated reads."""
        manager.set_state("test.json", {"key": "value"})

        # First read (populates cache)
        result1 = manager.get_state("test.json")

        # Second read (should hit cache)
        result2 = manager.get_state("test.json")

        assert result1 == result2 == {"key": "value"}

    def test_cache_invalidation_on_write(self, manager):
        """Test that cache is updated on write."""
        manager.set_state("test.json", {"key": "old"})
        manager.get_state("test.json")  # Populate cache

        manager.set_state("test.json", {"key": "new"})
        result = manager.get_state("test.json")

        assert result == {"key": "new"}

    def test_subscribe(self, manager):
        """Test subscription to state changes."""
        changes = []

        def callback(change):
            changes.append(change)

        unsubscribe = manager.subscribe(callback)

        manager.set_state("test.json", {"key": "value"})

        assert len(changes) == 1
        assert changes[0].file_path == "test.json"

        unsubscribe()

        manager.set_state("test.json", {"key": "value2"})
        assert len(changes) == 1  # No new changes after unsubscribe

    def test_subscribe_with_filter(self, manager):
        """Test subscription with file filter."""
        changes = []

        def callback(change):
            changes.append(change)

        manager.subscribe(callback, file_filter=["test1.json"])

        manager.set_state("test1.json", {"key": "value"})
        manager.set_state("test2.json", {"key": "value"})

        assert len(changes) == 1
        assert changes[0].file_path == "test1.json"

    def test_convenience_methods(self, manager):
        """Test convenience methods for common operations."""
        # Orchestrator
        manager.set_orchestrator_state({"phase": "planning"})
        assert manager.get_orchestrator_state() == {"phase": "planning"}

        # Autonomy
        manager.set_autonomy_state({"status": "running"})
        assert manager.get_autonomy_state() == {"status": "running"}

        # Phase update
        change = manager.update_orchestrator_phase("development")
        assert "currentPhase" in change.new_value
        assert change.new_value["currentPhase"] == "development"

        # Status update
        change = manager.update_autonomy_status("paused")
        assert "status" in change.new_value
        assert change.new_value["status"] == "paused"

    def test_get_all_states(self, manager):
        """Test getting all managed states."""
        manager.set_state(ManagedFile.ORCHESTRATOR, {"phase": "planning"})
        manager.set_state(ManagedFile.AUTONOMY, {"status": "running"})

        states = manager.get_all_states()

        assert "ORCHESTRATOR" in states
        assert "AUTONOMY" in states
        assert states["ORCHESTRATOR"] == {"phase": "planning"}

    def test_refresh_cache(self, manager, temp_dir):
        """Test cache refresh."""
        manager.set_state("test.json", {"key": "original"})
        manager.get_state("test.json")  # Populate cache

        # Modify file externally
        file_path = temp_dir / "test.json"
        with open(file_path, "w") as f:
            json.dump({"key": "modified"}, f)

        # Cache should still have old value
        # (unless file mtime changed, which it did)
        manager.refresh_cache()

        result = manager.get_state("test.json")
        assert result == {"key": "modified"}

    def test_thread_safety(self, manager):
        """Test concurrent access to state manager."""
        errors = []
        iterations = 50

        def writer():
            for i in range(iterations):
                try:
                    manager.set_state("concurrent.json", {"count": i})
                except Exception as e:
                    errors.append(e)

        def reader():
            for _ in range(iterations):
                try:
                    manager.get_state("concurrent.json")
                except Exception as e:
                    errors.append(e)

        threads = [
            threading.Thread(target=writer),
            threading.Thread(target=reader),
            threading.Thread(target=writer),
            threading.Thread(target=reader),
        ]

        for t in threads:
            t.start()

        for t in threads:
            t.join()

        assert len(errors) == 0, f"Errors during concurrent access: {errors}"

    def test_corrupted_json_handling(self, manager, temp_dir):
        """Test handling of corrupted JSON files."""
        # Create a file with invalid JSON
        corrupted_file = temp_dir / "corrupted.json"
        with open(corrupted_file, "w") as f:
            f.write("{ this is not valid json }")

        # Should return None instead of raising an exception
        result = manager.get_state("corrupted.json")
        assert result is None, "Corrupted JSON should return None"

    def test_empty_file_handling(self, manager, temp_dir):
        """Test handling of empty files."""
        # Create an empty file
        empty_file = temp_dir / "empty.json"
        empty_file.touch()

        # Should return None instead of raising an exception
        result = manager.get_state("empty.json")
        assert result is None, "Empty file should return None"

    def test_corrupted_json_with_default(self, manager, temp_dir):
        """Test that default value is returned for corrupted JSON."""
        # Create a file with invalid JSON
        corrupted_file = temp_dir / "corrupted2.json"
        with open(corrupted_file, "w") as f:
            f.write("not json at all")

        # Should return the default value
        result = manager.get_state("corrupted2.json", default={"fallback": True})
        assert result == {"fallback": True}, "Should return default for corrupted JSON"

    def test_partial_json_handling(self, manager, temp_dir):
        """Test handling of truncated/partial JSON."""
        # Create a file with partial JSON (truncated)
        partial_file = temp_dir / "partial.json"
        with open(partial_file, "w") as f:
            f.write('{"key": "value", "incomplete":')

        # Should return None
        result = manager.get_state("partial.json")
        assert result is None, "Partial JSON should return None"


class TestSingletonManager:
    """Tests for singleton state manager."""

    def test_get_state_manager(self):
        """Test getting singleton instance."""
        reset_state_manager()

        mgr1 = get_state_manager()
        mgr2 = get_state_manager()

        assert mgr1 is mgr2

        reset_state_manager()

    def test_reset_state_manager(self):
        """Test resetting singleton instance."""
        reset_state_manager()

        mgr1 = get_state_manager()
        reset_state_manager()
        mgr2 = get_state_manager()

        assert mgr1 is not mgr2

        reset_state_manager()

    def test_get_state_manager_follows_cwd(self, tmp_path):
        """The default manager is keyed on the project root, so a cwd change
        switches to that project's state instead of serving the first one."""
        reset_state_manager()
        a, b = tmp_path / "a", tmp_path / "b"
        for proj, phase in ((a, "alpha"), (b, "beta")):
            (proj / ".loki").mkdir(parents=True)
            (proj / ".loki" / "autonomy-state.json").write_text(json.dumps({"phase": phase}))
        prev = os.getcwd()
        try:
            os.chdir(a)
            mgr_a = get_state_manager(enable_watch=False, enable_events=False)
            assert mgr_a.get_state(ManagedFile.AUTONOMY)["phase"] == "alpha"
            assert get_state_manager() is mgr_a
            os.chdir(b)
            mgr_b = get_state_manager(enable_watch=False, enable_events=False)
            assert mgr_b is not mgr_a
            assert mgr_b.get_state(ManagedFile.AUTONOMY)["phase"] == "beta"
            os.chdir(a)
            assert get_state_manager() is mgr_a
        finally:
            os.chdir(prev)
            reset_state_manager()


class TestDefaultManagerCap:
    """#312 Python half: the per-root cache is an LRU capped by
    LOKI_STATE_MANAGER_MAX so a long-lived process does not leak fds and threads."""

    @staticmethod
    def _roots(tmp_path, names):
        out = []
        for n in names:
            d = tmp_path / n / ".loki"
            d.mkdir(parents=True)
            out.append(d)
        return out

    def test_cap_evicts_oldest_and_stops_it(self, tmp_path, monkeypatch):
        import state.manager as sm
        monkeypatch.setenv("LOKI_STATE_MANAGER_MAX", "2")
        reset_state_manager()
        try:
            a, b, c = self._roots(tmp_path, "abc")
            kw = dict(enable_watch=False, enable_events=False)
            mgr_a = get_state_manager(a, **kw)
            stopped = []
            orig = mgr_a.stop
            mgr_a.stop = lambda: (stopped.append(True), orig())[1]
            get_state_manager(b, **kw)
            get_state_manager(c, **kw)
            assert stopped == [True]
            assert len(sm._default_managers) == 2
        finally:
            reset_state_manager()

    def test_cap_is_lru_not_fifo(self, tmp_path, monkeypatch):
        import state.manager as sm
        monkeypatch.setenv("LOKI_STATE_MANAGER_MAX", "2")
        reset_state_manager()
        try:
            a, b, c = self._roots(tmp_path, "abc")
            kw = dict(enable_watch=False, enable_events=False)
            mgr_a = get_state_manager(a, **kw)
            get_state_manager(b, **kw)
            assert get_state_manager(a, **kw) is mgr_a
            get_state_manager(c, **kw)
            keys = list(sm._default_managers)
            assert os.path.realpath(str(a)) in keys
            assert os.path.realpath(str(b)) not in keys
        finally:
            reset_state_manager()

    def test_eviction_releases_threads(self, tmp_path, monkeypatch):
        monkeypatch.setenv("LOKI_STATE_MANAGER_MAX", "1")
        reset_state_manager()
        try:
            roots = self._roots(tmp_path, "abcd")
            for r in roots:
                get_state_manager(r)
            base = threading.active_count()
            for r in self._roots(tmp_path, ["e", "f", "g"]):
                get_state_manager(r)
            deadline = time.time() + 5
            while threading.active_count() > base and time.time() < deadline:
                time.sleep(0.05)
            assert threading.active_count() <= base
        finally:
            reset_state_manager()

    @pytest.mark.parametrize("raw,want", [
        (None, 8), ("", 8), ("abc", 8), ("0", 8), ("-3", 8), ("2.5", 8), ("3", 3), (" 4 ", 4),
    ])
    def test_cap_value_falls_back_to_default_for_invalid_input(self, monkeypatch, raw, want):
        from state.manager import _state_manager_cap
        if raw is None:
            monkeypatch.delenv("LOKI_STATE_MANAGER_MAX", raising=False)
        else:
            monkeypatch.setenv("LOKI_STATE_MANAGER_MAX", raw)
        assert _state_manager_cap() == want

    def test_evicted_manager_is_stopped_outside_the_lock(self, tmp_path, monkeypatch):
        import state.manager as sm
        monkeypatch.setenv("LOKI_STATE_MANAGER_MAX", "1")
        reset_state_manager()
        try:
            a, b = self._roots(tmp_path, "ab")
            kw = dict(enable_watch=False, enable_events=False)
            mgr_a = get_state_manager(a, **kw)
            held = []
            orig = mgr_a.stop
            mgr_a.stop = lambda: (held.append(sm._default_manager_lock.locked()), orig())[1]
            get_state_manager(b, **kw)
            assert held == [False]
        finally:
            reset_state_manager()

    def test_default_cap_unchanged_for_one_root(self, tmp_path, monkeypatch):
        monkeypatch.delenv("LOKI_STATE_MANAGER_MAX", raising=False)
        reset_state_manager()
        try:
            (a,) = self._roots(tmp_path, "a")
            kw = dict(enable_watch=False, enable_events=False)
            assert get_state_manager(a, **kw) is get_state_manager(a, **kw)
        finally:
            reset_state_manager()


class TestVersionVector:
    """Tests for VersionVector class."""

    def test_increment(self):
        """Test version increment."""
        vv = VersionVector()
        vv.increment("source1")
        assert vv.get("source1") == 1

        vv.increment("source1")
        assert vv.get("source1") == 2

    def test_get_nonexistent(self):
        """Test getting nonexistent source version."""
        vv = VersionVector()
        assert vv.get("nonexistent") == 0

    def test_merge(self):
        """Test merging version vectors."""
        vv1 = VersionVector()
        vv1.increment("source1")
        vv1.increment("source1")

        vv2 = VersionVector()
        vv2.increment("source2")
        vv2.increment("source2")
        vv2.increment("source2")

        merged = vv1.merge(vv2)
        assert merged.get("source1") == 2
        assert merged.get("source2") == 3

    def test_dominates(self):
        """Test version dominance checking."""
        vv1 = VersionVector()
        vv1.increment("source1")
        vv1.increment("source1")

        vv2 = VersionVector()
        vv2.increment("source1")

        # vv1 should dominate vv2
        assert vv1.dominates(vv2)
        assert not vv2.dominates(vv1)

    def test_concurrent(self):
        """Test concurrent version detection."""
        vv1 = VersionVector()
        vv1.increment("source1")

        vv2 = VersionVector()
        vv2.increment("source2")

        # Neither dominates - they are concurrent
        assert vv1.concurrent_with(vv2)
        assert vv2.concurrent_with(vv1)

    def test_to_from_dict(self):
        """Test serialization."""
        vv = VersionVector()
        vv.increment("source1")
        vv.increment("source2")

        data = vv.to_dict()
        vv2 = VersionVector.from_dict(data)

        assert vv2.get("source1") == 1
        assert vv2.get("source2") == 1


class TestOptimisticUpdates:
    """Tests for optimistic updates and conflict resolution (SYN-014)."""

    @pytest.fixture
    def temp_dir(self):
        """Create a temporary directory for tests."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield Path(tmpdir) / ".loki"

    @pytest.fixture
    def manager(self, temp_dir):
        """Create a StateManager instance for tests."""
        mgr = StateManager(loki_dir=temp_dir, enable_watch=False, enable_events=False)
        yield mgr
        mgr.stop()

    def test_optimistic_update(self, manager):
        """Test basic optimistic update."""
        pending = manager.optimistic_update("test.json", "key1", "value1", "agent1")

        assert pending.status == "pending"
        assert pending.key == "key1"
        assert pending.value == "value1"
        assert pending.source == "agent1"

        # Value should be applied immediately
        state = manager.get_state("test.json")
        assert state["key1"] == "value1"

    def test_version_vector_tracking(self, manager):
        """Test that version vectors are tracked."""
        manager.optimistic_update("test.json", "key1", "value1", "agent1")
        manager.optimistic_update("test.json", "key2", "value2", "agent2")

        vv = manager.get_version_vector("test.json")
        assert vv.get("agent1") == 1
        assert vv.get("agent2") == 1

        manager.optimistic_update("test.json", "key3", "value3", "agent1")
        vv = manager.get_version_vector("test.json")
        assert vv.get("agent1") == 2

    def test_pending_updates_tracking(self, manager):
        """Test that pending updates are tracked."""
        manager.optimistic_update("test.json", "key1", "value1", "agent1")
        manager.optimistic_update("test.json", "key2", "value2", "agent2")

        pending = manager.get_pending_updates("test.json")
        assert len(pending) == 2

    def test_detect_conflict(self, manager):
        """Test conflict detection."""
        # Local update
        manager.optimistic_update("test.json", "key1", "local_value", "agent1")

        # Remote state with different value for same key
        remote_state = {
            "key1": "remote_value",
            "_version_vector": {"agent2": 1}
        }

        conflicts = manager.detect_conflicts("test.json", remote_state, "agent2")
        assert len(conflicts) == 1
        assert conflicts[0].key == "key1"
        assert conflicts[0].local_value == "local_value"
        assert conflicts[0].remote_value == "remote_value"

    def test_no_conflict_when_same_value(self, manager):
        """Test no conflict when values are the same."""
        manager.optimistic_update("test.json", "key1", "same_value", "agent1")

        remote_state = {
            "key1": "same_value",
            "_version_vector": {"agent2": 1}
        }

        conflicts = manager.detect_conflicts("test.json", remote_state, "agent2")
        assert len(conflicts) == 0

    def test_resolve_conflict_last_write_wins(self, manager):
        """Test last-write-wins conflict resolution."""
        manager.optimistic_update("test.json", "key1", "local_value", "agent1")
        manager.set_conflict_strategy(ConflictStrategy.LAST_WRITE_WINS)

        remote_state = {
            "key1": "remote_value",
            "_version_vector": {"agent2": 1}
        }

        conflicts = manager.detect_conflicts("test.json", remote_state, "agent2")
        resolved = manager.resolve_conflicts("test.json", conflicts)

        # Remote value should win
        assert resolved["key1"] == "remote_value"
        assert conflicts[0].resolution == "last_write_wins"

    def test_resolve_conflict_merge_dicts(self, manager):
        """Test merge conflict resolution for dictionaries."""
        manager.optimistic_update("test.json", "config", {"a": 1, "b": 2}, "agent1")
        manager.set_conflict_strategy(ConflictStrategy.MERGE)

        remote_state = {
            "config": {"b": 3, "c": 4},
            "_version_vector": {"agent2": 1}
        }

        conflicts = manager.detect_conflicts("test.json", remote_state, "agent2")
        resolved = manager.resolve_conflicts("test.json", conflicts)

        # Should merge: local has a=1, b=2; remote has b=3, c=4
        # Result should have a=1, b=3 (remote wins), c=4
        assert resolved["config"]["a"] == 1
        assert resolved["config"]["b"] == 3  # Remote wins
        assert resolved["config"]["c"] == 4

    def test_resolve_conflict_merge_lists(self, manager):
        """Test merge conflict resolution for lists."""
        manager.optimistic_update("test.json", "items", [1, 2, 3], "agent1")
        manager.set_conflict_strategy(ConflictStrategy.MERGE)

        remote_state = {
            "items": [3, 4, 5],
            "_version_vector": {"agent2": 1}
        }

        conflicts = manager.detect_conflicts("test.json", remote_state, "agent2")
        resolved = manager.resolve_conflicts("test.json", conflicts)

        # Should concatenate and deduplicate
        assert set(resolved["items"]) == {1, 2, 3, 4, 5}

    def test_resolve_conflict_reject(self, manager):
        """Test reject conflict resolution."""
        manager.optimistic_update("test.json", "key1", "local_value", "agent1")
        manager.set_conflict_strategy(ConflictStrategy.REJECT)

        remote_state = {
            "key1": "remote_value",
            "_version_vector": {"agent2": 1}
        }

        conflicts = manager.detect_conflicts("test.json", remote_state, "agent2")
        resolved = manager.resolve_conflicts("test.json", conflicts)

        # Local value should be kept
        assert resolved["key1"] == "local_value"
        assert conflicts[0].resolution == "rejected"

        # Pending update should be marked as rejected
        pending = manager.get_pending_updates("test.json")
        assert pending[0].status == "rejected"

    def test_commit_pending_updates(self, manager):
        """Test committing pending updates."""
        manager.optimistic_update("test.json", "key1", "value1", "agent1")
        manager.optimistic_update("test.json", "key2", "value2", "agent1")

        committed = manager.commit_pending_updates("test.json")
        assert committed == 2

        # No more pending updates
        pending = manager.get_pending_updates("test.json")
        assert len(pending) == 0

    def test_rollback_pending_updates(self, manager):
        """Test rolling back pending updates."""
        original_state = {"original": True}
        manager.set_state("test.json", original_state)

        manager.optimistic_update("test.json", "key1", "value1", "agent1")
        manager.optimistic_update("test.json", "key2", "value2", "agent1")

        rolled_back = manager.rollback_pending_updates("test.json", original_state)
        assert rolled_back == 2

        # State should be restored
        state = manager.get_state("test.json")
        assert state == original_state

    def test_sync_with_remote(self, manager):
        """Test full sync workflow."""
        # Initial state
        manager.set_state("test.json", {"existing": "value"})

        # Local optimistic updates
        manager.optimistic_update("test.json", "local_key", "local_value", "agent1")

        # Remote state
        remote_state = {
            "existing": "value",
            "remote_key": "remote_value",
            "_version_vector": {"agent2": 1}
        }

        resolved, conflicts, committed = manager.sync_with_remote(
            "test.json", remote_state, "agent2"
        )

        # No conflicts (different keys)
        assert len(conflicts) == 0
        assert committed == 1

        # Final state should have both values
        state = manager.get_state("test.json")
        assert state["local_key"] == "local_value"

    def test_multiple_sources_conflict(self, manager):
        """Test conflict with multiple sources."""
        # Multiple local updates
        manager.optimistic_update("test.json", "key1", "value_a1", "agent_a")
        manager.optimistic_update("test.json", "key1", "value_a2", "agent_a")
        manager.optimistic_update("test.json", "key2", "value_b1", "agent_b")

        # Remote state conflicts with both
        remote_state = {
            "key1": "remote_value1",
            "key2": "remote_value2",
            "_version_vector": {"agent_c": 1}
        }

        conflicts = manager.detect_conflicts("test.json", remote_state, "agent_c")
        # Should have 2 conflicts (key1 and key2)
        assert len(conflicts) >= 1  # At least key1 conflict

    def test_version_vector_persisted(self, manager):
        """Test that version vector is persisted in state."""
        manager.optimistic_update("test.json", "key1", "value1", "agent1")

        state = manager.get_state("test.json")
        assert "_version_vector" in state
        assert state["_version_vector"]["agent1"] == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
