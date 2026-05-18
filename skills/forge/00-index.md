# Loki Forge - integrated BaaS for the autonomous loop

Loki Forge is the backend-as-a-service the agent uses *during* a RARV
iteration to materialize what the spec demands. The operator does not run
forge subcommands; the agent calls forge MCP tools as part of building the
app described in the PRD.

This file is a progressive-disclosure index. The agent reads it once per
session; per-service detail lives in sibling files.

## What forge provides

Phase F-1 (shipped): spec-driven SQLite database with introspection,
migrations, RLS metadata, and a semantic-layer prompt-injection block.

Phase F-2 (planned): auth providers, file buckets, edge functions, model
gateway, realtime channels, scheduled jobs, secrets vault, payments,
deploy adapters.

See docs/plans/ULTRAPLAN-FORGE-BAAS.md for the full multi-phase plan.

## How to use forge from inside the loop

The semantic-layer block is automatically injected into every iteration's
prompt when forge has state. It contains the live table list, columns,
indices, RLS policies, and a hint listing the MCP tools you can call.

Always call `forge_db_introspect` before writing code that touches the
user-app database. Treat its output as ground truth - do not invent
columns, types, or relationships.

To change the schema, call `forge_db_migrate` with a structured spec dict:

    {
      "summary": "add posts table for the blog feature",
      "operations": [
        {"add_table": {
            "name": "posts",
            "columns": [
              "id pk",
              "user_id integer notnull references=users.id",
              "title text notnull",
              "body text",
              "created_at timestamp default(now())"
            ],
            "rls": "own-or-public",
            "indices": ["user_id", "created_at"]
        }}
      ]
    }

Do NOT call `forge_db_query` with `allow_writes=True` for schema changes.
The migration path keeps state recoverable and integrates with the council
review gate (planned F-2). The query path is for SELECTs only.

## Sibling files

- database.md - Full database service reference (operations, types, RLS).
