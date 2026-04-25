"""
tests/managed_memory/test_shadow_write_mock.py
v6.83.0 Phase 1: unit tests for the shadow-write path using FakeManagedClient.

Covers:
    - Envelope shape: store_id + logical path + sha256 precondition.
    - Happy path: memory_create is called once, success event is emitted.
    - 409 retry: on precondition mismatch the code re-reads + merges + retries.
    - Final failure: on a non-409 error the code emits a fallback event and
      returns False without raising.

These tests stub the ManagedClient singleton via memory.managed_memory.client.
They do NOT require an ANTHROPIC_API_KEY or network access.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path


# Enable flags for the duration of the test module. Individual tests override
# when they need to test the off path.
os.environ["LOKI_MANAGED_AGENTS"] = "true"
os.environ["LOKI_MANAGED_MEMORY"] = "true"


class _Boom(Exception):
    """Generic 500-like error used to simulate non-409 failures."""


class ShadowWriteTests(unittest.TestCase):
    def setUp(self):
        # Isolated target dir per test.
        self.tmp = tempfile.mkdtemp(prefix="loki-managed-")
        os.environ["LOKI_TARGET_DIR"] = self.tmp

        # Snapshot prior env state so tearDown can restore (None -> pop, value -> set).
        # Re-assert flags in setUp in case a prior test module stripped them.
        self._prev_managed_agents = os.environ.get("LOKI_MANAGED_AGENTS")
        self._prev_managed_memory = os.environ.get("LOKI_MANAGED_MEMORY")
        os.environ["LOKI_MANAGED_AGENTS"] = "true"
        os.environ["LOKI_MANAGED_MEMORY"] = "true"

        # Lazy-import after env setup so modules see the flags.
        from memory.managed_memory import client as _client_mod
        from memory.managed_memory.fakes import FakeManagedClient

        self._client_mod = _client_mod
        self.fake = FakeManagedClient()

        # Inject a fake singleton so shadow_write._get_client returns our fake.
        _client_mod._singleton = self.fake  # type: ignore[attr-defined]

    def tearDown(self):
        # Drop the fake singleton so other tests start clean.
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

    # ---------- envelope + happy path ---------------------------------------

    def _write_verdict_file(self, iteration: int, verdict: str) -> str:
        path = os.path.join(self.tmp, "verdict.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {"iteration": iteration, "verdict": verdict, "votes": [1, 1, 1]}, f
            )
        return path

    def test_happy_path_writes_envelope(self):
        from memory.managed_memory.shadow_write import shadow_write_verdict

        path = self._write_verdict_file(iteration=7, verdict="COMPLETE")
        ok = shadow_write_verdict(path)
        self.assertTrue(ok)

        # Fake recorded exactly one stores_get_or_create + one memory_create.
        kinds = [c["op"] for c in self.fake.calls]
        self.assertIn("stores_get_or_create", kinds)
        create_calls = [c for c in self.fake.calls if c["op"] == "memory_create"]
        self.assertEqual(len(create_calls), 1)
        call = create_calls[0]
        self.assertTrue(call["path"].startswith("verdicts/iteration-7"))
        self.assertIsNotNone(call["sha256_precondition"])
        self.assertEqual(
            len(call["sha256_precondition"]), 64, "sha256 hex length"
        )

        # Events file has one shadow_write record (no fallback).
        events = self._read_events()
        types = [e["type"] for e in events]
        self.assertIn("managed_memory_shadow_write", types)
        self.assertNotIn("managed_agents_fallback", types)

    # ---------- 409 precondition retry --------------------------------------

    def test_409_retry_merges_and_succeeds(self):
        from memory.managed_memory.shadow_write import shadow_write_verdict
        from memory.managed_memory.fakes import FakeManagedClient

        # Pre-seed the store with a conflicting verdict at the same path.
        store = self.fake.stores_get_or_create(
            name="loki-rarv-c-learnings", description="", scope="project"
        )
        sid = store["id"]
        self.fake.memory_create(
            store_id=sid,
            path="verdicts/iteration-9.json",
            content=json.dumps({"iteration": 9, "verdict": "CONTINUE"}),
            sha256_precondition=None,  # unconditional seed
        )
        self.fake.calls.clear()  # ignore seed calls

        path = self._write_verdict_file(iteration=9, verdict="COMPLETE")
        ok = shadow_write_verdict(path)
        self.assertTrue(ok, "after 409 retry-merge, write should succeed")

        # Expect at least two memory_create calls: initial (409) + retry.
        creates = [c for c in self.fake.calls if c["op"] == "memory_create"]
        self.assertGreaterEqual(len(creates), 2)

        events = self._read_events()
        sw_events = [e for e in events if e["type"] == "managed_memory_shadow_write"]
        self.assertTrue(
            any(e["payload"].get("merged") is True for e in sw_events),
            f"expected a merged=True shadow_write event, got {sw_events}",
        )

    # ---------- non-409 fallback --------------------------------------------

    def test_non_409_error_emits_fallback(self):
        from memory.managed_memory.shadow_write import shadow_write_verdict

        # Monkey-patch the fake's memory_create to raise a generic error.
        original = self.fake.memory_create

        def boom(*a, **kw):
            raise _Boom("simulated 500")

        self.fake.memory_create = boom  # type: ignore[assignment]

        try:
            path = self._write_verdict_file(iteration=11, verdict="COMPLETE")
            ok = shadow_write_verdict(path)
            self.assertFalse(ok, "should return False on non-409 error")
        finally:
            self.fake.memory_create = original  # type: ignore[assignment]

        events = self._read_events()
        fbs = [e for e in events if e["type"] == "managed_agents_fallback"]
        self.assertEqual(len(fbs), 1, f"expected 1 fallback event, got {fbs}")

    # ---------- disabled path ----------------------------------------------

    def test_disabled_flag_returns_false_and_no_calls(self):
        # Temporarily disable flags.
        old_p = os.environ.get("LOKI_MANAGED_AGENTS")
        old_c = os.environ.get("LOKI_MANAGED_MEMORY")
        os.environ["LOKI_MANAGED_AGENTS"] = "false"
        os.environ["LOKI_MANAGED_MEMORY"] = "false"
        try:
            from memory.managed_memory.shadow_write import shadow_write_verdict

            path = self._write_verdict_file(iteration=1, verdict="COMPLETE")
            ok = shadow_write_verdict(path)
            self.assertFalse(ok)
            # No fake calls recorded.
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

    # ---------- helpers -----------------------------------------------------

    def _read_events(self):
        path = Path(self.tmp) / ".loki" / "managed" / "events.ndjson"
        if not path.exists():
            return []
        with open(path, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]


if __name__ == "__main__":
    unittest.main()
