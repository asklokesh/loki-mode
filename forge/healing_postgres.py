"""X-77: Postgres healing - parity with the SQLite propose_from_sqlite.

Reads a Postgres connection string and proposes a forge migration
spec that replicates the schema. We use `psycopg` if available; the
fallback is to accept a JSON dump produced by `pg_dump --schema-only`
+ a tiny parser. Either way, the output is the same shape as
`propose_from_sqlite()` so apply_proposal() works unchanged.

This module does NOT execute SQL against the legacy Postgres - it
only reads `information_schema`. Loki never holds prod credentials;
the agent's user-app supplies a read-only connection string.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


_PG_TYPE_MAP = {
    "integer": "integer",
    "bigint": "integer",
    "smallint": "integer",
    "int": "integer",
    "int2": "integer",
    "int4": "integer",
    "int8": "integer",
    "real": "real",
    "double precision": "real",
    "numeric": "real",
    "decimal": "real",
    "boolean": "boolean",
    "bool": "boolean",
    "text": "text",
    "character varying": "text",
    "varchar": "text",
    "char": "text",
    "uuid": "uuid",
    "timestamp without time zone": "timestamp",
    "timestamp with time zone": "timestamp",
    "timestamptz": "timestamp",
    "timestamp": "timestamp",
    "date": "timestamp",
    "json": "json",
    "jsonb": "json",
    "bytea": "blob",
}


def propose_from_postgres(connection_string: str,
                          *, schema: str = "public") -> Dict[str, Any]:
    """Read tables + columns from a Postgres `information_schema` and
    return a forge migration spec. Requires `psycopg` (v3) or `psycopg2`
    to be importable; raises a clear error otherwise so the caller
    knows to install the dependency or use the dump-file path."""
    conn = _connect(connection_string)
    out: Dict[str, Any] = {
        "schema": "loki.forge.healing.proposal/v1",
        "source": f"postgres:{schema}",
        "operations": [],
        "warnings": [],
    }
    try:
        tables = _query(conn,
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = %s AND table_type = 'BASE TABLE' "
            "ORDER BY table_name", (schema,))
        for row in tables:
            tname = row["table_name"]
            if tname.startswith("_forge_"):
                continue
            cols = _query(conn,
                "SELECT column_name, data_type, is_nullable, "
                "column_default, character_maximum_length "
                "FROM information_schema.columns "
                "WHERE table_schema = %s AND table_name = %s "
                "ORDER BY ordinal_position", (schema, tname))
            pks = _primary_key_columns(conn, schema, tname)
            spec_cols: List[Dict[str, Any]] = []
            for c in cols:
                cname = c["column_name"]
                dtype = (c["data_type"] or "text").lower()
                col: Dict[str, Any] = {
                    "name": cname,
                    "type": _PG_TYPE_MAP.get(dtype, "text"),
                }
                if cname in pks:
                    col["primary_key"] = True
                    if col["type"] == "integer":
                        col["type"] = "id"
                if str(c["is_nullable"]).upper() == "NO":
                    col["notnull"] = True
                if c["column_default"] is not None:
                    d = str(c["column_default"])
                    if d in ("now()", "CURRENT_TIMESTAMP"):
                        col["default"] = "now()"
                    elif d.startswith("'") and "'::" in d:
                        col["default"] = d.split("'")[1]
                    elif d.lower() == "true" or d.lower() == "false":
                        col["default"] = d.lower()
                spec_cols.append(col)
            if not spec_cols:
                out["warnings"].append(f"{tname}: no columns parsed")
                continue
            out["operations"].append({"add_table": {
                "name": tname, "columns": spec_cols, "rls": "own-row",
            }})
            # Indices.
            indices = _query(conn,
                "SELECT indexname, indexdef FROM pg_indexes "
                "WHERE schemaname = %s AND tablename = %s",
                (schema, tname))
            for idx in indices:
                ddef = idx["indexdef"] or ""
                if "PRIMARY KEY" in ddef.upper():
                    continue
                m = re.search(r"\((.*?)\)", ddef)
                if not m:
                    continue
                cols_in_idx = [c.strip().strip('"') for c in m.group(1).split(",")]
                out["operations"].append({"create_index": {
                    "table": tname,
                    "columns": cols_in_idx,
                    "name": idx["indexname"],
                    "unique": "UNIQUE INDEX" in ddef.upper(),
                }})
    finally:
        conn.close()
    return out


def _connect(connection_string: str):
    """Open a Postgres connection via psycopg v3 -> v2 -> error."""
    try:
        import psycopg  # type: ignore
        return psycopg.connect(connection_string, autocommit=True)
    except ImportError:
        pass
    try:
        import psycopg2  # type: ignore
        return psycopg2.connect(connection_string)
    except ImportError as e:
        raise RuntimeError(
            "propose_from_postgres requires psycopg (v3) or psycopg2 "
            "to be installed; install one of: "
            "pip install 'psycopg[binary]'  OR  pip install psycopg2-binary"
        ) from e


def _query(conn, sql: str, params: tuple = ()) -> List[Dict[str, Any]]:
    """Run a SELECT and return rows as dicts."""
    with conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _primary_key_columns(conn, schema: str, table: str) -> List[str]:
    rows = _query(conn,
        "SELECT a.attname AS column_name "
        "FROM pg_index i "
        "JOIN pg_attribute a ON a.attrelid = i.indrelid "
        "                    AND a.attnum = ANY(i.indkey) "
        "WHERE i.indrelid = %s::regclass AND i.indisprimary",
        (f'"{schema}"."{table}"',))
    return [r["column_name"] for r in rows]


# Parser fallback for pg_dump output (no psycopg required).

_CREATE_TABLE_RE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"
    r"(?:[A-Za-z_][A-Za-z0-9_]*\.)?(\"?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\(",
    re.IGNORECASE,
)


def propose_from_pgdump(dump_text: str) -> Dict[str, Any]:
    """Parse pg_dump --schema-only output and emit the same proposal
    shape. Tolerates DDL we don't understand by skipping it."""
    out: Dict[str, Any] = {
        "schema": "loki.forge.healing.proposal/v1",
        "source": "pgdump",
        "operations": [],
        "warnings": [],
    }
    # Strip comments first.
    text = re.sub(r"--[^\n]*\n", "\n", dump_text)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    pos = 0
    while pos < len(text):
        m = _CREATE_TABLE_RE.search(text, pos)
        if not m:
            break
        # Find matching close paren.
        body_start = m.end()
        depth = 1
        i = body_start
        while i < len(text) and depth > 0:
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
            i += 1
        body = text[body_start: i - 1]
        tname = m.group(2)
        if tname.startswith("_forge_"):
            pos = i
            continue
        cols: List[Dict[str, Any]] = []
        depth_split = 0
        buf: List[str] = []
        lines: List[str] = []
        for ch in body:
            if ch == "(":
                depth_split += 1; buf.append(ch)
            elif ch == ")":
                depth_split -= 1; buf.append(ch)
            elif ch == "," and depth_split == 0:
                lines.append("".join(buf).strip()); buf = []
            else:
                buf.append(ch)
        if buf:
            lines.append("".join(buf).strip())
        for line in lines:
            upper = line.upper().lstrip()
            if upper.startswith(("PRIMARY KEY", "FOREIGN KEY",
                                  "CONSTRAINT", "UNIQUE", "CHECK")):
                continue
            tokens = line.split()
            if len(tokens) < 2:
                continue
            name_raw = tokens[0].strip('"')
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name_raw):
                continue
            dtype = " ".join(tokens[1:3]).lower().split("(")[0].strip()
            if dtype not in _PG_TYPE_MAP:
                dtype = tokens[1].lower().split("(")[0].strip()
            ftype = _PG_TYPE_MAP.get(dtype, "text")
            col: Dict[str, Any] = {"name": name_raw, "type": ftype}
            rest_upper = " ".join(tokens[1:]).upper()
            if "NOT NULL" in rest_upper:
                col["notnull"] = True
            if "PRIMARY KEY" in rest_upper:
                col["primary_key"] = True
                if ftype == "integer":
                    col["type"] = "id"
            cols.append(col)
        if cols:
            out["operations"].append({"add_table": {
                "name": tname, "columns": cols, "rls": "own-row",
            }})
        else:
            out["warnings"].append(f"{tname}: no columns parsed")
        pos = i
    return out
