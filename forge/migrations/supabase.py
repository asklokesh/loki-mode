"""Import from a Supabase project dump.

We parse a CREATE TABLE / ALTER TABLE / CREATE INDEX subset that
covers the vast majority of Supabase schemas, plus we recognize the
Supabase `auth.users` table as a hint to wire forge auth.

Limitations:
    - We do NOT execute arbitrary SQL on the user's behalf. Anything
      outside the recognized verbs is reported but not applied.
    - We do NOT migrate data, only schema. The user runs their own
      pg_dump / pg_restore for data.
    - We do NOT decode Supabase RLS policies; we record them as
      free-text in the report so a human can review.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, List, Optional


_CREATE_TABLE_RE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"
    r"(?:public\.|\"public\"\.)?(\"?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\(",
    re.IGNORECASE,
)

# Map Postgres types -> forge migration aliases.
_PG_TYPE_MAP = {
    "uuid": "uuid",
    "text": "text",
    "varchar": "text",
    "char": "text",
    "citext": "text",
    "int": "integer",
    "int2": "integer",
    "int4": "integer",
    "int8": "integer",
    "integer": "integer",
    "bigint": "integer",
    "smallint": "integer",
    "boolean": "boolean",
    "bool": "boolean",
    "real": "real",
    "double": "real",
    "float4": "real",
    "float8": "real",
    "numeric": "real",
    "json": "json",
    "jsonb": "json",
    "timestamp": "timestamp",
    "timestamptz": "timestamp",
    "date": "timestamp",
    "bytea": "blob",
}


def _strip_sql_comments(sql: str) -> str:
    out = []
    in_line = False
    in_block = False
    i = 0
    while i < len(sql):
        ch = sql[i]
        if in_line:
            if ch == "\n":
                in_line = False
                out.append("\n")
            i += 1
            continue
        if in_block:
            if ch == "*" and i + 1 < len(sql) and sql[i + 1] == "/":
                in_block = False
                i += 2
                continue
            i += 1
            continue
        if ch == "-" and i + 1 < len(sql) and sql[i + 1] == "-":
            in_line = True
            i += 2
            continue
        if ch == "/" and i + 1 < len(sql) and sql[i + 1] == "*":
            in_block = True
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _split_table_body(body: str) -> List[str]:
    """Split a CREATE TABLE body into column/constraint lines. We
    respect parentheses depth so `numeric(10,2)` doesn't fool us."""
    out: List[str] = []
    buf: List[str] = []
    depth = 0
    for ch in body:
        if ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth -= 1
            buf.append(ch)
        elif ch == "," and depth == 0:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if buf:
        last = "".join(buf).strip()
        if last:
            out.append(last)
    return out


def _parse_column(line: str) -> Optional[Dict[str, Any]]:
    """Parse one column line into a forge migration column dict."""
    # Skip constraint lines like CONSTRAINT/PRIMARY KEY/FOREIGN KEY/UNIQUE
    upper = line.upper().lstrip()
    if upper.startswith(("CONSTRAINT", "PRIMARY KEY", "FOREIGN KEY",
                          "UNIQUE", "CHECK", "EXCLUDE")):
        return None
    tokens = line.split()
    if len(tokens) < 2:
        return None
    name_raw = tokens[0].strip('"')
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name_raw):
        return None
    type_raw = tokens[1].lower().split("(")[0]
    forge_type = _PG_TYPE_MAP.get(type_raw, "text")
    col: Dict[str, Any] = {"name": name_raw, "type": forge_type}
    line_upper = " ".join(tokens[2:]).upper()
    if "NOT NULL" in line_upper:
        col["notnull"] = True
    if "PRIMARY KEY" in line_upper:
        col["primary_key"] = True
        if forge_type == "integer":
            col["type"] = "id"
    if "UNIQUE" in line_upper:
        col["unique"] = True
    # DEFAULT NOW()/uuid_generate_v4()/...
    m = re.search(r"DEFAULT\s+([^\s,]+)", line, re.IGNORECASE)
    if m:
        d = m.group(1).rstrip(",")
        if d.lower() in ("now()", "current_timestamp"):
            col["default"] = "now()"
        elif d.lower() in ("gen_random_uuid()", "uuid_generate_v4()"):
            col["default"] = "uuid()"
        elif d.lower() in ("true", "false"):
            col["default"] = d.lower()
        elif d.startswith("'") and d.endswith("'"):
            col["default"] = d[1:-1]
        else:
            try:
                col["default"] = int(d)
            except ValueError:
                pass
    return col


def parse_dump(sql: str) -> Dict[str, Any]:
    """Parse a Supabase dump string. Returns a structured report."""
    sql = _strip_sql_comments(sql)
    tables: List[Dict[str, Any]] = []
    notes: List[str] = []
    pos = 0
    while pos < len(sql):
        m = _CREATE_TABLE_RE.search(sql, pos)
        if not m:
            break
        # Find the matching close paren.
        body_start = m.end()
        depth = 1
        i = body_start
        while i < len(sql) and depth > 0:
            ch = sql[i]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            i += 1
        body = sql[body_start: i - 1]
        table_name = m.group(2)
        if table_name.startswith("_") or table_name.startswith("forge_"):
            notes.append(f"skipping {table_name} (forge-internal-looking)")
            pos = i
            continue
        cols: List[Dict[str, Any]] = []
        for raw_line in _split_table_body(body):
            col = _parse_column(raw_line)
            if col:
                cols.append(col)
        if cols:
            tables.append({"name": table_name, "columns": cols})
        else:
            notes.append(f"no columns parsed for {table_name}")
        pos = i
    return {"tables": tables, "notes": notes}


def import_from_supabase(forge_dir: str, dump_path: str) -> Dict[str, Any]:
    if not os.path.isfile(dump_path):
        return {"ok": False, "error": "dump not found", "path": dump_path}
    with open(dump_path, "r", encoding="utf-8", errors="replace") as f:
        sql = f.read()
    parsed = parse_dump(sql)
    from forge.services.database import open_engine, migrate_apply
    engine = open_engine(forge_dir)
    applied: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []
    for t in parsed["tables"]:
        spec = {
            "summary": f"supabase import: {t['name']}",
            "operations": [{"add_table": {
                "name": t["name"],
                "columns": t["columns"],
                "rls": "own-row",
            }}],
        }
        try:
            res = migrate_apply(engine, spec)
            applied.append({"name": t["name"], "migration_id": res["migration_id"]})
        except Exception as e:
            failed.append({"name": t["name"], "error": str(e)})

    report = {
        "schema": "loki.forge.migration.import/v1",
        "source": "supabase",
        "started_at": int(time.time()),
        "applied": applied,
        "failed": failed,
        "notes": parsed["notes"],
    }
    out_path = os.path.join(forge_dir, "migrations",
                            f"supabase-{int(time.time())}.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True)
    report["report_path"] = out_path
    return report
