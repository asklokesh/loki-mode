"""Per-channel presence tracking.

In F-3 presence is in-memory; F-4 promotes to Redis/Valkey for
multi-process correctness. set_presence() is idempotent and refreshes
the last-seen timestamp; list_presence() returns subscribers who
checked in within the freshness window.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional


_LOCK = threading.RLock()
_STATE: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(dict)
_FRESHNESS_S = 60


def set_presence(channel: str, user_id: str, *,
                 metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    now = time.time()
    rec = {
        "user_id": user_id,
        "last_seen": int(now),
        "metadata": dict(metadata or {}),
    }
    with _LOCK:
        _STATE[channel][user_id] = rec
    return rec


def clear_presence(channel: str, user_id: str) -> None:
    with _LOCK:
        _STATE.get(channel, {}).pop(user_id, None)


def list_presence(channel: str) -> List[Dict[str, Any]]:
    now = time.time()
    out: List[Dict[str, Any]] = []
    with _LOCK:
        for uid, rec in list(_STATE.get(channel, {}).items()):
            if now - rec["last_seen"] > _FRESHNESS_S:
                del _STATE[channel][uid]
                continue
            out.append(rec)
    out.sort(key=lambda r: r["last_seen"], reverse=True)
    return out
