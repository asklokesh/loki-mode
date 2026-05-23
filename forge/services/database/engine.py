"""SQLite engine wrapper for forge dev.

Owns a single sqlite3.Connection per (forge_dir) and gates writes behind
the migrate.py interface. Direct DML via Engine.execute() is allowed for
read queries; write queries require an explicit allow_writes=True flag so
the agent does not accidentally bypass the council-reviewed migration path.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from typing import Any, Iterable, List, Optional, Sequence, Tuple

_CONNS: dict = {}
_LOCK = threading.RLock()


class Engine:
    """Thin sqlite wrapper. NOT thread-shared - one Engine per caller."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        # Use a single shared sqlite3 connection per db_path with check_same_thread=False
        # so the dashboard server (FastAPI threadpool) and the CLI can both
        # talk to the same dev db without per-thread reopens.
        with _LOCK:
            conn = _CONNS.get(db_path)
            if conn is None:
                os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
                conn = sqlite3.connect(db_path, check_same_thread=False,
                                       isolation_level=None)  # autocommit
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA foreign_keys=ON")
                conn.row_factory = sqlite3.Row
                _CONNS[db_path] = conn
            self._conn = conn

    def query_page(self, sql: str, params: Optional[Sequence[Any]] = None,
                   *, limit: int = 100,
                   cursor: Optional[int] = None) -> dict:
        """X-52: simple cursor pagination over a SELECT statement.

        Adds `LIMIT N OFFSET cursor` (cursor=0 by default) and returns
        {rows, next_cursor, has_more}. The query MUST be a SELECT; we
        don't permit pagination over mutations.
        """
        if not isinstance(sql, str):
            raise TypeError("sql must be a string")
        if _first_keyword(sql) not in ("SELECT", "WITH", "PRAGMA"):
            raise PermissionError("query_page only supports read queries")
        if ";" in sql.strip().rstrip(";"):
            raise ValueError("query_page takes a single statement")
        limit = max(1, min(int(limit), 10000))
        offset = max(0, int(cursor or 0))
        # We wrap the user's query in a sub-select to avoid stomping on
        # any LIMIT they wrote.
        wrapped = f"SELECT * FROM ({sql}) LIMIT ? OFFSET ?"
        cur = self._conn.execute(wrapped, list(params or []) + [limit + 1, offset])
        try:
            rows = [dict(r) for r in cur.fetchall()]
        finally:
            cur.close()
        has_more = len(rows) > limit
        if has_more:
            rows = rows[:limit]
        return {
            "rows": rows,
            "next_cursor": offset + len(rows) if has_more else None,
            "has_more": has_more,
        }

    def execute(
        self,
        sql: str,
        params: Optional[Sequence[Any]] = None,
        allow_writes: bool = False,
    ) -> List[dict]:
        """Run one SQL statement. Returns row dicts. Mutations require
        allow_writes=True so callers cannot accidentally bypass migration.

        Multi-statement scripts must use script_exec() instead so we never
        let an `; DROP TABLE` smuggle through a single execute() call.
        """
        # Reject multi-statement input here regardless of read/write intent.
        # sqlite3.execute only runs the first statement anyway, but we make
        # the rejection explicit so callers don't silently lose statements.
        if ";" in sql.strip().rstrip(";"):
            raise ValueError("execute() takes a single statement; use script_exec()")

        upper = _first_keyword(sql)
        is_write = upper in {"INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE",
                             "CREATE", "DROP", "ALTER", "TRUNCATE", "ATTACH",
                             "DETACH", "VACUUM", "REINDEX"}
        # PRAGMA is bifurcated: read forms (e.g. PRAGMA table_info(x)) have no
        # assignment; write forms (e.g. PRAGMA journal_mode=WAL) do. Allow the
        # read forms unconditionally because introspection uses them heavily.
        if upper == "PRAGMA":
            is_write = "=" in sql
        if is_write and not allow_writes:
            raise PermissionError(
                f"write statement '{upper}' rejected; use migrate_apply() "
                "or pass allow_writes=True from a trusted call site"
            )

        cur = self._conn.execute(sql, params or [])
        try:
            return [dict(row) for row in cur.fetchall()]
        finally:
            cur.close()

    def script_exec(self, script: str) -> None:
        """Run a multi-statement script. Used by migrate_apply() only."""
        # No need to gate read vs write here - the only call site is the
        # migration applier which carries council approval upstream.
        self._conn.executescript(script)

    def close(self) -> None:
        with _LOCK:
            conn = _CONNS.pop(self.db_path, None)
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass
        self._conn = None  # type: ignore[assignment]


def _first_keyword(sql: str) -> str:
    """Return the first SQL keyword in upper-case, ignoring whitespace and
    leading -- comments. Conservative; treats CTE 'WITH' as read."""
    out: List[str] = []
    in_line_comment = False
    in_block_comment = False
    i = 0
    while i < len(sql):
        ch = sql[i]
        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if ch == "*" and i + 1 < len(sql) and sql[i + 1] == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if ch == "-" and i + 1 < len(sql) and sql[i + 1] == "-":
            in_line_comment = True
            i += 2
            continue
        if ch == "/" and i + 1 < len(sql) and sql[i + 1] == "*":
            in_block_comment = True
            i += 2
            continue
        if ch.isspace():
            if out:
                break
            i += 1
            continue
        if ch.isalpha() or ch == "_":
            out.append(ch)
            i += 1
            continue
        break
    kw = "".join(out).upper()
    if kw == "WITH":
        # Treat CTEs as read - they almost always wrap a SELECT.
        return "SELECT"
    return kw


def open_engine(forge_dir: str) -> Engine:
    """Open or create the forge dev database under <forge_dir>/db.sqlite."""
    return Engine(os.path.join(forge_dir, "db.sqlite"))
