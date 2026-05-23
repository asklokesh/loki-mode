"""Role-based access control.

Mirrors the existing scope model in dashboard/auth.py so forge users
and Loki operators share one mental model. Scopes: read < write <
control < *.

Storage: a single grants table in users.sqlite created lazily.
"""

from __future__ import annotations

import sqlite3
from typing import List, Optional

from .sessions import _open_users_db, _utc_iso


SCOPE_HIERARCHY = ["read", "write", "control", "*"]


def _ensure_grants_table(forge_dir: str) -> None:
    conn = _open_users_db(forge_dir)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS grants (
                user_id TEXT NOT NULL,
                resource TEXT NOT NULL,
                scope TEXT NOT NULL,
                granted_at TEXT NOT NULL,
                PRIMARY KEY (user_id, resource)
            )
            """
        )
    finally:
        conn.close()


def grant(forge_dir: str, user_id: str, resource: str, scope: str) -> None:
    if scope not in SCOPE_HIERARCHY:
        raise ValueError(f"unknown scope: {scope}")
    _ensure_grants_table(forge_dir)
    conn = _open_users_db(forge_dir)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO grants (user_id, resource, scope, granted_at) "
            "VALUES (?, ?, ?, ?)",
            (user_id, resource, scope, _utc_iso()),
        )
    finally:
        conn.close()


def has_scope(forge_dir: str, user_id: str, resource: str, required: str) -> bool:
    """Returns True if the user has at least the required scope for the
    resource (with hierarchy: * > control > write > read)."""
    if required not in SCOPE_HIERARCHY:
        return False
    _ensure_grants_table(forge_dir)
    conn = _open_users_db(forge_dir)
    try:
        row = conn.execute(
            "SELECT scope FROM grants WHERE user_id = ? AND resource = ?",
            (user_id, resource),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return False
    have = row["scope"]
    return SCOPE_HIERARCHY.index(have) >= SCOPE_HIERARCHY.index(required)
