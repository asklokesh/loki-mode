# forge database - reference

The forge database service exposes a SQLite-backed dev database under
`.loki/forge/db.sqlite`. Production promotion (F-2) moves this to Postgres
with the same surface so user code never has to switch SDKs.

## MCP tools

- `forge_db_introspect()` - returns `{schema, tables[], internal.migrations[]}`.
  Each table includes columns (name/type/notnull/default/primary_key),
  indices, foreign_keys, rls (declared + policies), and row_count_estimate.

- `forge_db_query(sql, allow_writes=False)` - run a single SQL statement.
  SELECTs (and PRAGMA read forms like `PRAGMA table_info(x)`) always
  allowed. Mutations require `allow_writes=True`; prefer migrations.

- `forge_db_migrate(spec)` - apply a spec-driven migration. Idempotent
  by spec_hash. Returns `{migration_id, applied_at, summary, sql,
  already_applied}`. The spec is a domain dict, not raw SQL.

- `forge_db_migrate_dryrun(spec)` - compile to SQL without applying.

- `forge_db_migrate_rollback(migration_id)` - revert. Best-effort:
  add_table reverts to drop_table; add_column reverts to drop_column.
  Returns `{ok, error?, down_sql?}`.

- `forge_state_dump()` - full forge state snapshot (DB + required.json
  + the prompt-injection block).

## Migration spec verbs (F-1)

- `add_table` - `{name, columns[], rls?, indices?}`
- `drop_table` - `"name"` or `{name}`
- `add_column` - `{table, column}`
- `drop_column` - `{table, column}`
- `set_rls` - `{table, policy, predicate?}`
- `create_index` - `{table, columns[], name?, unique?}`

## Column shorthand

Strings: `"id pk"`, `"email text unique notnull"`,
`"user_id integer notnull references=users.id"`,
`"created_at timestamp default(now())"`.

Dicts (full form): `{"name": "id", "type": "id", "primary_key": true}`.

Type aliases: `id` (= INTEGER PRIMARY KEY AUTOINCREMENT), `pk` (same),
`text`/`string`, `int`/`integer`/`bigint`, `real`/`float`/`double`,
`bool`/`boolean`, `blob`/`bytes`, `json` (TEXT in SQLite; JSONB on Postgres
promotion), `timestamp`/`datetime` (TEXT in SQLite; TIMESTAMPTZ on Postgres),
`uuid` (TEXT). Anything else is rejected.

## RLS policies

The dev SQLite path records RLS as metadata in `_forge_rls`; SQLite cannot
enforce row-level security natively. The Postgres promotion path (F-2)
materializes matching `CREATE POLICY` statements.

Built-in policy names: `public` (TRUE), `own-row`
(`user_id = current_user_id()`), `own-or-public`
(`user_id = current_user_id() OR is_public = 1`). Custom policies pass
their predicate verbatim (sanitized: no `;`, no `--`, no NUL).

## What NOT to do

- Do not bypass migrations with `forge_db_query(allow_writes=True)` for
  schema changes. The migration ledger is how rollback and council review
  stay coherent.
- Do not pass raw SQL into migration specs. The spec compiler exists so
  every change is structurally validated and reversibly recordable.
- Do not assume Postgres semantics in dev. SQLite's type affinity is
  loose; if you need a strict type, declare it explicitly.
