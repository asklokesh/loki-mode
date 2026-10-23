"""
Loki Managed Agents Memory - Retrieve path (v6.83.0 Phase 1).

Used by the REASON phase (retrieve_memory_context in autonomy/run.sh) and by
the completion council (augment prompts with prior verdicts). Also provides
hydrate_patterns() which pulls semantic patterns updated after a local mtime
floor and merges them into .loki/memory/semantic/patterns.json via the
existing MemoryStorage._atomic_write.

CLI:
    python3 -m memory.managed_memory.retrieve --query <str> [--top-k N] \\
        [--store-id <id>]

    python3 -m memory.managed_memory.retrieve --hydrate [--since-seconds N]

Never raises: on any error the CLI prints nothing and exits 0. Bash callers
apply a 5s hard timeout; this module keeps its own 10s SDK timeout.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import ManagedDisabled, is_enabled
from .events import emit_managed_event

_LOG = logging.getLogger("loki.managed_memory.retrieve")

_DEFAULT_STORE_NAME = "loki-rarv-c-learnings"


def _store_name() -> str:
    return os.environ.get("LOKI_MANAGED_STORE_NAME", _DEFAULT_STORE_NAME)


def _warn_once(msg: str) -> None:
    sys.stderr.write(f"WARN [managed_memory] {msg}\n")


def _get_client():
    from .client import get_client

    return get_client()


def _summarize(content: str, limit: int = 240) -> str:
    """Return a short single-line summary for prompt injection."""
    s = (content or "").strip().replace("\n", " ")
    if len(s) > limit:
        s = s[: limit - 3] + "..."
    return s


# ---------------------------------------------------------------------------
# Retrieve related verdicts (used by REASON and completion council)
# ---------------------------------------------------------------------------


def retrieve_related_verdicts(
    query: str,
    top_k: int = 3,
    store_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Return up to `top_k` recent verdicts most-related to `query`.

    Phase 1 implementation: fetch memories under `verdicts/` and
    prefix-match. This is naive but honest -- true similarity retrieval
    ships in Phase 2 when the beta exposes a semantic search endpoint.
    Returns [] on any error.
    """
    if not is_enabled():
        return []

    start = time.monotonic()
    try:
        client = _get_client()
    except ManagedDisabled as e:
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "client_unavailable", "detail": str(e), "op": "retrieve"},
        )
        return []
    except Exception as e:  # pragma: no cover - defensive
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "client_error", "detail": str(e), "op": "retrieve"},
        )
        return []

    try:
        if not store_id:
            store = client.stores_get_or_create(
                name=_store_name(),
                description="Loki Mode RARV-C shadow-write store (v6.83.0)",
                scope="project",
            )
            store_id = store.get("id") or store.get("store_id")
        if not store_id:
            return []
        entries = client.memories_list(store_id=store_id, path_prefix="/verdicts/")
    except Exception as e:
        _warn_once(f"memories_list failed ({e}); returning empty")
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "list_error", "detail": str(e), "op": "retrieve"},
        )
        return []

    # Naive ranking: keep entries whose content contains any query token.
    tokens = [t.lower() for t in query.split() if len(t) > 2]
    scored: List[tuple] = []
    for e in entries:
        content = e.get("content") or ""
        content_lc = content.lower()
        score = sum(1 for t in tokens if t in content_lc)
        scored.append((score, e))
    scored.sort(key=lambda pair: pair[0], reverse=True)

    out: List[Dict[str, Any]] = []
    for score, e in scored[:top_k]:
        out.append(
            {
                "path": e.get("path"),
                "content_summary": _summarize(e.get("content") or ""),
                "version_id": e.get("version") or e.get("version_id"),
                "score": score,
            }
        )

    emit_managed_event(
        "managed_memory_retrieve",
        {
            "query_tokens": len(tokens),
            "hits": len(out),
            "total_candidates": len(entries),
            "elapsed_ms": int((time.monotonic() - start) * 1000),
        },
    )
    return out


# ---------------------------------------------------------------------------
# Hydrate semantic patterns
# ---------------------------------------------------------------------------


def hydrate_patterns(
    local_mtime_floor: float,
    target_dir: Optional[str] = None,
) -> int:
    """
    Pull semantic patterns from the managed store and merge them into
    .loki/memory/semantic/patterns.json. Returns the number of patterns
    merged in. Returns 0 on disabled / error.

    Only patterns whose remote version timestamp is newer than
    `local_mtime_floor` are merged. The merge is additive: existing local
    patterns with the same pattern_id are kept unchanged.
    """
    if not is_enabled():
        return 0

    try:
        client = _get_client()
    except ManagedDisabled as e:
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "client_unavailable", "detail": str(e), "op": "hydrate"},
        )
        return 0
    except Exception as e:  # pragma: no cover
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "client_error", "detail": str(e), "op": "hydrate"},
        )
        return 0

    try:
        store = client.stores_get_or_create(
            name=_store_name(),
            description="Loki Mode RARV-C shadow-write store (v6.83.0)",
            scope="project",
        )
        store_id = store.get("id") or store.get("store_id")
        if not store_id:
            return 0
        entries = client.memories_list(store_id=store_id, path_prefix="/patterns/")
    except Exception as e:
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "list_error", "detail": str(e), "op": "hydrate"},
        )
        return 0

    target_dir = target_dir or os.environ.get("LOKI_TARGET_DIR") or os.getcwd()
    patterns_path = Path(target_dir) / ".loki" / "memory" / "semantic" / "patterns.json"

    # Read existing local patterns file (may not exist).
    existing: Dict[str, Any] = {"patterns": {}}
    if patterns_path.exists():
        try:
            with open(patterns_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
        except (OSError, json.JSONDecodeError):
            existing = {"patterns": {}}
    if "patterns" not in existing or not isinstance(existing["patterns"], dict):
        existing["patterns"] = {}

    merged = 0
    for e in entries:
        content = e.get("content")
        if not content:
            continue
        try:
            pat = json.loads(content)
        except (TypeError, json.JSONDecodeError):
            continue
        pid = pat.get("pattern_id") or pat.get("id")
        if not pid:
            continue
        if pid in existing["patterns"]:
            # Local wins on duplicate ids (Phase 1 policy).
            continue
        # Optional mtime gate: skip if the remote entry has a timestamp and
        # it predates the floor.
        ts = pat.get("updated_at") or pat.get("created_at")
        if ts and local_mtime_floor:
            try:
                # Very loose timestamp parse: accept both epoch and ISO.
                if isinstance(ts, (int, float)) and float(ts) < local_mtime_floor:
                    continue
            except (TypeError, ValueError):
                pass
        existing["patterns"][pid] = pat
        merged += 1

    if merged == 0:
        emit_managed_event(
            "managed_memory_hydrate", {"merged": 0, "candidates": len(entries)}
        )
        return 0

    # Use existing MemoryStorage._atomic_write where possible; fall back to
    # tempfile+rename if MemoryStorage is not importable in this process.
    try:
        # Late import to avoid module-load cycles.
        from memory.storage import MemoryStorage  # type: ignore

        storage = MemoryStorage(str(patterns_path.parent.parent))
        storage._atomic_write(patterns_path, existing)
    except Exception:
        # Fallback: inline atomic write.
        import tempfile

        patterns_path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            dir=str(patterns_path.parent), prefix=".tmp_", suffix=".json"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(existing, f, indent=2, default=str)
            os.replace(tmp, patterns_path)
        except Exception as e:
            if os.path.exists(tmp):
                os.unlink(tmp)
            emit_managed_event(
                "managed_agents_fallback",
                {"reason": "atomic_write_failed", "detail": str(e), "op": "hydrate"},
            )
            return 0

    emit_managed_event(
        "managed_memory_hydrate",
        {"merged": merged, "candidates": len(entries)},
    )
    return merged


# ---------------------------------------------------------------------------
# Hydrate procedural skills
# ---------------------------------------------------------------------------


def hydrate_skills(
    local_mtime_floor: float,
    target_dir: Optional[str] = None,
) -> int:
    """
    Pull procedural skills from the managed store and merge them into
    .loki/memory/skills/{name}.json (one file per skill). Returns the number
    of skill files written. Returns 0 on disabled / error.

    Only skills whose remote timestamp is newer than `local_mtime_floor` are
    merged. Local wins on conflict: a skill whose filename already exists is
    NOT overwritten.
    """
    if not is_enabled():
        return 0

    try:
        client = _get_client()
    except ManagedDisabled as e:
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "client_unavailable", "detail": str(e), "op": "hydrate_skills"},
        )
        return 0
    except Exception as e:  # pragma: no cover
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "client_error", "detail": str(e), "op": "hydrate_skills"},
        )
        return 0

    try:
        store = client.stores_get_or_create(
            name=_store_name(),
            description="Loki Mode RARV-C shadow-write store (v6.83.0)",
            scope="project",
        )
        store_id = store.get("id") or store.get("store_id")
        if not store_id:
            return 0
        entries = client.memories_list(store_id=store_id, path_prefix="/skills/")
    except Exception as e:
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "list_error", "detail": str(e), "op": "hydrate_skills"},
        )
        return 0

    target_dir = target_dir or os.environ.get("LOKI_TARGET_DIR") or os.getcwd()
    skills_dir = Path(target_dir) / ".loki" / "memory" / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)

    merged = 0
    for e in entries:
        content = e.get("content")
        if not content:
            continue
        try:
            skill = json.loads(content)
        except (TypeError, json.JSONDecodeError):
            continue
        sid = skill.get("id") or skill.get("skill_id")
        name = skill.get("name") or sid
        if not name:
            continue

        # Sanitize filename (mirror MemoryStorage.save_skill).
        safe_name = "".join(
            c if c.isalnum() or c in "-_" else "_" for c in str(name)
        )
        skill_path = skills_dir / f"{safe_name}.json"
        if skill_path.exists():
            # Local wins on conflict.
            continue

        # Optional mtime gate.
        ts = skill.get("updated_at") or skill.get("created_at")
        if ts and local_mtime_floor:
            try:
                if isinstance(ts, (int, float)) and float(ts) < local_mtime_floor:
                    continue
            except (TypeError, ValueError):
                pass

        try:
            from memory.storage import MemoryStorage  # type: ignore

            storage = MemoryStorage(str(skills_dir.parent))
            storage._atomic_write(skill_path, skill)
        except Exception:
            import tempfile

            fd, tmp = tempfile.mkstemp(
                dir=str(skills_dir), prefix=".tmp_", suffix=".json"
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(skill, f, indent=2, default=str)
                os.replace(tmp, skill_path)
            except Exception as ex:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                emit_managed_event(
                    "managed_agents_fallback",
                    {"reason": "atomic_write_failed", "detail": str(ex), "op": "hydrate_skills"},
                )
                continue
        merged += 1

    emit_managed_event(
        "managed_memory_hydrate_skills",
        {"merged": merged, "candidates": len(entries)},
    )
    return merged


# ---------------------------------------------------------------------------
# Session hydrate (patterns + skills) with idempotency guard
# ---------------------------------------------------------------------------


_HYDRATE_SENTINEL = ".loki/managed/hydrate.lock"


def _already_hydrated_this_session(target_dir: str) -> bool:
    """Idempotent: once we write the sentinel file, a second hydrate is no-op."""
    sentinel = Path(target_dir) / _HYDRATE_SENTINEL
    return sentinel.exists()


def _mark_hydrated(target_dir: str) -> None:
    sentinel = Path(target_dir) / _HYDRATE_SENTINEL
    sentinel.parent.mkdir(parents=True, exist_ok=True)
    try:
        sentinel.write_text(str(int(time.time())), encoding="utf-8")
    except OSError:
        pass


def hydrate(
    namespace: Optional[str] = None,
    mtime_floor: Optional[float] = None,
    target_dir: Optional[str] = None,
) -> Dict[str, int]:
    """
    Session-boot hydrate: pull semantic patterns AND procedural skills from
    the managed store and merge them into local .loki/memory/. Emits a single
    `managed_memory_hydrate` event with counts.

    Args:
        namespace: Optional logical namespace label; reserved for multi-tenant
            stores (not yet used by the backend). Included in the event for
            observability.
        mtime_floor: Only merge remote entries updated after this epoch
            timestamp. Defaults to 0.0 (pull everything not already local).
        target_dir: Override .loki root; defaults to LOKI_TARGET_DIR or cwd.

    Returns:
        {"patterns": N, "skills": M, "skipped": bool}. Disabled flags / errors
        return {"patterns": 0, "skills": 0, "skipped": True/False}.

    Idempotent: a second call within the same session (while the lock file
    exists) short-circuits and returns zero counts with skipped=True.
    """
    target_dir = target_dir or os.environ.get("LOKI_TARGET_DIR") or os.getcwd()

    if not is_enabled():
        return {"patterns": 0, "skills": 0, "skipped": True}

    if _already_hydrated_this_session(target_dir):
        emit_managed_event(
            "managed_memory_hydrate",
            {
                "patterns": 0,
                "skills": 0,
                "skipped": True,
                "reason": "already_hydrated_this_session",
                "namespace": namespace or "",
            },
        )
        return {"patterns": 0, "skills": 0, "skipped": True}

    floor = float(mtime_floor) if mtime_floor is not None else 0.0

    patterns_merged = 0
    skills_merged = 0
    try:
        patterns_merged = hydrate_patterns(
            local_mtime_floor=floor, target_dir=target_dir
        )
    except Exception as e:  # pragma: no cover - defensive
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "hydrate_patterns_error", "detail": str(e), "op": "hydrate"},
        )
    try:
        skills_merged = hydrate_skills(
            local_mtime_floor=floor, target_dir=target_dir
        )
    except Exception as e:  # pragma: no cover - defensive
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "hydrate_skills_error", "detail": str(e), "op": "hydrate"},
        )

    _mark_hydrated(target_dir)

    emit_managed_event(
        "managed_memory_hydrate",
        {
            "patterns": patterns_merged,
            "skills": skills_merged,
            "skipped": False,
            "namespace": namespace or "",
        },
    )
    return {
        "patterns": patterns_merged,
        "skills": skills_merged,
        "skipped": False,
    }


# ---------------------------------------------------------------------------
# Module CLI
# ---------------------------------------------------------------------------


def _main(argv: Optional[list] = None) -> int:
    # Silent no-op if flags are off; bash callers rely on exit 0 + empty stdout.
    if not is_enabled():
        return 0

    parser = argparse.ArgumentParser(
        prog="python3 -m memory.managed_memory.retrieve",
        description="Retrieve related verdicts / hydrate patterns from the managed store.",
    )
    parser.add_argument("--query", help="Retrieval query string")
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--store-id", default=None)
    parser.add_argument(
        "--hydrate",
        action="store_true",
        help="Hydrate semantic patterns into .loki/memory/semantic/",
    )
    parser.add_argument(
        "--since-seconds",
        type=int,
        default=0,
        help="Hydrate: only merge patterns newer than NOW - since_seconds",
    )
    args = parser.parse_args(argv)

    try:
        if args.hydrate:
            floor = 0.0
            if args.since_seconds and args.since_seconds > 0:
                floor = time.time() - args.since_seconds
            # Phase 2: session-boot hydrate covers patterns + skills and is
            # idempotent (sentinel-guarded). Prints a one-line summary to
            # stdout so callers can log counts without parsing JSON.
            result = hydrate(mtime_floor=floor)
            print(
                f"[managed] hydrate patterns={result.get('patterns', 0)} "
                f"skills={result.get('skills', 0)} "
                f"skipped={result.get('skipped', False)}"
            )
            return 0

        query = args.query or ""
        if not query:
            return 0
        results = retrieve_related_verdicts(
            query=query, top_k=args.top_k, store_id=args.store_id
        )
        # Print one line per hit, suitable for pasting into a prompt section.
        for r in results:
            path = r.get("path", "")
            summary = r.get("content_summary", "")
            print(f"- [managed] {path}: {summary}")
        return 0
    except Exception as e:  # pragma: no cover - defensive
        _warn_once(f"retrieve CLI unexpected error: {e}")
        emit_managed_event(
            "managed_agents_fallback",
            {"reason": "cli_unexpected", "detail": str(e), "op": "retrieve"},
        )
        return 0


if __name__ == "__main__":
    sys.exit(_main())
