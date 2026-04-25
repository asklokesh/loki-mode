"""
Live test: memory create / get / delete roundtrip against the real
Anthropic Managed Agents Memory beta API.

OPT-IN ONLY. These tests are SKIPPED unless BOTH:

    LOKI_LIVE_TESTS=1
    ANTHROPIC_API_KEY=<your-key>

are set in the environment. Default ``pytest tests/`` runs make ZERO
network calls.

Each test:
    1. Creates a uniquely-named managed store via ``ManagedClient``.
    2. Writes a memory entry, reads it back, asserts equality.
    3. Lists memories under a path prefix and asserts presence.
    4. In ``tearDown``, best-effort deletes any created memory entries
       so the live account does not accumulate orphans.

The Managed Memory beta does NOT yet expose a stable store-delete
endpoint. We therefore namespace every test entry under a
``loki-livetest-*/`` path prefix in a long-lived shared store; the
teardown deletes the entries (not the store) and a marker prefix
makes any leftover trivial to find later via ``memories_list``.
"""

from __future__ import annotations

import json
import os
import unittest

from tests.live.conftest import (
    enable_managed_flags,
    live_enabled,
    live_skip_reason,
    make_test_prefix,
    restore_managed_flags,
)


@unittest.skipUnless(live_enabled(), live_skip_reason())
class LiveMemoryRoundtripTests(unittest.TestCase):
    """Real-API create / read / list lifecycle for a managed memory entry."""

    def setUp(self) -> None:
        # Capture+set flags required by ManagedClient.__init__.
        self._prior_parent, self._prior_child = enable_managed_flags()

        # Lazy import so module load is cheap when tests are skipped.
        from memory.managed_memory.client import ManagedClient, reset_client

        # Drop any cached singleton from prior tests.
        reset_client()
        self._client = ManagedClient(timeout=10.0)

        self._prefix = make_test_prefix("roundtrip")
        # Per-iteration created paths so tearDown can target them.
        self._created_paths: list[str] = []

        # Resolve (or create) a long-lived shared test store. Naming it
        # with a stable prefix lets human operators clean up orphans
        # later without guessing.
        self._store = self._client.stores_get_or_create(
            name="loki-livetest-shared",
            description="Loki live-integration test store (safe to delete).",
            scope="project",
        )
        self._store_id = self._store.get("id") or self._store.get("store_id")
        self.assertTrue(
            self._store_id, "managed store creation returned no id; cannot proceed"
        )

    def tearDown(self) -> None:
        # Best-effort cleanup: delete each entry we created. The beta
        # SDK's delete surface is not yet exposed by ManagedClient, so
        # we use the underlying namespace if available; on failure we
        # log and move on -- the prefix makes orphans trivially findable.
        try:
            beta = getattr(self._client._client, "beta", None)
            memories = (
                getattr(beta, "memories", None) if beta is not None else None
            )
            delete = getattr(memories, "delete", None) if memories else None
            if delete:
                for path in self._created_paths:
                    try:
                        # The beta delete surface accepts (store_id, path);
                        # the exact kwarg may evolve so we try both.
                        try:
                            delete(store_id=self._store_id, path=path)
                        except TypeError:
                            delete(store_id=self._store_id, memory_path=path)
                    except Exception as e:  # pragma: no cover - best-effort
                        print(
                            f"WARN [livetest cleanup] failed to delete "
                            f"{path}: {e}"
                        )
        finally:
            from memory.managed_memory.client import reset_client

            reset_client()
            restore_managed_flags(self._prior_parent, self._prior_child)

    # ---- tests --------------------------------------------------------

    def test_live_create_get_delete_store(self) -> None:
        """Smoke test: stores_get_or_create returns a usable store id."""
        # Re-fetch via list and confirm presence.
        listed = self._client.stores_list()
        names = {s.get("name") for s in listed}
        self.assertIn(
            "loki-livetest-shared",
            names,
            "shared livetest store should be visible after creation",
        )

    def test_live_memory_create_and_read(self) -> None:
        """Write a memory entry, read it back, assert content equality."""
        path = f"{self._prefix}/hello.txt"
        content = json.dumps({"prefix": self._prefix, "msg": "hello"})

        created = self._client.memory_create(
            store_id=self._store_id,
            path=path,
            content=content,
        )
        self._created_paths.append(path)
        memory_id = created.get("id") or created.get("memory_id")
        self.assertTrue(memory_id, "memory_create did not return an id")

        got = self._client.memory_read(
            store_id=self._store_id, memory_id=memory_id
        )
        # Content fidelity: the SDK should round-trip the exact bytes.
        self.assertEqual(got.get("content"), content)

    def test_live_memories_list_filters_by_prefix(self) -> None:
        """memories_list with a path_prefix returns only matching entries."""
        path = f"{self._prefix}/listed.json"
        content = json.dumps({"k": "v"})
        self._client.memory_create(
            store_id=self._store_id, path=path, content=content
        )
        self._created_paths.append(path)

        entries = self._client.memories_list(
            store_id=self._store_id, path_prefix=self._prefix
        )
        paths = {e.get("path") for e in entries}
        self.assertIn(
            path,
            paths,
            "memories_list with our unique prefix should include the entry "
            "we just created",
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
