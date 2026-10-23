"""
tests/managed/test_providers_managed_mock.py

Phase 2 foundation: exercise providers/managed.py with FakeManagedClient +
FakeMultiagentSession. No live API calls. No anthropic SDK required at
import time (the SUT only imports anthropic lazily inside _build_client).

Covers:
    - run_council happy path with 3 fake agents returns 3 verdicts.
    - Timeout path: a session that never returns causes the overall
      budget to fire and the module to raise ManagedUnavailable while
      emitting a managed_agents_fallback event.
    - AttributeError containment: a client missing the
      beta.sessions namespace produces ManagedUnavailable.

These tests inject a fake client and a fake session factory via the
module's documented test hooks (_reset_client + _set_session_factory_for_tests).
They do NOT require ANTHROPIC_API_KEY and do NOT exercise the lazy
anthropic import.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


# Make the repo root importable when running the file directly.
_THIS = Path(__file__).resolve()
_ROOT = _THIS.parent.parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


# Enable both flags for the tests. Individual tests override as needed.
os.environ["LOKI_MANAGED_AGENTS"] = "true"
os.environ["LOKI_EXPERIMENTAL_MANAGED_AGENTS"] = "true"


# ---------------------------------------------------------------------------
# Fake multiagent session used by the DI hook in providers/managed.py
# ---------------------------------------------------------------------------


class FakeMultiagentSession:
    """Returns a scripted set of agent messages immediately."""

    def __init__(self, agent_ids, context, timeout_s, scripted_messages):
        self.agent_ids = agent_ids
        self.context = context
        self.timeout_s = timeout_s
        self._scripted = scripted_messages

    def run(self):
        return {
            "raw": {"messages": self._scripted},
            "session_id": "sess_fake_0001",
        }


class NeverReturningSession:
    """Blocks on an Event that nobody sets; used to exercise the budget timeout."""

    def __init__(self):
        self._evt = threading.Event()
        self.interrupted = False

    def run(self):
        # Will be killed by the daemon thread cleanup; we cap the wait at
        # 60s to avoid truly hanging CI if the budget check regresses.
        self._evt.wait(timeout=60.0)
        self.interrupted = True
        return {"raw": None, "session_id": None}


# ---------------------------------------------------------------------------
# Test suite
# ---------------------------------------------------------------------------


class ProvidersManagedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="loki-managed-providers-")
        os.environ["LOKI_TARGET_DIR"] = self.tmp
        # Re-assert env vars in setUp in case a prior test module stripped them.
        # providers.managed._flags_on() reads env fresh on every is_enabled() call.
        os.environ["LOKI_MANAGED_AGENTS"] = "true"
        os.environ["LOKI_EXPERIMENTAL_MANAGED_AGENTS"] = "true"

        # Seed the agent ID cache so resolve_agent_ids does not call the
        # real materialization path (which would require anthropic).
        cache_dir = Path(self.tmp) / ".loki" / "managed"
        cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_file = cache_dir / "agent_ids.json"
        with open(self.cache_file, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "reviewer-a": "agent_aaaa",
                    "reviewer-b": "agent_bbbb",
                    "reviewer-c": "agent_cccc",
                },
                f,
            )

        # Import fresh state so the module-level cached client is empty.
        from providers import managed as managed_mod

        self.managed = managed_mod
        self.managed._reset_client()
        # Install a sentinel "client" so _get_client() does not try to
        # import anthropic. The fake session factory ignores the client
        # argument anyway.
        self.managed._cached_client = object()
        # Patch the SDK-availability probe so is_enabled() returns True
        # without requiring anthropic to be pip-installed in CI.
        self._orig_sdk_probe = self.managed._sdk_available
        self.managed._sdk_available = lambda: True

    def tearDown(self) -> None:
        self.managed._set_session_factory_for_tests(None)
        self.managed._reset_client()
        self.managed._sdk_available = self._orig_sdk_probe

    # ---------- happy path --------------------------------------------------

    def test_run_council_happy_path_three_agents(self):
        scripted = [
            {
                "agent_id": "agent_aaaa",
                "text": "I APPROVE this change; tests look green.",
                "tool_confirmations": [],
            },
            {
                "agent_id": "agent_bbbb",
                "text": "REQUEST_CHANGES: the error handling is weak.",
                "tool_confirmations": [
                    {"tool_name": "code_search", "query": "try:"}
                ],
            },
            {
                "agent_id": "agent_cccc",
                "text": "APPROVE with nits.",
                "tool_confirmations": [],
            },
        ]
        self.managed._set_session_factory_for_tests(
            lambda client, *, agent_ids, context, timeout_s: FakeMultiagentSession(
                agent_ids, context, timeout_s, scripted
            )
        )

        result = self.managed.run_council(
            agent_pool=["reviewer-a", "reviewer-b", "reviewer-c"],
            context={"diff": "--- a\n+++ b\n@@"},
            timeout_s=10,
        )

        self.assertEqual(len(result.verdicts), 3)
        pool_to_verdict = {v.pool_name: v.verdict for v in result.verdicts}
        self.assertEqual(pool_to_verdict["reviewer-a"], "APPROVE")
        self.assertEqual(pool_to_verdict["reviewer-b"], "REQUEST_CHANGES")
        self.assertEqual(pool_to_verdict["reviewer-c"], "APPROVE")
        self.assertEqual(result.session_id, "sess_fake_0001")
        self.assertFalse(result.partial)
        self.assertEqual(len(result.tool_confirmations), 1)
        self.assertEqual(result.tool_confirmations[0].tool_name, "code_search")

        # Events: session_created and thread_created, no fallback.
        events = self._read_events()
        kinds = [e["type"] for e in events]
        self.assertIn("managed_session_created", kinds)
        self.assertIn("managed_session_thread_created", kinds)
        self.assertNotIn("managed_agents_fallback", kinds)

    # ---------- budget timeout ---------------------------------------------

    def test_run_council_budget_timeout_emits_fallback(self):
        self.managed._set_session_factory_for_tests(
            lambda client, *, agent_ids, context, timeout_s: NeverReturningSession()
        )

        t0 = time.monotonic()
        from providers.managed import ManagedUnavailable

        with self.assertRaises(ManagedUnavailable):
            self.managed.run_council(
                agent_pool=["reviewer-a", "reviewer-b", "reviewer-c"],
                context={"diff": "..."},
                timeout_s=1,  # 1s budget to keep the test fast
            )
        elapsed = time.monotonic() - t0
        # Budget should fire within ~2s regardless of the 60s safety cap.
        self.assertLess(elapsed, 5.0, f"budget fired too late: {elapsed}s")

        events = self._read_events()
        fb = [e for e in events if e["type"] == "managed_agents_fallback"]
        self.assertTrue(fb, f"expected a fallback event, got: {events}")
        self.assertEqual(fb[-1]["payload"].get("reason"), "overall_budget_timeout")

    # ---------- SDK shape error --------------------------------------------

    def test_run_council_shape_error_is_contained(self):
        class _NoSessions:
            # Intentionally lacks .beta; forces the real session factory to
            # raise ManagedUnavailable. We install this as the "client" and
            # DO NOT install a session factory override so the real
            # _RealMultiagentSession runs against _NoSessions().
            pass

        self.managed._cached_client = _NoSessions()
        self.managed._set_session_factory_for_tests(None)

        from providers.managed import ManagedUnavailable

        with self.assertRaises(ManagedUnavailable):
            self.managed.run_council(
                agent_pool=["reviewer-a"],
                context={"q": 1},
                timeout_s=5,
            )

        events = self._read_events()
        fb = [e for e in events if e["type"] == "managed_agents_fallback"]
        self.assertTrue(fb, "expected a fallback event on shape error")

    # ---------- completion council shape -----------------------------------

    def test_run_completion_council_majority(self):
        scripted = [
            {"agent_id": "agent_aaaa", "text": "STOP: we are done."},
            {"agent_id": "agent_bbbb", "text": "STOP: tests green."},
            {"agent_id": "agent_cccc", "text": "CONTINUE: still broken."},
        ]
        self.managed._set_session_factory_for_tests(
            lambda client, *, agent_ids, context, timeout_s: FakeMultiagentSession(
                agent_ids, context, timeout_s, scripted
            )
        )

        result = self.managed.run_completion_council(
            voters=["reviewer-a", "reviewer-b", "reviewer-c"],
            context={"iteration": 7},
            timeout_s=5,
        )

        self.assertEqual(result.majority, "STOP")
        self.assertEqual(len(result.votes), 3)

    # ---------- is_enabled probe -------------------------------------------

    def test_is_enabled_off_when_parent_flag_off(self):
        old = os.environ.get("LOKI_MANAGED_AGENTS")
        os.environ["LOKI_MANAGED_AGENTS"] = "false"
        try:
            self.assertFalse(self.managed.is_enabled())
        finally:
            # v7.0.2: unconditional restore. If old was None (var unset),
            # pop it back out; otherwise restore prior value. The previous
            # `if old is not None` left "false" lingering for later tests.
            if old is None:
                os.environ.pop("LOKI_MANAGED_AGENTS", None)
            else:
                os.environ["LOKI_MANAGED_AGENTS"] = old

    def test_is_enabled_off_when_umbrella_flag_off(self):
        old = os.environ.get("LOKI_EXPERIMENTAL_MANAGED_AGENTS")
        os.environ["LOKI_EXPERIMENTAL_MANAGED_AGENTS"] = "false"
        try:
            self.assertFalse(self.managed.is_enabled())
        finally:
            if old is None:
                os.environ.pop("LOKI_EXPERIMENTAL_MANAGED_AGENTS", None)
            else:
                os.environ["LOKI_EXPERIMENTAL_MANAGED_AGENTS"] = old

    # ---------- SDK 2.x session contract -----------------------------------

    def test_real_session_uses_2x_agent_environment_kwargs(self):
        from types import SimpleNamespace as NS

        calls = {}

        class _Ns:
            def __init__(self, name, ret):
                self._n, self._r = name, ret

            def create(self, **kw):
                calls[self._n] = kw
                return self._r

        class _Sessions(_Ns):
            events = NS(
                list=lambda sid: [
                    NS(type="agent.message", content=[NS(text="APPROVE")], session_thread_id="t1")
                ]
            )
            retrieve = staticmethod(lambda sid: NS(status="idle"))

        client = NS(
            beta=NS(
                agents=_Ns("agents", NS(id="agent_coord")),
                environments=_Ns("env", NS(id="env_1")),
                sessions=_Sessions("sessions", NS(id="sess_1", status="idle")),
            )
        )
        self.managed._set_session_factory_for_tests(None)
        out = self.managed._RealMultiagentSession(
            client=client, agent_ids=["agent_aaaa", "agent_bbbb"], context={"q": 1}, timeout_s=5
        ).run()

        kw = calls["sessions"]
        self.assertNotIn("callable_agents", kw)
        self.assertEqual(kw["agent"], {"type": "agent", "id": "agent_coord"})
        self.assertEqual(kw["environment_id"], "env_1")
        self.assertEqual(kw["initial_events"][0]["type"], "user.message")
        self.assertEqual(
            calls["agents"]["multiagent"],
            {"type": "coordinator", "agents": ["agent_aaaa", "agent_bbbb"]},
        )
        self.assertEqual(out["raw"][0]["text"], "APPROVE")
        # ids cached: a second run creates no new agent or environment
        calls.clear()
        self.managed._RealMultiagentSession(
            client=client, agent_ids=["agent_aaaa", "agent_bbbb"], context={}, timeout_s=5
        ).run()
        self.assertEqual(set(calls), {"sessions"})

        # the same kwargs must bind against the installed SDK's real signatures
        try:
            import anthropic
            import inspect
        except ImportError:
            return
        real = anthropic.Anthropic(api_key="test-key").beta
        inspect.signature(real.sessions.create).bind(**kw)
        inspect.signature(real.environments.create).bind(name="loki-council")
        inspect.signature(real.agents.create).bind(**calls.get("agents", {}) or {
            "name": "n", "model": "m", "system": "s",
            "multiagent": {"type": "coordinator", "agents": []},
        })

    # ---------- helpers -----------------------------------------------------

    def _read_events(self):
        path = Path(self.tmp) / ".loki" / "managed" / "events.ndjson"
        if not path.exists():
            return []
        with open(path, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]


if __name__ == "__main__":
    unittest.main()
