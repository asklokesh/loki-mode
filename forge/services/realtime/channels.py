"""Channel CRUD + persisted manifest.

Each channel is registered in <forge_dir>/realtime/channels.json. F-3
keeps state in a single JSON file; F-4 promotes to libSQL/Postgres
when the deploy target requires it.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, List, Optional


class ChannelError(Exception):
    pass


_NAME_RE = re.compile(r"^[a-z][a-z0-9_.\-]{1,63}$")

# Channel-level RLS predicate names. Mirror the DB layer so a single
# identity story applies to both reads and realtime delivery.
_ALLOWED_RLS = {"public", "own-row", "own-or-public", "custom"}


def _channels_path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "realtime", "channels.json")


def _load(forge_dir: str) -> List[Dict[str, Any]]:
    p = _channels_path(forge_dir)
    if not os.path.isfile(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    return list(data) if isinstance(data, list) else []


def _save(forge_dir: str, channels: List[Dict[str, Any]]) -> None:
    p = _channels_path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(channels, f, indent=2, sort_keys=True)
    os.replace(tmp, p)


def create_channel(forge_dir: str, name: str, *, public: bool = False,
                   rls: str = "own-row",
                   custom_predicate: Optional[str] = None) -> Dict[str, Any]:
    if not _NAME_RE.match(name or ""):
        raise ChannelError(
            "channel name must match ^[a-z][a-z0-9_.\\-]{1,63}$"
        )
    if rls not in _ALLOWED_RLS:
        raise ChannelError(f"rls must be one of {sorted(_ALLOWED_RLS)}")
    if rls == "custom" and not custom_predicate:
        raise ChannelError("rls=custom requires custom_predicate")
    if custom_predicate and (
        ";" in custom_predicate or "--" in custom_predicate or "\x00" in custom_predicate
    ):
        raise ChannelError("custom_predicate must not contain ; -- or NUL")

    channels = _load(forge_dir)
    if any(c.get("name") == name for c in channels):
        raise ChannelError(f"channel exists: {name}")
    entry = {
        "name": name,
        "public": bool(public),
        "rls": rls,
        "custom_predicate": custom_predicate,
        "created_at": int(time.time()),
    }
    channels.append(entry)
    _save(forge_dir, channels)
    return entry


def list_channels(forge_dir: str) -> List[Dict[str, Any]]:
    return _load(forge_dir)


def get_channel(forge_dir: str, name: str) -> Optional[Dict[str, Any]]:
    for c in _load(forge_dir):
        if c.get("name") == name:
            return c
    return None


def delete_channel(forge_dir: str, name: str) -> bool:
    channels = _load(forge_dir)
    new = [c for c in channels if c.get("name") != name]
    if len(new) == len(channels):
        return False
    _save(forge_dir, new)
    # Also clear the per-channel history file so deleted channel names
    # cannot leak prior messages if re-created.
    hist = os.path.join(forge_dir, "realtime", "history", f"{name}.jsonl")
    if os.path.exists(hist):
        try:
            os.remove(hist)
        except OSError:
            pass
    return True
