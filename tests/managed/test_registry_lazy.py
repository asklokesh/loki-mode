"""
tests/managed/test_registry_lazy.py

Asserts the agents.managed_registry module is lazy:

    1. Importing the module does NOT create the agent_ids.json cache file.
    2. _load_cache() on a fresh tree returns {} and does NOT create the
       cache file either.
    3. materialize_agent() only writes the cache on first create, and
       subsequent calls hit the in-memory cache and do NOT rewrite it.
    4. The module does NOT import anthropic at import time; it only
       touches the SDK via providers.managed._get_client which is itself
       lazy.

These tests monkey-patch providers.managed._get_client to a fake that
returns a stub with a beta.agents.create surface. They do NOT import
anthropic.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


_THIS = Path(__file__).resolve()
_ROOT = _THIS.parent.parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


os.environ["LOKI_MANAGED_AGENTS"] = "true"
os.environ["LOKI_EXPERIMENTAL_MANAGED_AGENTS"] = "true"


class _FakeAgents:
    def __init__(self):
        self.create_calls = []

    def create(self, name, system, metadata):  # noqa: D401 - SDK shape
        self.create_calls.append(
            {"name": name, "system": system, "metadata": metadata}
        )
        pool = metadata.get("loki_pool") if isinstance(metadata, dict) else "unknown"
        return {"id": f"agent_{pool}_fake"}


class _FakeBeta:
    def __init__(self):
        self.agents = _FakeAgents()


class _FakeClient:
    def __init__(self):
        self.beta = _FakeBeta()


class RegistryLazinessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="loki-registry-")
        os.environ["LOKI_TARGET_DIR"] = self.tmp
        # Snapshot prior env state so tearDown can restore (None -> pop, value -> set).
        # Re-assert flags in setUp in case a prior test module stripped them;
        # providers.managed._flags_on() reads env fresh on every is_enabled() call.
        self._prev_managed_agents = os.environ.get("LOKI_MANAGED_AGENTS")
        self._prev_experimental = os.environ.get("LOKI_EXPERIMENTAL_MANAGED_AGENTS")
        os.environ["LOKI_MANAGED_AGENTS"] = "true"
        os.environ["LOKI_EXPERIMENTAL_MANAGED_AGENTS"] = "true"

    def tearDown(self) -> None:
        # v7.0.2: unconditional restore (None -> pop, value -> set).
        if self._prev_managed_agents is None:
            os.environ.pop("LOKI_MANAGED_AGENTS", None)
        else:
            os.environ["LOKI_MANAGED_AGENTS"] = self._prev_managed_agents
        if self._prev_experimental is None:
            os.environ.pop("LOKI_EXPERIMENTAL_MANAGED_AGENTS", None)
        else:
            os.environ["LOKI_EXPERIMENTAL_MANAGED_AGENTS"] = self._prev_experimental

    # ---------- invariant 1: module import is cold --------------------------

    def test_import_does_not_touch_cache(self):
        # Fresh import of agents.managed_registry must not create the cache.
        import importlib

        # Drop any cached copy.
        if "agents.managed_registry" in sys.modules:
            del sys.modules["agents.managed_registry"]

        import agents.managed_registry as reg  # noqa: F401 - import side-effects

        importlib.reload(reg)

        cache_path = Path(self.tmp) / ".loki" / "managed" / "agent_ids.json"
        self.assertFalse(
            cache_path.exists(),
            "importing managed_registry must not create the cache file",
        )

    def test_import_does_not_import_anthropic(self):
        # Drop anthropic from sys.modules (if present) and verify the
        # registry import does not bring it back.
        sys.modules.pop("anthropic", None)
        if "agents.managed_registry" in sys.modules:
            del sys.modules["agents.managed_registry"]
        import importlib

        import agents.managed_registry as reg

        importlib.reload(reg)
        self.assertNotIn(
            "anthropic",
            sys.modules,
            "registry import must not eagerly import the anthropic SDK",
        )

    # ---------- invariant 2: load_cache is read-only on miss ----------------

    def test_load_cache_on_empty_returns_empty_and_does_not_write(self):
        from agents.managed_registry import _load_cache

        cache = _load_cache()
        self.assertEqual(cache, {})
        cache_path = Path(self.tmp) / ".loki" / "managed" / "agent_ids.json"
        self.assertFalse(cache_path.exists())

    # ---------- invariant 3: materialize writes exactly once ----------------

    def test_materialize_writes_cache_once(self):
        # Inject a fake client into providers.managed so registry._call_create_agent
        # does not need the real SDK.
        from providers import managed as managed_mod

        managed_mod._reset_client()
        managed_mod._cached_client = _FakeClient()

        from agents.managed_registry import materialize_agent

        cache_path = Path(self.tmp) / ".loki" / "managed" / "agent_ids.json"
        self.assertFalse(cache_path.exists(), "pre-condition: no cache")

        first = materialize_agent("reviewer-a")
        self.assertTrue(cache_path.exists(), "cache should exist after first call")
        with open(cache_path, "r", encoding="utf-8") as f:
            cache_v1 = json.load(f)
        self.assertEqual(cache_v1, {"reviewer-a": first})

        # Second call on SAME pool: hit cache, no SDK call, no rewrite.
        fake_agents = managed_mod._cached_client.beta.agents
        before_calls = len(fake_agents.create_calls)
        first_mtime = cache_path.stat().st_mtime_ns
        second = materialize_agent("reviewer-a")
        self.assertEqual(first, second)
        self.assertEqual(
            len(fake_agents.create_calls),
            before_calls,
            "cache hit must not trigger an SDK create",
        )
        self.assertEqual(
            cache_path.stat().st_mtime_ns,
            first_mtime,
            "cache hit must not rewrite the cache file",
        )

        # Third call on a NEW pool: rewrite once.
        third = materialize_agent("reviewer-b")
        self.assertNotEqual(first, third)
        with open(cache_path, "r", encoding="utf-8") as f:
            cache_v2 = json.load(f)
        self.assertEqual(cache_v2, {"reviewer-a": first, "reviewer-b": third})

        # Cleanup
        managed_mod._reset_client()


if __name__ == "__main__":
    unittest.main()
