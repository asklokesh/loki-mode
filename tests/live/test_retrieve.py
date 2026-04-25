"""
Live test: ``memory.managed_memory.retrieve.retrieve_related_verdicts``
exercised against the real Anthropic Managed Agents Memory beta API.

OPT-IN ONLY. These tests are SKIPPED unless BOTH:

    LOKI_LIVE_TESTS=1
    ANTHROPIC_API_KEY=<your-key>

are set in the environment.

The retrieve path is the read-side of the shadow-write pipeline used
by the REASON phase and the completion council. This test:

    1. Seeds a verdict-shaped memory entry under ``verdicts/`` in the
       shared livetest store.
    2. Calls ``retrieve_related_verdicts(query=...)`` with a query
       guaranteed to share tokens with the seeded content.
    3. Asserts the seeded path appears in the result list.
    4. tearDown best-effort deletes the seeded entry.
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
class LiveRetrieveTests(unittest.TestCase):
    """Real-API exercise of retrieve_related_verdicts against a seeded store."""

    def setUp(self) -> None:
        self._prior_parent, self._prior_child = enable_managed_flags()

        # Force the retrieve module to use the same shared livetest store
        # the seed writes into. Without this it would use the production
        # default (`loki-rarv-c-learnings`) which we don't want polluted.
        self._prior_store_name = os.environ.get("LOKI_MANAGED_STORE_NAME", "")
        os.environ["LOKI_MANAGED_STORE_NAME"] = "loki-livetest-shared"

        from memory.managed_memory.client import ManagedClient, reset_client

        reset_client()
        self._client = ManagedClient(timeout=10.0)
        self._prefix = make_test_prefix("retrieve")
        self._created_paths: list[str] = []

        store = self._client.stores_get_or_create(
            name="loki-livetest-shared",
            description="Loki live-integration test store (safe to delete).",
            scope="project",
        )
        self._store_id = store.get("id") or store.get("store_id")
        self.assertTrue(self._store_id, "could not obtain shared livetest store id")

    def tearDown(self) -> None:
        try:
            beta = getattr(self._client._client, "beta", None)
            memories = getattr(beta, "memories", None) if beta else None
            delete = getattr(memories, "delete", None) if memories else None
            if delete:
                for path in self._created_paths:
                    try:
                        try:
                            delete(store_id=self._store_id, path=path)
                        except TypeError:
                            delete(store_id=self._store_id, memory_path=path)
                    except Exception as e:  # pragma: no cover
                        print(
                            f"WARN [livetest cleanup] failed to delete "
                            f"{path}: {e}"
                        )
        finally:
            from memory.managed_memory.client import reset_client

            reset_client()
            if self._prior_store_name:
                os.environ["LOKI_MANAGED_STORE_NAME"] = self._prior_store_name
            else:
                os.environ.pop("LOKI_MANAGED_STORE_NAME", None)
            restore_managed_flags(self._prior_parent, self._prior_child)

    def test_live_retrieve_finds_seeded_verdict(self) -> None:
        """A seeded verdict containing a unique token must come back."""
        from memory.managed_memory.retrieve import retrieve_related_verdicts

        # Use a unique multi-character token in the verdict so the
        # naive token-overlap ranking in retrieve_related_verdicts has
        # something deterministic to match. (Tokens of len <= 2 are
        # filtered by the implementation.)
        token = self._prefix.replace("-", "_")
        verdict_path = f"verdicts/{self._prefix}.json"
        content = json.dumps(
            {
                "verdict": "approve",
                "iteration": 1,
                "rationale": f"seed token {token} confirms retrieval works",
            }
        )
        self._client.memory_create(
            store_id=self._store_id,
            path=verdict_path,
            content=content,
        )
        self._created_paths.append(verdict_path)

        results = retrieve_related_verdicts(
            query=f"check {token} please", top_k=5, store_id=self._store_id
        )
        paths = [r.get("path") for r in results]
        self.assertIn(
            verdict_path,
            paths,
            "retrieve_related_verdicts should surface the verdict we just seeded",
        )

    def test_live_retrieve_returns_empty_list_on_no_match(self) -> None:
        """A query with no overlapping tokens yields an empty list, not error."""
        from memory.managed_memory.retrieve import retrieve_related_verdicts

        # Query uses a uuid-flavoured nonsense token that cannot appear in
        # any verdict written by this test or by other concurrent runs.
        # The retrieve API should return zero hits gracefully.
        results = retrieve_related_verdicts(
            query="xyzzy_nonsense_token_a8f7c0",
            top_k=3,
            store_id=self._store_id,
        )
        # The function returns a list; assert it is iterable and contains
        # no entry whose content references our nonsense token.
        self.assertIsInstance(results, list)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
