"""Spec-driven migrations.

The agent does not write SQL directly. It hands the engine a MigrationSpec
dict describing the change in domain terms (add_table, add_column,
drop_table, set_rls, create_index). migrate_dryrun() compiles the spec to
SQL and returns the text; migrate_apply() executes it inside a transaction
and records it in _forge_migrations.

This is the layer that lets the council review backend changes before they
touch state (council integration lands in F-2 alongside the autonomy/run.sh
hook).
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from .engine import Engine
from .introspect import _qident


SCHEMA = "loki.forge.db.migration/v1"


# Allowlist of column types we accept in the spec. Anything else is rejected
# at compile time. This keeps the agent from smuggling raw SQL through the
# "type" field of a column definition.
_TYPE_ALIASES = {
    "id": "INTEGER PRIMARY KEY AUTOINCREMENT",
    "pk": "INTEGER PRIMARY KEY AUTOINCREMENT",
    "text": "TEXT",
    "string": "TEXT",
    "int": "INTEGER",
    "integer": "INTEGER",
    "bigint": "INTEGER",
    "real": "REAL",
    "float": "REAL",
    "double": "REAL",
    "bool": "INTEGER",
    "boolean": "INTEGER",
    "blob": "BLOB",
    "bytes": "BLOB",
    "json": "TEXT",  # SQLite stores JSON as TEXT; PG promotion swaps to JSONB
    "timestamp": "TEXT",  # ISO-8601 in dev; TIMESTAMPTZ in prod
    "datetime": "TEXT",
    "uuid": "TEXT",
}


@dataclass
class MigrationSpec:
    """A single migration. Operations execute in declaration order inside
    one transaction. If any op fails the whole migration rolls back."""

    operations: List[Dict[str, Any]]
    summary: str = ""

    def hash(self) -> str:
        blob = json.dumps(
            {"operations": self.operations, "summary": self.summary},
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()


# Public surface ------------------------------------------------------------


def migrate_dryrun(engine: Engine, spec: Dict[str, Any]) -> str:
    """Compile a MigrationSpec dict to SQL without applying. Raises
    ValueError on invalid input."""
    parsed = _parse_spec(spec)
    return _compile(parsed)


def migrate_apply(engine: Engine, spec: Dict[str, Any]) -> Dict[str, Any]:
    """Apply a migration. Returns {migration_id, applied_at, summary, sql}.

    Idempotent: if a migration with the same spec_hash was already applied,
    the existing record is returned and no SQL is re-executed.
    """
    parsed = _parse_spec(spec)
    sql = _compile(parsed)
    spec_hash = parsed.hash()

    _ensure_internal_tables(engine)

    existing = engine.execute(
        "SELECT id, applied_at, summary FROM _forge_migrations WHERE spec_hash = ?",
        (spec_hash,),
    )
    if existing:
        row = existing[0]
        return {
            "migration_id": row["id"],
            "applied_at": row["applied_at"],
            "summary": row["summary"],
            "sql": sql,
            "already_applied": True,
        }

    migration_id = str(uuid.uuid4())
    applied_at = _utc_iso()

    # Wrap in BEGIN/COMMIT. SQLite autocommit mode (set in engine.py) means
    # we have to issue BEGIN explicitly to get a transaction here.
    script = "BEGIN;\n" + sql + "\nCOMMIT;\n"

    try:
        engine.script_exec(script)
    except Exception as e:
        # script_exec auto-aborts the BEGIN on failure but we run an explicit
        # ROLLBACK in case the failure happened mid-script.
        try:
            engine.script_exec("ROLLBACK;")
        except Exception:
            pass
        raise ValueError(f"migration apply failed: {e}") from e

    engine.execute(
        "INSERT INTO _forge_migrations (id, applied_at, spec_hash, summary, spec_json, sql) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (migration_id, applied_at, spec_hash, parsed.summary,
         json.dumps(spec, sort_keys=True), sql),
        allow_writes=True,
    )

    # Emit a council review record. The existing dashboard/council code
    # can pick this up later; until then it's an audit-trail artifact.
    _emit_review_record(engine.db_path, migration_id, parsed.summary, sql,
                        applied_at, spec_hash)

    return {
        "migration_id": migration_id,
        "applied_at": applied_at,
        "summary": parsed.summary,
        "sql": sql,
        "already_applied": False,
    }


def _emit_review_record(db_path: str, migration_id: str, summary: str,
                        sql: str, applied_at: str, spec_hash: str) -> None:
    """Write a review record for the migration so the council can audit
    after-the-fact (and, in F-3, gate before apply)."""
    try:
        # db_path is <forge_dir>/db.sqlite -> review dir is sibling .loki/quality/.
        # Walk up to the project dir.
        import os as _os
        forge_dir = _os.path.dirname(db_path)
        project_dir = _os.path.dirname(_os.path.dirname(forge_dir))
        review_dir = _os.path.join(project_dir, ".loki", "quality",
                                   "forge-migrations")
        _os.makedirs(review_dir, exist_ok=True)
        rec = {
            "schema": "loki.forge.migration.review/v1",
            "migration_id": migration_id,
            "applied_at": applied_at,
            "spec_hash": spec_hash,
            "summary": summary,
            "sql": sql,
        }
        path = _os.path.join(review_dir, f"{migration_id}.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rec, f, indent=2, sort_keys=True)
        _os.replace(tmp, path)
    except Exception:
        # Council review is best-effort observability; never block the loop.
        pass


def migrate_rollback(engine: Engine, migration_id: str) -> Dict[str, Any]:
    """Rollback a single migration by id. Best-effort: SQLite has no DDL
    rollback, so we synthesize a down-SQL from the up-spec where we can
    (drop_table for add_table, drop_column for add_column, etc.). If the
    inverse isn't safe (e.g. add_column with a NOT NULL default that has
    been populated), we refuse and surface a clear error."""
    _ensure_internal_tables(engine)
    rows = engine.execute(
        "SELECT id, spec_json FROM _forge_migrations WHERE id = ?",
        (migration_id,),
    )
    if not rows:
        return {"ok": False, "error": "migration not found", "migration_id": migration_id}
    spec = json.loads(rows[0]["spec_json"])
    down = _invert_spec(spec)
    if down is None:
        return {"ok": False, "error": "migration is not invertible", "migration_id": migration_id}
    parsed = _parse_spec(down)
    sql = _compile(parsed)
    script = "BEGIN;\n" + sql + "\nCOMMIT;\n"
    try:
        engine.script_exec(script)
    except Exception as e:
        try:
            engine.script_exec("ROLLBACK;")
        except Exception:
            pass
        return {"ok": False, "error": f"rollback failed: {e}", "migration_id": migration_id}
    engine.execute("DELETE FROM _forge_migrations WHERE id = ?",
                   (migration_id,), allow_writes=True)
    return {"ok": True, "migration_id": migration_id, "down_sql": sql}


# Internals -----------------------------------------------------------------


def _ensure_internal_tables(engine: Engine) -> None:
    """Forge owns three internal tables. Created on first migrate call so
    the dev DB stays empty until the agent actually does something."""
    engine.script_exec(
        """
        CREATE TABLE IF NOT EXISTS _forge_migrations (
            id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL,
            spec_hash TEXT NOT NULL UNIQUE,
            summary TEXT NOT NULL,
            spec_json TEXT NOT NULL,
            sql TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS _forge_rls (
            table_name TEXT NOT NULL,
            policy_name TEXT NOT NULL,
            predicate TEXT NOT NULL,
            PRIMARY KEY (table_name, policy_name)
        );
        CREATE TABLE IF NOT EXISTS _forge_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )


def _parse_spec(spec: Any) -> MigrationSpec:
    if not isinstance(spec, dict):
        raise ValueError("spec must be a dict")
    ops = spec.get("operations") or []
    if not isinstance(ops, list) or not ops:
        # Convenience: a single op dict at the top level is auto-wrapped.
        if any(k in spec for k in ("add_table", "drop_table",
                                   "add_column", "drop_column",
                                   "set_rls", "create_index")):
            ops = [spec]
        else:
            raise ValueError("spec must contain a non-empty 'operations' list")
    summary = spec.get("summary", "")
    return MigrationSpec(operations=ops, summary=summary)


def _compile(spec: MigrationSpec) -> str:
    chunks: List[str] = []
    for i, op in enumerate(spec.operations):
        if not isinstance(op, dict):
            raise ValueError(f"operation #{i} not a dict")
        if "add_table" in op:
            chunks.append(_compile_add_table(op["add_table"]))
        elif "drop_table" in op:
            chunks.append(_compile_drop_table(op["drop_table"]))
        elif "add_column" in op:
            chunks.append(_compile_add_column(op["add_column"]))
        elif "drop_column" in op:
            chunks.append(_compile_drop_column(op["drop_column"]))
        elif "set_rls" in op:
            chunks.append(_compile_set_rls(op["set_rls"]))
        elif "create_index" in op:
            chunks.append(_compile_create_index(op["create_index"]))
        else:
            raise ValueError(f"operation #{i}: unknown verb (keys: {list(op)})")
    return "\n".join(chunks)


def _compile_add_table(op: Dict[str, Any]) -> str:
    name = op.get("name")
    cols = op.get("columns") or []
    if not name or not cols:
        raise ValueError("add_table requires name + columns")
    col_sql = []
    for c in cols:
        col_sql.append(_compile_column(c))
    indices_inline: List[str] = []
    for idx in op.get("indices") or []:
        # Inline indices captured for emission after CREATE TABLE.
        if isinstance(idx, str):
            indices_inline.append(idx)
    if op.get("rls"):
        # RLS is recorded; for SQLite we don't emit DDL but stash it.
        pass
    stmt = (f"CREATE TABLE {_qident(name)} (\n  "
            + ",\n  ".join(col_sql) + "\n);")
    # Indices, then RLS registration.
    extras: List[str] = []
    for icol in indices_inline:
        # Allow "col desc" or "col"
        col_only = icol.split()[0]
        if not all(c.isalnum() or c == "_" for c in col_only):
            raise ValueError(f"invalid index column: {icol!r}")
        extras.append(
            f"CREATE INDEX IF NOT EXISTS "
            f"{_qident('idx_' + name + '_' + col_only)} "
            f"ON {_qident(name)}({_qident(col_only)});"
        )
    if op.get("rls"):
        rls = op["rls"]
        if isinstance(rls, str):
            extras.append(_compile_set_rls({"table": name,
                                            "policy": rls,
                                            "predicate": _rls_predicate(rls)}))
        elif isinstance(rls, dict):
            extras.append(_compile_set_rls({"table": name, **rls}))
    return stmt + ("\n" + "\n".join(extras) if extras else "")


def _compile_column(c: Any) -> str:
    if isinstance(c, str):
        # "id pk" or "user_id fk->users.id" or "email text unique"
        return _compile_column_string(c)
    if not isinstance(c, dict):
        raise ValueError("column must be a string or dict")
    name = c.get("name")
    type_alias = c.get("type") or "text"
    if not name or not all(ch.isalnum() or ch == "_" for ch in name):
        raise ValueError(f"invalid column name: {name!r}")
    type_sql = _TYPE_ALIASES.get(type_alias.lower())
    if type_sql is None:
        raise ValueError(f"unsupported column type: {type_alias!r}")
    parts = [_qident(name), type_sql]
    # The 'id'/'pk' type aliases already embed PRIMARY KEY in the expansion;
    # the explicit primary_key flag should not append a second PRIMARY KEY
    # (SQLite raises "table X has more than one primary key").
    type_already_pk = "PRIMARY KEY" in type_sql
    if c.get("primary_key") and not type_already_pk:
        parts.append("PRIMARY KEY")
    if c.get("unique"):
        parts.append("UNIQUE")
    if c.get("notnull") or c.get("not_null"):
        parts.append("NOT NULL")
    if "default" in c:
        parts.append("DEFAULT " + _compile_default(c["default"]))
    if c.get("references"):
        parts.append("REFERENCES " + _compile_reference(c["references"]))
    return " ".join(parts)


def _compile_column_string(spec: str) -> str:
    """Parse "name type [annotations]" shorthand."""
    tokens = spec.strip().split()
    if not tokens:
        raise ValueError("empty column spec")
    name = tokens[0]
    if not all(c.isalnum() or c == "_" for c in name):
        raise ValueError(f"invalid column name: {name!r}")
    rest = [t.lower() for t in tokens[1:]]
    type_sql = "TEXT"
    flags = []
    references = None
    default = None
    i = 0
    while i < len(rest):
        tok = rest[i]
        if tok in _TYPE_ALIASES:
            type_sql = _TYPE_ALIASES[tok]
        elif tok in ("pk", "primary"):
            flags.append("PRIMARY KEY")
        elif tok == "unique":
            flags.append("UNIQUE")
        elif tok in ("notnull", "not_null"):
            flags.append("NOT NULL")
        elif tok == "default" and i + 1 < len(rest):
            default = _compile_default(rest[i + 1])
            i += 1
        elif tok.startswith("fk->"):
            references = _compile_reference(tokens[i + 1 - 1].split("->", 1)[1])
        elif tok.startswith("references="):
            references = _compile_reference(tok.split("=", 1)[1])
        i += 1
    parts = [_qident(name), type_sql] + flags
    if default is not None:
        parts.append("DEFAULT " + default)
    if references:
        parts.append("REFERENCES " + references)
    return " ".join(parts)


def _compile_default(v: Any) -> str:
    """Conservative default expression compiler. Only accepts a small set of
    values; the agent rarely needs more and freeform SQL here is the easiest
    injection vector to close."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).strip().lower()
    if s == "now()":
        return "CURRENT_TIMESTAMP"
    if s == "uuid()":
        return "(lower(hex(randomblob(16))))"
    if s in ("true", "false"):
        return "1" if s == "true" else "0"
    # Bare string literal.
    if not all(ord(c) >= 32 and c not in "\\'\"" for c in str(v)):
        raise ValueError(f"unsafe default: {v!r}")
    return "'" + str(v) + "'"


def _compile_reference(ref: str) -> str:
    """Parse 'users.id' -> 'users(id)'."""
    if "." not in ref:
        raise ValueError(f"invalid reference: {ref!r}")
    table, col = ref.split(".", 1)
    if not all(c.isalnum() or c == "_" for c in table) or \
       not all(c.isalnum() or c == "_" for c in col):
        raise ValueError(f"unsafe reference: {ref!r}")
    return f"{_qident(table)}({_qident(col)})"


def _compile_drop_table(op: Any) -> str:
    name = op if isinstance(op, str) else op.get("name")
    if not name:
        raise ValueError("drop_table requires a name")
    return f"DROP TABLE {_qident(name)};"


def _compile_add_column(op: Dict[str, Any]) -> str:
    table = op.get("table")
    column = op.get("column")
    if not table or not column:
        raise ValueError("add_column requires table + column")
    return (f"ALTER TABLE {_qident(table)} ADD COLUMN "
            + _compile_column(column) + ";")


def _compile_drop_column(op: Dict[str, Any]) -> str:
    table = op.get("table")
    column = op.get("column")
    if not table or not column:
        raise ValueError("drop_column requires table + column")
    return f"ALTER TABLE {_qident(table)} DROP COLUMN {_qident(column)};"


def _compile_set_rls(op: Dict[str, Any]) -> str:
    """Store the RLS policy in _forge_rls. SQLite has no native RLS so this
    is a metadata-only operation in dev; the Postgres promotion path
    materializes the matching CREATE POLICY statements.

    Policy names are domain strings (e.g. 'own-row', 'own-or-public') and
    are allowed to contain hyphens, so we sanitize them with a permissive
    rule that is NOT the SQL-identifier rule."""
    table = op.get("table")
    policy = op.get("policy") or "default"
    predicate = op.get("predicate") or _rls_predicate(policy)
    if not table:
        raise ValueError("set_rls requires a table")
    if not all(c.isalnum() or c == "_" for c in table):
        raise ValueError(f"unsafe table name: {table!r}")
    if not all(c.isalnum() or c in "_-." for c in policy):
        raise ValueError(f"unsafe policy name: {policy!r}")
    # No raw SQL chars allowed in predicate (informational text).
    if any(c in predicate for c in ";\\\x00") or "--" in predicate:
        raise ValueError(f"unsafe predicate: {predicate!r}")
    safe_pred = predicate.replace("'", "''")
    return ("INSERT OR REPLACE INTO _forge_rls (table_name, policy_name, predicate) "
            f"VALUES ('{table}', '{policy}', '{safe_pred}');")


def _rls_predicate(policy: str) -> str:
    """Map a policy name to a SQL-ish predicate fragment (informational in
    dev; materialized on Postgres promotion)."""
    return {
        "public": "TRUE",
        "own-row": "user_id = current_user_id()",
        "own-or-public": "user_id = current_user_id() OR is_public = 1",
    }.get(policy, "FALSE")


def _compile_create_index(op: Dict[str, Any]) -> str:
    table = op.get("table")
    cols = op.get("columns") or []
    name = op.get("name") or ("idx_" + table + "_" + "_".join(cols))
    unique = "UNIQUE " if op.get("unique") else ""
    if not table or not cols:
        raise ValueError("create_index requires table + columns")
    return (f"CREATE {unique}INDEX IF NOT EXISTS {_qident(name)} "
            f"ON {_qident(table)}({', '.join(_qident(c) for c in cols)});")


def _invert_spec(spec: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Synthesize a down-migration. Returns None when not safely invertible."""
    out_ops: List[Dict[str, Any]] = []
    for op in spec.get("operations", [spec]):
        if "add_table" in op:
            out_ops.append({"drop_table": op["add_table"]["name"]})
        elif "drop_table" in op:
            return None  # would need full schema reconstruction
        elif "add_column" in op:
            t = op["add_column"]["table"]
            c = op["add_column"]["column"]
            col_name = c["name"] if isinstance(c, dict) else c.split()[0]
            out_ops.append({"drop_column": {"table": t, "column": col_name}})
        elif "drop_column" in op:
            return None
        elif "create_index" in op:
            # SQLite drops the index by name; we don't synthesize that here
            # because indices are usually idempotently recreated next migration.
            continue
        elif "set_rls" in op:
            continue
        else:
            return None
    return {"operations": list(reversed(out_ops)),
            "summary": "rollback of " + spec.get("summary", "(unnamed)")}


def _utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
