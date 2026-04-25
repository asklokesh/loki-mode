"""
tests/managed_memory/test_retrieve_mock.py
v6.83.0 Phase 1: unit tests for the retrieve path using FakeManagedClient.

Covers:
    - retrieve_related_verdicts returns summarized hits.
    - retrieve_related_verdicts emits a managed_memory_retrieve event.
    - hydrate_patterns merges new patterns into patterns.json without clobbering
      locally-present ids.
    - Disabled flags => [] / 0 merges and no calls.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path


os.environ["LOKI_MANAGED_AGENTS"] = "true"
os.environ["LOKI_MANAGED_MEMORY"] = "true"


class RetrieveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-managed-retrieve-")
        os.environ["LOKI_TARGET_DIR"] = self.tmp

        # Snapshot prior env state so tearDown can restore (None -> pop, value -> set).
        # Re-assert flags in setUp in case a prior test module stripped them.
        self._prev_managed_agents = os.environ.get("LOKI_MANAGED_AGENTS")
        self._prev_managed_memory = os.environ.get("LOKI_MANAGED_MEMORY")
        os.environ["LOKI_MANAGED_AGENTS"] = "true"
        os.environ["LOKI_MANAGED_MEMORY"] = "true"

        from memory.managed_memory import client as _client_mod
        from memory.managed_memory.fakes import FakeManagedClient

        self._client_mod = _client_mod
        self.fake = FakeManagedClient()
        _client_mod._singleton = self.fake  # type: ignore[attr-defined]

    def tearDown(self):
        self._client_mod.reset_client()
        # v7.0.2: unconditional restore (None -> pop, value -> set).
        if self._prev_managed_agents is None:
            os.environ.pop("LOKI_MANAGED_AGENTS", None)
        else:
            os.environ["LOKI_MANAGED_AGENTS"] = self._prev_managed_agents
        if self._prev_managed_memory is None:
            os.environ.pop("LOKI_MANAGED_MEMORY", None)
        else:
            os.environ["LOKI_MANAGED_MEMORY"] = self._prev_managed_memory

    def _seed_verdicts(self):
        store = self.fake.stores_get_or_create(
            name="loki-rarv-c-learnings", description="", scope="project"
        )
        sid = store["id"]
        self.fake.memory_create(
            store_id=sid,
            path="verdicts/iteration-1.json",
            content=json.dumps(
                {"iteration": 1, "verdict": "CONTINUE", "note": "tests failing"}
            ),
        )
        self.fake.memory_create(
            store_id=sid,
            path="verdicts/iteration-2.json",
            content=json.dumps(
                {"iteration": 2, "verdict": "COMPLETE", "note": "tests pass"}
            ),
        )
        return sid

    def test_retrieve_returns_summarized_hits(self):
        from memory.managed_memory.retrieve import retrieve_related_verdicts

        self._seed_verdicts()
        results = retrieve_related_verdicts("tests pass deployed", top_k=3)
        self.assertIsInstance(results, list)
        self.assertGreater(len(results), 0)
        top = results[0]
        self.assertIn("path", top)
        self.assertIn("content_summary", top)

        events = self._read_events()
        self.assertTrue(
            any(e["type"] == "managed_memory_retrieve" for e in events),
            f"expected a managed_memory_retrieve event; got: {[e['type'] for e in events]}",
        )

    def test_hydrate_merges_new_patterns_only(self):
        from memory.managed_memory.retrieve import hydrate_patterns

        store = self.fake.stores_get_or_create(
            name="loki-rarv-c-learnings", description="", scope="project"
        )
        sid = store["id"]
        # Seed 2 remote patterns.
        self.fake.memory_create(
            store_id=sid,
            path="patterns/p-remote-1.json",
            content=json.dumps({"pattern_id": "p-remote-1", "body": "remote1"}),
        )
        self.fake.memory_create(
            store_id=sid,
            path="patterns/p-shared.json",
            content=json.dumps(
                {"pattern_id": "p-shared", "body": "REMOTE-VERSION"}
            ),
        )

        # Seed a local patterns.json with one overlapping id.
        local_file = Path(self.tmp) / ".loki" / "memory" / "semantic" / "patterns.json"
        local_file.parent.mkdir(parents=True, exist_ok=True)
        local_doc = {
            "patterns": {
                "p-shared": {"pattern_id": "p-shared", "body": "LOCAL-VERSION"}
            }
        }
        with open(local_file, "w", encoding="utf-8") as f:
            json.dump(local_doc, f)

        merged = hydrate_patterns(local_mtime_floor=0.0, target_dir=self.tmp)
        self.assertGreaterEqual(merged, 1)

        with open(local_file, "r", encoding="utf-8") as f:
            final = json.load(f)
        self.assertIn("p-remote-1", final["patterns"])
        # Local wins on duplicate ids (Phase 1 policy).
        self.assertEqual(
            final["patterns"]["p-shared"]["body"], "LOCAL-VERSION"
        )

    def test_disabled_flags_returns_empty(self):
        old_p = os.environ.get("LOKI_MANAGED_AGENTS")
        old_c = os.environ.get("LOKI_MANAGED_MEMORY")
        os.environ["LOKI_MANAGED_AGENTS"] = "false"
        os.environ["LOKI_MANAGED_MEMORY"] = "false"
        try:
            from memory.managed_memory.retrieve import (
                retrieve_related_verdicts,
                hydrate_patterns,
            )

            self.assertEqual(retrieve_related_verdicts("anything"), [])
            self.assertEqual(hydrate_patterns(0.0, target_dir=self.tmp), 0)
            self.assertEqual(self.fake.calls, [])
        finally:
            # v7.0.2: unconditional restore (None -> pop, value -> set).
            if old_p is None:
                os.environ.pop("LOKI_MANAGED_AGENTS", None)
            else:
                os.environ["LOKI_MANAGED_AGENTS"] = old_p
            if old_c is None:
                os.environ.pop("LOKI_MANAGED_MEMORY", None)
            else:
                os.environ["LOKI_MANAGED_MEMORY"] = old_c

    def _read_events(self):
        path = Path(self.tmp) / ".loki" / "managed" / "events.ndjson"
        if not path.exists():
            return []
        with open(path, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]


if __name__ == "__main__":
    unittest.main()
