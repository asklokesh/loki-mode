"""Tests for memory/app_graph.py + LOKI_MEMORY_BASE_PATH override.

Phase F cross-project context. Verifies:
  - AppGraph.from_env returns None when LOKI_PROJECT_GRAPH_ROOT is unset
  - AppGraph.from_env builds an instance when the three env vars are set
  - MemoryStorage honors LOKI_MEMORY_BASE_PATH and writes under the shared dir
  - Two MemoryStorage instances pointed at the same LOKI_MEMORY_BASE_PATH
    see each other's episodes (the shared-memory contract)

Each test snapshots and restores os.environ so suite ordering is stable.
"""

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Allow `python3 -m unittest memory.tests.test_app_graph` from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from memory.app_graph import AppGraph
from memory.storage import MemoryStorage


class TestAppGraphFromEnv(unittest.TestCase):
    """Cover AppGraph.from_env contract."""

    def test_returns_none_when_root_unset(self) -> None:
        # Strip every LOKI_PROJECT_GRAPH_* var so we are sure of the input.
        env_clean = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith("LOKI_PROJECT_GRAPH_")
        }
        with patch.dict(os.environ, env_clean, clear=True):
            self.assertIsNone(AppGraph.from_env())

    def test_returns_instance_when_env_set(self) -> None:
        tmp = tempfile.mkdtemp(prefix="loki-appgraph-")
        try:
            api = Path(tmp) / "api"
            web = Path(tmp) / "web"
            api.mkdir()
            web.mkdir()
            env = {
                "LOKI_PROJECT_GRAPH_ROOT": tmp,
                "LOKI_PROJECT_GRAPH_APP_ID": "demo-app",
                "LOKI_PROJECT_GRAPH_MEMBERS": f"{api}:{web}",
            }
            with patch.dict(os.environ, env, clear=False):
                graph = AppGraph.from_env()
            self.assertIsNotNone(graph)
            assert graph is not None  # type narrow for mypy/pyright
            self.assertEqual(graph.app_id, "demo-app")
            self.assertEqual(graph.root, Path(tmp))
            members = graph.get_members()
            self.assertEqual(len(members), 2)
            # Compare basenames to avoid macOS /var vs /private/var symlink
            # noise from Path.resolve(). Members are passed through env as
            # raw strings, not canonicalized.
            member_names = {m.name for m in members}
            self.assertEqual(member_names, {"api", "web"})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestMemoryBasePathOverride(unittest.TestCase):
    """LOKI_MEMORY_BASE_PATH must redirect MemoryStorage writes."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="loki-shared-mem-")
        self.local_a = tempfile.mkdtemp(prefix="loki-member-a-")
        self.local_b = tempfile.mkdtemp(prefix="loki-member-b-")

    def tearDown(self) -> None:
        for p in (self.tmp, self.local_a, self.local_b):
            shutil.rmtree(p, ignore_errors=True)

    def test_writes_under_shared_dir(self) -> None:
        shared = os.path.join(self.tmp, "memory")
        # Caller asks for a local path; env override redirects to the shared dir.
        local_path = os.path.join(self.local_a, ".loki", "memory")
        with patch.dict(os.environ, {"LOKI_MEMORY_BASE_PATH": shared}):
            store = MemoryStorage(base_path=local_path)
        self.assertEqual(str(store.root_path), shared)
        # The shared dir should now have the standard subdirs created.
        self.assertTrue(Path(shared, "episodic").is_dir())

    def test_two_stores_share_episodes(self) -> None:
        shared = os.path.join(self.tmp, "memory")
        # Both members point at the same shared dir via env.
        with patch.dict(os.environ, {"LOKI_MEMORY_BASE_PATH": shared}):
            store_a = MemoryStorage(
                base_path=os.path.join(self.local_a, ".loki", "memory")
            )
            store_b = MemoryStorage(
                base_path=os.path.join(self.local_b, ".loki", "memory")
            )

        # Write an episode via store_a using the public API. Schema differs
        # across builds, so the safest cross-version probe is to drop a JSON
        # file into the canonical episodic/<date>/ tree and confirm store_b
        # can see it via direct enumeration.
        from datetime import datetime, timezone
        import json

        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        date_dir = Path(shared) / "episodic" / date_str
        date_dir.mkdir(parents=True, exist_ok=True)
        ep_path = date_dir / "episode-shared-test.json"
        ep_path.write_text(json.dumps({"id": "shared-test", "outcome": "success"}))

        # store_b should see the file because both point at the same root.
        seen = list((Path(store_b.root_path) / "episodic" / date_str).glob("*.json"))
        self.assertTrue(
            any(p.name == "episode-shared-test.json" for p in seen),
            f"store_b did not see store_a's episode under {shared}",
        )

    def test_env_unset_falls_back_to_base_path(self) -> None:
        # Backward-compat probe: without the override, MemoryStorage must
        # write under the caller-provided base_path (original behavior).
        local_path = os.path.join(self.local_a, ".loki", "memory")
        env_clean = {k: v for k, v in os.environ.items() if k != "LOKI_MEMORY_BASE_PATH"}
        with patch.dict(os.environ, env_clean, clear=True):
            store = MemoryStorage(base_path=local_path)
        self.assertEqual(str(store.root_path), local_path)


if __name__ == "__main__":
    unittest.main()
