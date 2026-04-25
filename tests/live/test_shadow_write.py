"""
Live test: ``memory.managed_memory.shadow_write`` end-to-end against
the real Anthropic Managed Agents Memory beta API.

OPT-IN ONLY. These tests are SKIPPED unless BOTH:

    LOKI_LIVE_TESTS=1
    ANTHROPIC_API_KEY=<your-key>

are set in the environment.

This test exercises the WRITE side of the RARV-C learnings pipeline
by calling ``shadow_write_pattern`` and ``shadow_write_verdict``
with payloads tagged by a unique livetest prefix, then verifying the
data is reachable on the server via ``ManagedClient.memories_list``.

The shadow_write functions never raise to the caller; they return a
boolean. We therefore assert the boolean return and confirm the
server-side write via a follow-up read.

tearDown best-effort deletes the entries this test created so the
live account does not accumulate orphans across runs.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from tests.live.conftest import (
    enable_managed_flags,
    live_enabled,
    live_skip_reason,
    make_test_prefix,
    restore_managed_flags,
)


@unittest.skipUnless(live_enabled(), live_skip_reason())
class LiveShadowWriteTests(unittest.TestCase):
    """Real-API exercise of the shadow-write public entry points."""

    def setUp(self) -> None:
        self._prior_parent, self._prior_child = enable_managed_flags()

        # Pin the shadow_write module to the shared livetest store so we
        # do not write into the production `loki-rarv-c-learnings` store.
        self._prior_store_name = os.environ.get("LOKI_MANAGED_STORE_NAME", "")
        os.environ["LOKI_MANAGED_STORE_NAME"] = "loki-livetest-shared"

        from memory.managed_memory.client import ManagedClient, reset_client

        reset_client()
        self._client = ManagedClient(timeout=10.0)
        self._prefix = make_test_prefix("shadow")
        self._created_paths: list[str] = []
        self._tmp_files: list[str] = []

        store = self._client.stores_get_or_create(
            name="loki-livetest-shared",
            description="Loki live-integration test store (safe to delete).",
            scope="project",
        )
        self._store_id = store.get("id") or store.get("store_id")
        self.assertTrue(self._store_id, "could not obtain shared livetest store id")

    def tearDown(self) -> None:
        # Remove any tempfiles we wrote for verdict input.
        for f in self._tmp_files:
            try:
                os.unlink(f)
            except OSError:
                pass

        # Best-effort delete of remote entries.
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

    # ---- tests --------------------------------------------------------

    def test_live_shadow_write_pattern_returns_true_and_persists(self) -> None:
        """shadow_write_pattern should return True and the entry should be readable."""
        from memory.managed_memory.shadow_write import shadow_write_pattern

        pid = f"{self._prefix}-pat"
        pattern = {
            "pattern_id": pid,
            "name": "livetest pattern",
            "importance": 0.9,
            "summary": "seeded by live test_shadow_write",
        }
        ok = shadow_write_pattern(pattern)
        self.assertTrue(
            ok,
            "shadow_write_pattern returned False against a live API; the "
            "pipeline should succeed when flags + API key are set",
        )

        logical_path = f"patterns/{pid}.json"
        self._created_paths.append(logical_path)

        # Verify server-side via list.
        entries = self._client.memories_list(
            store_id=self._store_id, path_prefix=f"patterns/{self._prefix}"
        )
        paths = {e.get("path") for e in entries}
        self.assertIn(logical_path, paths)

    def test_live_shadow_write_verdict_persists_iteration_path(self) -> None:
        """shadow_write_verdict should write to verdicts/iteration-N.json."""
        from memory.managed_memory.shadow_write import shadow_write_verdict

        # Use an iteration value containing our unique prefix so the
        # logical path is unambiguously ours and easy to clean up.
        iteration = f"{self._prefix}-1"
        payload = {
            "iteration": iteration,
            "verdict": "approve",
            "rationale": "seeded by live test_shadow_write",
        }

        # shadow_write_verdict reads the verdict from a file path on disk.
        fd, tmp_path = tempfile.mkstemp(suffix=".json", prefix="livetest-verdict-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            self._tmp_files.append(tmp_path)

            ok = shadow_write_verdict(tmp_path)
            self.assertTrue(
                ok,
                "shadow_write_verdict returned False against a live API",
            )
        except Exception:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            raise

        logical_path = f"verdicts/iteration-{iteration}.json"
        self._created_paths.append(logical_path)

        entries = self._client.memories_list(
            store_id=self._store_id, path_prefix=f"verdicts/iteration-{self._prefix}"
        )
        paths = {e.get("path") for e in entries}
        self.assertIn(logical_path, paths)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
