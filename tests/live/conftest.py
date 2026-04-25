"""
Shared fixtures and helpers for live Managed Memory tests.

This module exposes a single helper, ``live_enabled()``, used by every
test module in ``tests/live/`` to gate its tests behind the dual
opt-in requirement (``LOKI_LIVE_TESTS=1`` + ``ANTHROPIC_API_KEY``).

It also provides a deterministic, traceable per-run prefix used to
name created stores and memory paths so orphaned resources can be
identified and cleaned up out-of-band if a test process is killed
mid-run.
"""

from __future__ import annotations

import os
import uuid
from typing import Tuple


def live_enabled() -> bool:
    """Return True iff BOTH opt-in conditions are satisfied.

    - ``LOKI_LIVE_TESTS`` must equal the literal string ``"1"``.
    - ``ANTHROPIC_API_KEY`` must be a non-empty string.

    Any other value (including ``"true"``, ``"yes"``, unset) returns
    False so the tests are skipped rather than executed.
    """
    if os.environ.get("LOKI_LIVE_TESTS") != "1":
        return False
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return False
    return True


def live_skip_reason() -> str:
    """Return the reason string used in ``unittest.skipUnless`` decorators."""
    return (
        "live Managed Memory tests are opt-in: set LOKI_LIVE_TESTS=1 "
        "AND ANTHROPIC_API_KEY to enable"
    )


def make_test_prefix(label: str) -> str:
    """Return a uuid-suffixed prefix for naming traceable test resources.

    Example: ``make_test_prefix("roundtrip")`` -> ``loki-livetest-roundtrip-3f2a91``.

    The prefix is short enough to fit in store names but unique enough
    that an orphaned resource is trivially identifiable as a test
    artifact (begins with ``loki-livetest-``).
    """
    suffix = uuid.uuid4().hex[:6]
    return f"loki-livetest-{label}-{suffix}"


def enable_managed_flags() -> Tuple[str, str]:
    """Set the parent + child managed-memory flags required by ManagedClient.

    Returns the prior values so a teardown can restore them. Called from
    each test's ``setUp`` so the env state is explicit and local.
    """
    prior_parent = os.environ.get("LOKI_MANAGED_AGENTS", "")
    prior_child = os.environ.get("LOKI_MANAGED_MEMORY", "")
    os.environ["LOKI_MANAGED_AGENTS"] = "true"
    os.environ["LOKI_MANAGED_MEMORY"] = "true"
    return prior_parent, prior_child


def restore_managed_flags(prior_parent: str, prior_child: str) -> None:
    """Restore the env vars captured by ``enable_managed_flags``."""
    if prior_parent:
        os.environ["LOKI_MANAGED_AGENTS"] = prior_parent
    else:
        os.environ.pop("LOKI_MANAGED_AGENTS", None)
    if prior_child:
        os.environ["LOKI_MANAGED_MEMORY"] = prior_child
    else:
        os.environ.pop("LOKI_MANAGED_MEMORY", None)
