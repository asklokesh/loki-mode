"""Forge database service - SQLite (dev) backend with introspection and
spec-driven migrations.

Public API:
    open_engine(forge_dir) -> Engine
    Engine.execute(sql, params) -> rows
    Engine.introspect() -> Dict
    Engine.migrate_dryrun(spec) -> sql_text
    Engine.migrate_apply(spec) -> migration_id
    Engine.migrate_rollback(migration_id) -> bool

The Postgres path arrives in F-2 behind the same surface. F-1 ships only
SQLite so the deployment story stays zero-dependency.
"""

from __future__ import annotations

from .engine import Engine, open_engine  # noqa: F401
from .introspect import introspect  # noqa: F401
from .migrate import migrate_apply, migrate_dryrun, migrate_rollback, MigrationSpec  # noqa: F401
from .seed import seed  # noqa: F401
