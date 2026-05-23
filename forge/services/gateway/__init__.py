"""Forge model gateway.

OpenAI-compat HTTP front that routes /forge/gateway/v1/chat/completions
to the cheapest provider that meets the latency SLO. F-2 ships the
routing logic + per-key rate limiting; the actual HTTP server lands in
F-2.27 alongside the dashboard router.
"""

from __future__ import annotations

from .routing import (  # noqa: F401
    Route,
    add_route,
    list_routes,
    remove_route,
    pick_route,
    record_usage,
    usage_summary,
)
from .rate_limit import check, record  # noqa: F401
