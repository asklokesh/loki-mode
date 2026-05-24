"""Per-channel presence tracking.

In F-3 presence is in-memory; F-4 promotes to Redis/Valkey for
multi-process correctness. set_presence() is idempotent and refreshes
the last-seen timestamp; list_presence() returns subscribers who
checked in within the freshness window.

N-04: when forge_dir is supplied, presence transitions (a user
appearing on a channel for the first time, or being evicted by
clear_presence / freshness expiry) emit a `presence:join` /
`presence:leave` system message on the realtime bus so subscribers can
render "who is online" without polling list_presence.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional


_LOCK = threading.RLock()
_STATE: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(dict)
_FRESHNESS_S = 60


def _emit(forge_dir: Optional[str], channel: str, kind: str,
          user_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
    if not forge_dir:
        return
    # Import lazily to avoid a circular import at module load time;
    # bus and presence both live under forge.services.realtime.
    try:
        from . import bus as _bus
        _bus.publish(forge_dir, channel, {
            "type": kind,
            "user_id": user_id,
            "metadata": metadata or {},
        }, sender_user_id="__presence__")
    except Exception:
        # Presence emit must never block the caller; the bus is
        # best-effort by design (see bus.publish for the same pattern).
        pass


def set_presence(channel: str, user_id: str, *,
                 metadata: Optional[Dict[str, Any]] = None,
                 forge_dir: Optional[str] = None) -> Dict[str, Any]:
    now = time.time()
    rec = {
        "user_id": user_id,
        "last_seen": int(now),
        "metadata": dict(metadata or {}),
    }
    is_new = False
    with _LOCK:
        is_new = user_id not in _STATE[channel]
        _STATE[channel][user_id] = rec
    if is_new:
        _emit(forge_dir, channel, "presence:join", user_id, rec["metadata"])
    return rec


def clear_presence(channel: str, user_id: str, *,
                   forge_dir: Optional[str] = None) -> None:
    removed = False
    with _LOCK:
        if user_id in _STATE.get(channel, {}):
            del _STATE[channel][user_id]
            removed = True
    if removed:
        _emit(forge_dir, channel, "presence:leave", user_id)


def list_presence(channel: str, *,
                  forge_dir: Optional[str] = None) -> List[Dict[str, Any]]:
    now = time.time()
    out: List[Dict[str, Any]] = []
    expired: List[str] = []
    with _LOCK:
        for uid, rec in list(_STATE.get(channel, {}).items()):
            if now - rec["last_seen"] > _FRESHNESS_S:
                del _STATE[channel][uid]
                expired.append(uid)
                continue
            out.append(rec)
    # N-18: emit leave exactly once per logical transition. The
    # eviction happened under the lock above, so a concurrent caller
    # racing on the same channel cannot re-emit because the user is
    # already gone from _STATE.
    for uid in expired:
        _emit(forge_dir, channel, "presence:leave", uid)
    out.sort(key=lambda r: r["last_seen"], reverse=True)
    return out


def gc_presence(channel: str, *,
                forge_dir: Optional[str] = None) -> List[str]:
    """N-18: drain expired users from a channel without returning
    the live roster. Use this from a scheduler/dashboard tick when
    you want presence:leave events to fire even if no client polls
    list_presence. Returns the list of user_ids that were evicted.
    Safe to call concurrently with list_presence - the same lock
    guarantees a single leave per logical transition.
    """
    now = time.time()
    expired: List[str] = []
    with _LOCK:
        for uid, rec in list(_STATE.get(channel, {}).items()):
            if now - rec["last_seen"] > _FRESHNESS_S:
                del _STATE[channel][uid]
                expired.append(uid)
    for uid in expired:
        _emit(forge_dir, channel, "presence:leave", uid)
    return expired
