"""Forge migration tooling - import from Supabase / InsForge.

Goal: a user on Supabase or InsForge can mount their existing schema
dump as input and we materialize the equivalent forge state. This is
strictly *additive*: we never call the source provider's API; we read
files the user supplies.

Inputs we accept:
    - Supabase: a `supabase db dump` SQL file + their `auth.users` table
      structure (we map Supabase auth -> forge auth)
    - InsForge: their `loki migrate-from insforge --export` JSON which
      contains tables, buckets, functions, schedules, secrets (names only)

Outputs: a sequence of forge migrations applied in order, plus a
report file at <forge_dir>/migrations/import-<ts>.json.
"""

from __future__ import annotations

from .supabase import import_from_supabase  # noqa: F401
from .insforge import import_from_insforge  # noqa: F401
