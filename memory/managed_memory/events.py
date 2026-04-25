"""
Loki Managed Agents Memory - Event emission (v6.83.0 Phase 1).

Appends structured JSONL events to .loki/managed/events.ndjson. Single-writer
convention: only code in memory/managed_memory/ writes to this file. Rotates
when the file exceeds 10MB.

Events are used to record fallbacks, shadow-write successes/failures, and
retrieve hits. The file is safe to tail for observability during development.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

# 10 MB rotation threshold. Keeping rotation simple: rename to .<YYYYMMDD>.
_ROTATE_BYTES = 10 * 1024 * 1024


def _load_loki_version() -> str:
    """
    Read the repo VERSION file once at module import.

    Resolves to <repo_root>/VERSION assuming this file lives at
    <repo_root>/memory/managed_memory/events.py. If the file is missing
    or unreadable for any reason, returns the literal string "unknown"
    so the correlation field is ALWAYS present on emitted events.
    """
    try:
        version_path = Path(__file__).resolve().parents[2] / "VERSION"
        return version_path.read_text(encoding="utf-8").strip() or "unknown"
    except Exception:
        return "unknown"


# Cached at module load: never re-read per-event. The repo version does not
# change during a single Python process lifetime.
_LOKI_VERSION: str = _load_loki_version()


def _correlation_stamp() -> Dict[str, Any]:
    """
    Build the correlation fields to merge into every payload.

    Reads LOKI_ITERATION_COUNT and LOKI_SESSION_ID from the environment.
    Missing env vars are OMITTED (not set to None) so callers can tell
    "unset" apart from "explicitly null". loki_version is always present.
    """
    stamp: Dict[str, Any] = {"loki_version": _LOKI_VERSION}
    iteration = os.environ.get("LOKI_ITERATION_COUNT")
    if iteration is not None and iteration != "":
        stamp["iteration_id"] = iteration
    session = os.environ.get("LOKI_SESSION_ID")
    if session is not None and session != "":
        stamp["session_id"] = session
    return stamp


def _events_dir(target_dir: Optional[str] = None) -> Path:
    base = target_dir or os.environ.get("LOKI_TARGET_DIR") or os.getcwd()
    return Path(base) / ".loki" / "managed"


def _maybe_rotate(path: Path) -> None:
    """Rotate the events file if it has exceeded the size threshold."""
    try:
        if path.exists() and path.stat().st_size >= _ROTATE_BYTES:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
            rotated = path.with_suffix(path.suffix + f".{stamp}")
            # Best-effort rename; if another writer got there first, move on.
            try:
                path.rename(rotated)
            except OSError:
                pass
    except OSError:
        # If stat fails, skip rotation; next write will retry.
        pass


def emit_managed_event(
    event_type: str,
    payload: Dict[str, Any],
    target_dir: Optional[str] = None,
) -> None:
    """
    Append a managed-memory event to .loki/managed/events.ndjson.

    Never raises: on any I/O error the function silently returns. Callers
    rely on this to keep the main RARV-C loop unblocked.

    Args:
        event_type: short tag, e.g. "managed_agents_fallback",
            "managed_memory_retrieve", "managed_memory_shadow_write".
        payload: JSON-serializable context for the event.
        target_dir: optional project root override. Defaults to
            LOKI_TARGET_DIR env or cwd.
    """
    try:
        dir_path = _events_dir(target_dir)
        dir_path.mkdir(parents=True, exist_ok=True)
        path = dir_path / "events.ndjson"
        _maybe_rotate(path)

        # Stamp correlation fields (loki_version always; iteration_id and
        # session_id when env vars are set). Caller-supplied keys win: if
        # the payload already carries iteration_id / session_id / loki_version
        # the explicit caller value is preserved. Single-writer invariant
        # is preserved because we only mutate the in-memory dict here; the
        # write path (file handle, lock-free append) is unchanged.
        merged_payload = {**_correlation_stamp(), **(payload or {})}

        record = {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "type": event_type,
            "payload": merged_payload,
        }
        # Line-buffered append; JSONL.
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, default=str) + "\n")
    except Exception:
        # Never raise from the event emitter.
        return
