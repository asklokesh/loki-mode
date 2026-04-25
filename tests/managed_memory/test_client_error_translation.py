"""
tests/managed_memory/test_client_error_translation.py
v7.1.0 T3: SDK error translation in ManagedClient.

The ManagedClient is the only file that imports the anthropic SDK. When the
SDK raises any Exception during a network call, the client wrapper MUST
translate it to ManagedDisabled with chained context (`raise ... from e`)
so that:
    - callers have a single exception type to handle (no anthropic.* leakage)
    - the original exception is preserved on `__cause__` for debuggability
    - the original message is included in the new message

This file injects a fake SDK that raises on every wrapped method
(`stores.list`, `stores.create`, `memories.create`, `memories.retrieve`,
`memories.list`) and asserts ManagedDisabled is raised with a chained cause
in each case.

Sibling concerns covered:
    - The wrapper does NOT swallow ManagedDisabled raised internally
      (e.g. from the SDK-availability checks earlier in the method).
"""

from __future__ import annotations

import unittest

from memory.managed_memory import ManagedDisabled
from memory.managed_memory.client import ManagedClient


class _BoomMemories:
    """Fake `client.beta.memories` namespace whose methods all raise."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def create(self, **kwargs):  # noqa: ARG002
        raise self._exc

    def retrieve(self, **kwargs):  # noqa: ARG002
        raise self._exc

    def list(self, **kwargs):  # noqa: ARG002
        raise self._exc


class _BoomStores:
    """Fake `client.beta.memory_stores` namespace whose methods all raise."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def list(self, *args, **kwargs):  # noqa: ARG002
        raise self._exc

    def create(self, *args, **kwargs):  # noqa: ARG002
        raise self._exc


class _BoomBeta:
    def __init__(self, exc: Exception) -> None:
        self.memory_stores = _BoomStores(exc)
        self.memories = _BoomMemories(exc)


class _BoomSDKClient:
    def __init__(self, exc: Exception) -> None:
        self.beta = _BoomBeta(exc)


def _build_client(exc: Exception) -> ManagedClient:
    """
    Construct a ManagedClient bypassing __init__ so we never touch anthropic
    or env vars. We populate just the attributes the wrapped methods read.
    """
    mc = ManagedClient.__new__(ManagedClient)
    mc._client = _BoomSDKClient(exc)  # type: ignore[attr-defined]
    mc._anthropic = None  # type: ignore[attr-defined]
    mc._timeout = 10.0  # type: ignore[attr-defined]
    return mc


class ClientErrorTranslationTests(unittest.TestCase):
    """Every SDK-call wrapper must re-raise as ManagedDisabled with chain."""

    def _assert_translates(self, callable_, *, original: Exception, label: str):
        with self.assertRaises(ManagedDisabled) as ctx:
            callable_()
        # Original chained on __cause__ (the `from e` clause).
        self.assertIs(
            ctx.exception.__cause__,
            original,
            f"{label}: original exception not chained via `from e`",
        )
        # Original message preserved in the new message.
        msg = str(ctx.exception)
        self.assertIn(
            str(original),
            msg,
            f"{label}: original message {original!s} missing from {msg!r}",
        )

    # ---- one test per wrapped SDK method ---------------------------------

    def test_stores_list_translates_runtime_error(self):
        original = RuntimeError("network down on stores.list")
        client = _build_client(original)
        self._assert_translates(
            client.stores_list,
            original=original,
            label="stores_list",
        )

    def test_stores_get_or_create_translates_runtime_error(self):
        # stores_get_or_create() first calls stores_list() internally, which
        # itself wraps stores.list. We assert the same translation invariant
        # holds for whichever call surfaces first.
        original = RuntimeError("network down on stores.create")
        client = _build_client(original)
        self._assert_translates(
            lambda: client.stores_get_or_create(name="loki-test"),
            original=original,
            label="stores_get_or_create",
        )

    def test_memory_create_translates_runtime_error(self):
        original = RuntimeError("server 500 on memories.create")
        client = _build_client(original)
        self._assert_translates(
            lambda: client.memory_create(
                store_id="store_1", path="/x", content="hello"
            ),
            original=original,
            label="memory_create",
        )

    def test_memory_read_translates_runtime_error(self):
        original = RuntimeError("404 on memories.retrieve")
        client = _build_client(original)
        self._assert_translates(
            lambda: client.memory_read(store_id="store_1", memory_id="mem_1"),
            original=original,
            label="memory_read",
        )

    def test_memories_list_translates_runtime_error(self):
        original = RuntimeError("auth failed on memories.list")
        client = _build_client(original)
        self._assert_translates(
            lambda: client.memories_list(store_id="store_1"),
            original=original,
            label="memories_list",
        )

    # ---- invariant: do NOT swallow ManagedDisabled -----------------------

    def test_managed_disabled_passes_through_unchanged(self):
        """If the SDK raises ManagedDisabled itself, do not re-wrap it."""
        original = ManagedDisabled("explicit disabled inside SDK call")
        client = _build_client(original)
        with self.assertRaises(ManagedDisabled) as ctx:
            client.stores_list()
        # Same object -- not re-wrapped.
        self.assertIs(ctx.exception, original)
        # And no chained cause was added.
        self.assertIsNone(ctx.exception.__cause__)

    # ---- exotic exception types still translate --------------------------

    def test_keyerror_also_translates(self):
        original = KeyError("missing-field")
        client = _build_client(original)
        self._assert_translates(
            lambda: client.memory_read(store_id="s", memory_id="m"),
            original=original,
            label="memory_read(KeyError)",
        )

    def test_value_error_also_translates(self):
        original = ValueError("bad payload")
        client = _build_client(original)
        self._assert_translates(
            client.stores_list,
            original=original,
            label="stores_list(ValueError)",
        )


if __name__ == "__main__":
    unittest.main()
