"""
Loki Managed Agents Memory - Shadow-write path (v6.83.0 Phase 1).

Writes a whitelisted subset of RARV-C artifacts to the managed memory store:

    - Completion-council verdicts (one JSON file per iteration)
    - High-importance semantic patterns (importance >= 0.6)

Design rules enforced by this module:

    1. Every call is gated on LOKI_MANAGED_AGENTS=true AND LOKI_MANAGED_MEMORY=true.
    2. On API error, we emit ONE `managed_agents_fallback` event and return.
       No retry storm.
    3. On a 409 (sha256 precondition mismatch), we re-read the remote entry,
       merge with the local content, and retry ONCE. After that, fall back.
    4. Non-blocking from the caller: this module never raises to its caller.
       Callers in bash can background with `&` for extra isolation.
    5. This file must NOT import anthropic at module load time. Client
       construction is deferred to first call.

CLI:
    python3 -m memory.managed_memory.shadow_write --verdict <path>
    python3 -m memory.managed_memory.shadow_write --path <episode.json>
    python3 -m memory.managed_memory.shadow_write --pattern-json <json_file>
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

from . import ManagedDisabled, is_enabled
from .events import emit_managed_event

_LOG = logging.getLogger("loki.managed_memory.shadow_write")

# Store name is stable across runs so different projects share lineage.
# Callers can override via LOKI_MANAGED_STORE_NAME.
_DEFAULT_STORE_NAME = "loki-rarv-c-learnings"


def _store_name() -> str:
    return os.environ.get("LOKI_MANAGED_STORE_NAME", _DEFAULT_STORE_NAME)


def _warn_once(msg: str) -> None:
    # Single-line WARN, no retry-storm. Kept trivially simple on purpose.
    sys.stderr.write(f"WARN [managed_memory] {msg}\n")


def _get_client():
    """Import client lazily so importing this module stays SDK-free."""
    from .client import get_client, compute_sha256  # noqa: F401

    return get_client(), compute_sha256


def _read_json(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------------------
# Core write helpers
# ---------------------------------------------------------------------------


def _shadow_write_blob(
    logical_path: str,
    payload: Dict[str, Any],
    kind: str,
) -> bool:
    """
    Write `payload` (a JSON-serializable dict) at `logical_path` in the
    managed store. Returns True on success, False on fallback.

    This function is responsible for the single 409 retry cycle and for
    emitting fallback/success events.
    """
    if not is_enabled():
        return False

    content = json.dumps(payload, sort_keys=True, default=str)
    try:
        client, compute_sha = _get_client()
    except ManagedDisabled as e:
        _warn_once(f"client unavailable ({e}); local path only")
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "client_unavailable", "detail": str(e), "kind": kind},
        )
        return False
    except Exception as e:  # pragma: no cover - defensive
        _warn_once(f"client construction failed ({e}); local path only")
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "client_error", "detail": str(e), "kind": kind},
        )
        return False

    # Ensure the store exists. Failure here => fallback.
    try:
        store = client.stores_get_or_create(
            name=_store_name(),
            description="Loki Mode RARV-C shadow-write store (v6.83.0)",
            scope="project",
        )
        store_id = store.get("id") or store.get("store_id")
    except Exception as e:
        _warn_once(f"stores_get_or_create failed ({e}); local path only")
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "stores_error", "detail": str(e), "kind": kind},
        )
        return False

    if not store_id:
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "missing_store_id", "kind": kind},
        )
        return False

    sha = compute_sha(content)
    start = time.monotonic()
    try:
        client.memory_create(
            store_id=store_id,
            path=logical_path,
            content=content,
        )
        emit_managed_event(
            "managed_memory_shadow_write",
            {
                "kind": kind,
                "path": logical_path,
                "sha256": sha,
                "elapsed_ms": int((time.monotonic() - start) * 1000),
            },
        )
        return True
    except Exception as first_err:
        # Detect 409 / precondition failure.
        status = getattr(first_err, "status_code", None) or getattr(
            first_err, "status", None
        )
        if status == 409:
            # Re-read, merge, retry once.
            try:
                existing_list = client.memories_list(
                    store_id=store_id, path_prefix=logical_path
                )
                existing_entry = next(
                    (m for m in existing_list if m.get("path") == logical_path),
                    None,
                )
                existing_sha = (
                    existing_entry.get("sha") or existing_entry.get("content_sha256")
                    if existing_entry
                    else None
                )
                if existing_entry and existing_sha:
                    if existing_entry.get("content") is None:
                        # Merging into unseen content would overwrite it.
                        raise RuntimeError(
                            f"stored content for {logical_path} not returned"
                        )
                    # Simple merge: if existing content already contains a
                    # "versions" list, append; else seed it. We do NOT attempt
                    # semantic merging in Phase 1.
                    try:
                        existing_content_str = existing_entry.get("content", "{}")
                        existing_doc = json.loads(existing_content_str)
                    except (TypeError, json.JSONDecodeError):
                        existing_doc = {}
                    merged = {
                        **existing_doc,
                        **payload,
                        "_merged_versions": (
                            existing_doc.get("_merged_versions", [])
                            + [existing_sha]
                        ),
                    }
                    merged_content = json.dumps(merged, sort_keys=True, default=str)
                    new_sha = compute_sha(merged_content)
                    # Precondition is the sha of the CURRENT remote state that
                    # we just read. The new sha is what the server will store.
                    client.memory_update(
                        store_id=store_id,
                        memory_id=existing_entry["id"],
                        content=merged_content,
                        sha256_precondition=existing_sha,
                    )
                    emit_managed_event(
                        "managed_memory_shadow_write",
                        {
                            "kind": kind,
                            "path": logical_path,
                            "sha256": new_sha,
                            "merged": True,
                            "elapsed_ms": int(
                                (time.monotonic() - start) * 1000
                            ),
                        },
                    )
                    return True
            except Exception as retry_err:
                _warn_once(
                    f"409 retry for {logical_path} failed ({retry_err}); fallback"
                )
                emit_managed_event(
                    "managed_agents_fallback",
                    {
                        "reason": "retry_failed",
                        "detail": str(retry_err),
                        "kind": kind,
                        "path": logical_path,
                    },
                )
                return False

        # Non-409 error => immediate fallback, single WARN line.
        _warn_once(f"memory_create failed ({first_err}); local path only")
        emit_managed_event(
            "managed_agents_fallback",
            {
                "reason": "memory_create_error",
                "detail": str(first_err),
                "kind": kind,
                "path": logical_path,
            },
        )
        return False


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def shadow_write_verdict(verdict_json_path: str) -> bool:
    """
    Read a council verdict JSON from disk and shadow-write it.

    The logical remote path is `/verdicts/<iteration>.json`. If the file is
    missing or unreadable, the call is a no-op. Never raises.
    """
    if not is_enabled():
        return False
    payload = _read_json(verdict_json_path)
    if not payload:
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "verdict_unreadable", "path": verdict_json_path},
        )
        return False
    iteration = payload.get("iteration") or payload.get("round") or "unknown"
    logical = f"/verdicts/iteration-{iteration}.json"
    return _shadow_write_blob(logical, payload, kind="verdict")


def shadow_write_pattern(pattern: Dict[str, Any]) -> bool:
    """
    Shadow-write a SemanticPattern-shaped dict. Logical path is
    `/patterns/<pattern_id>.json`. Never raises.
    """
    if not is_enabled():
        return False
    if not isinstance(pattern, dict):
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "pattern_not_dict", "type": str(type(pattern))},
        )
        return False
    pid = pattern.get("pattern_id") or pattern.get("id") or "unknown"
    logical = f"/patterns/{pid}.json"
    return _shadow_write_blob(logical, pattern, kind="pattern")


def shadow_write_episode(episode_path: str) -> bool:
    """
    Shadow-write a high-importance episode trace JSON. Logical path is
    `/episodes/<episode_id>.json`. Called from autonomy/run.sh's
    auto_capture_episode ONLY when importance >= 0.6. Never raises.
    """
    if not is_enabled():
        return False
    payload = _read_json(episode_path)
    if not payload:
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "episode_unreadable", "path": episode_path},
        )
        return False
    eid = payload.get("id") or payload.get("task_id") or Path(episode_path).stem
    logical = f"/episodes/{eid}.json"
    return _shadow_write_blob(logical, payload, kind="episode")


# ---------------------------------------------------------------------------
# Module CLI
# ---------------------------------------------------------------------------


def _main(argv: Optional[list] = None) -> int:
    # Silent no-op if flags are off -- bash callers rely on exit 0.
    if not is_enabled():
        return 0

    parser = argparse.ArgumentParser(
        prog="python3 -m memory.managed_memory.shadow_write",
        description="Shadow-write a RARV-C artifact to the managed memory store.",
    )
    parser.add_argument("--verdict", help="Path to a council verdict JSON")
    parser.add_argument("--path", help="Path to an episode trace JSON")
    parser.add_argument(
        "--pattern-json", help="Path to a file containing a pattern JSON blob"
    )
    args = parser.parse_args(argv)

    try:
        if args.verdict:
            shadow_write_verdict(args.verdict)
            return 0
        if args.path:
            shadow_write_episode(args.path)
            return 0
        if args.pattern_json:
            pat = _read_json(args.pattern_json)
            if pat:
                shadow_write_pattern(pat)
            return 0
        parser.print_help(sys.stderr)
        return 0
    except Exception as e:  # pragma: no cover - defensive
        _warn_once(f"shadow_write CLI unexpected error: {e}")
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "cli_unexpected", "detail": str(e)},
        )
        return 0  # Bash callers must see exit 0.


if __name__ == "__main__":
    sys.exit(_main())
