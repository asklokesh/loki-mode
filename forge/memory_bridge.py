"""Forge memory bridge (X-19).

Stores ForgeSchemaDecision + ForgeMigrationOutcome records into the
loki memory subsystem so the existing RAG injector picks them up on
the next iteration.

Used internally by migrate_apply (best-effort write) so every
migration the agent runs feeds future projects' context retrieval.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def _project_hash(project_dir: str) -> str:
    return hashlib.sha256(
        os.path.abspath(project_dir).encode("utf-8")
    ).hexdigest()[:16]


def record_migration_outcome(project_dir: str, *,
                             migration_id: str,
                             summary: str,
                             outcome: str,
                             root_cause: str = "",
                             sql_snippet: str = "") -> Optional[Dict[str, Any]]:
    """Persist a ForgeMigrationOutcome record into the memory store.
    Returns the stored entry, or None when the memory subsystem isn't
    available (e.g. memory dir not initialized)."""
    try:
        from memory.schemas import ForgeMigrationOutcome
    except Exception:
        return None
    rec = ForgeMigrationOutcome(
        id="frg_mout_" + migration_id[:16],
        project_hash=_project_hash(project_dir),
        migration_id=migration_id,
        summary=summary,
        outcome=outcome,
        root_cause=root_cause,
        sql_snippet=sql_snippet[:512],
        timestamp=datetime.now(tz=timezone.utc),
    )
    # Persist to .loki/memory/forge/migration_outcomes.jsonl. The RAG
    # injector reads from this directory via the cross-project memory
    # path so new projects benefit automatically.
    mem_dir = os.path.join(project_dir, ".loki", "memory", "forge")
    os.makedirs(mem_dir, exist_ok=True)
    path = os.path.join(mem_dir, "migration_outcomes.jsonl")
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec.to_dict(), separators=(",", ":")) + "\n")
    return rec.to_dict()


def record_schema_decision(project_dir: str, *,
                           table_name: str,
                           columns_summary: str,
                           decision: str,
                           rationale: str = "",
                           alternatives_considered: Optional[List[str]] = None,
                           outcome: str = "unknown") -> Optional[Dict[str, Any]]:
    try:
        from memory.schemas import ForgeSchemaDecision
    except Exception:
        return None
    rec = ForgeSchemaDecision(
        id="frg_sd_" + hashlib.sha256(
            (table_name + decision).encode("utf-8")
        ).hexdigest()[:16],
        project_hash=_project_hash(project_dir),
        table_name=table_name,
        columns_summary=columns_summary,
        decision=decision,
        rationale=rationale,
        alternatives_considered=list(alternatives_considered or []),
        outcome=outcome,
        timestamp=datetime.now(tz=timezone.utc),
    )
    mem_dir = os.path.join(project_dir, ".loki", "memory", "forge")
    os.makedirs(mem_dir, exist_ok=True)
    path = os.path.join(mem_dir, "schema_decisions.jsonl")
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec.to_dict(), separators=(",", ":")) + "\n")
    return rec.to_dict()


def load_recent(project_dir: str, *,
                kind: str = "migration_outcomes",
                limit: int = 50) -> List[Dict[str, Any]]:
    """Read recent records. kind is one of:
        migration_outcomes | schema_decisions
    """
    if kind not in ("migration_outcomes", "schema_decisions"):
        raise ValueError(f"unknown kind: {kind}")
    path = os.path.join(project_dir, ".loki", "memory", "forge",
                        f"{kind}.jsonl")
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
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return out[-max(1, min(int(limit), 10000)):]
