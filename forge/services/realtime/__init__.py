"""Forge realtime - WebSocket pub/sub for the user's app.

In F-3 we ship channel CRUD + an in-memory pub/sub bus + a JSONL history
log so subscribers reconnecting can rehydrate the last N messages. The
WebSocket endpoint /forge/realtime/v1 mounts onto the existing dashboard
manager (dashboard/server.py:393) so we get the 30s keepalive, max
connection cap, and per-IP rate limit for free.

RLS in F-3: channels carry an `rls` field that mirrors the database
policy names (public, own-row, own-or-public, custom). The bus checks
on publish + delivery. Postgres LISTEN/NOTIFY bridge lands with the
F-4 deploy adapters.
"""

from __future__ import annotations

from .channels import (  # noqa: F401
    ChannelError,
    create_channel,
    delete_channel,
    get_channel,
    list_channels,
)
from .bus import publish, subscribe, history  # noqa: F401
from .presence import (  # noqa: F401
    set_presence,
    clear_presence,
    list_presence,
    gc_presence,
)
