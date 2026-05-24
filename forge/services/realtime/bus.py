"""In-process pub/sub + persisted history.

This is a *coordinator* not a transport. The WebSocket endpoint
(dashboard/server.py side) calls subscribe() and gets an asyncio
queue it can iterate to deliver to clients. The MCP tool path calls
publish() to add a message; subscribers wake up automatically.

History persists to <forge_dir>/realtime/history/<channel>.jsonl with
a 10k-message cap per channel (oldest dropped on rotation).
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from collections import defaultdict, deque
from typing import Any, AsyncIterator, Callable, Deque, Dict, List, Optional


_HISTORY_CAP = 10000

_LOCK = threading.RLock()
_SUBSCRIBERS: Dict[str, List["asyncio.Queue[Dict[str, Any]]"]] = defaultdict(list)
# Per-channel ring buffer for synchronous history without disk I/O.
_RING: Dict[str, Deque[Dict[str, Any]]] = defaultdict(lambda: deque(maxlen=_HISTORY_CAP))


def _hist_path(forge_dir: str, channel: str) -> str:
    return os.path.join(forge_dir, "realtime", "history", f"{channel}.jsonl")


_SYSTEM_SENDERS = ("__presence__",)


def publish(forge_dir: str, channel: str, payload: Any,
            sender_user_id: Optional[str] = None) -> Dict[str, Any]:
    """Publish a message to a channel. Returns the persisted record.

    The bus does NOT enforce channel RLS here; the surface (HTTP/WS
    endpoint, MCP tool) is responsible for checking the channel's
    `rls` field before calling publish() so the bus stays simple.

    N-43: every record carries a `_meta` envelope with `system: bool`
    + `source` ("system" for known internal senders like __presence__,
    otherwise "user"). Lets consumers filter or branch on origin
    without sniffing the sender field directly.
    """
    is_system = sender_user_id in _SYSTEM_SENDERS
    rec = {
        "id": uuid.uuid4().hex,
        "ts": int(time.time() * 1000),  # epoch ms
        "channel": channel,
        "sender": sender_user_id,
        "payload": payload,
        "_meta": {
            "system": is_system,
            "source": "system" if is_system else "user",
        },
    }
    # Persist to ring buffer + disk.
    with _LOCK:
        _RING[channel].append(rec)
        subs = list(_SUBSCRIBERS.get(channel, []))
    # Disk persistence is best-effort; never blocks the in-memory dispatch.
    try:
        path = _hist_path(forge_dir, channel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")
        _maybe_rotate(path)
    except OSError:
        pass
    for q in subs:
        try:
            q.put_nowait(rec)
        except asyncio.QueueFull:
            # Slow subscriber - drop. The history endpoint lets clients
            # rehydrate if they care about missed messages.
            pass
    return rec


async def subscribe(channel: str, *,
                    queue_size: int = 256) -> "asyncio.Queue[Dict[str, Any]]":
    """Return a queue subscribed to a channel. Caller awaits q.get() and
    is responsible for calling unsubscribe(channel, q) on disconnect."""
    q: asyncio.Queue[Dict[str, Any]] = asyncio.Queue(maxsize=queue_size)
    with _LOCK:
        _SUBSCRIBERS[channel].append(q)
    return q


def unsubscribe(channel: str, q: "asyncio.Queue[Dict[str, Any]]") -> None:
    with _LOCK:
        try:
            _SUBSCRIBERS.get(channel, []).remove(q)
        except ValueError:
            pass


def history(forge_dir: str, channel: str, *,
            limit: int = 100,
            since_ms: Optional[int] = None) -> List[Dict[str, Any]]:
    """Return recent history for a channel. Reads from the ring buffer
    when available (fast) and falls back to disk if the ring is cold."""
    limit = max(1, min(int(limit), _HISTORY_CAP))
    with _LOCK:
        ring = list(_RING.get(channel, []))
    if ring:
        if since_ms is not None:
            ring = [m for m in ring if m.get("ts", 0) >= int(since_ms)]
        return ring[-limit:]

    # Cold ring - load from disk.
    path = _hist_path(forge_dir, channel)
    if not os.path.isfile(path):
        return []
    out: List[Dict[str, Any]] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if since_ms is not None and rec.get("ts", 0) < int(since_ms):
                    continue
                out.append(rec)
    except OSError:
        return []
    return out[-limit:]


def reset(channel: Optional[str] = None) -> None:
    """Test helper: drop in-memory state."""
    with _LOCK:
        if channel is None:
            _SUBSCRIBERS.clear()
            _RING.clear()
        else:
            _SUBSCRIBERS.pop(channel, None)
            _RING.pop(channel, None)


def _maybe_rotate(path: str) -> None:
    """When a history file exceeds 4MB, truncate the leading bytes so the
    on-disk store cannot grow unbounded. Best-effort."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    if size <= 4 * 1024 * 1024:
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            tail = f.readlines()[-_HISTORY_CAP // 2:]
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.writelines(tail)
        os.replace(tmp, path)
    except OSError:
        pass
