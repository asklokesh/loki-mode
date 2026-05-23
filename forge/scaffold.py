"""X-62: `loki forge init` - scaffold a starter forge.yaml.

Writes a forge.yaml at the project root with comments explaining
each section. Idempotent: refuses to overwrite an existing file
unless force=True.
"""

from __future__ import annotations

import os
from typing import Any, Dict


_TEMPLATE = '''# forge.yaml - declarative backend config for Loki Forge.
# Loki reads this on iter 0 (and on every `loki forge bootstrap`)
# and provisions whatever is declared. Idempotent.

schema_version: 1

# Compliance preset. One of: default, healthcare, fintech, government.
# Propagates to LOKI_COMPLIANCE_PRESET so the rest of Loki sees the
# same tier. See wiki/Loki-Forge.md "compliance" for the rules each
# preset enforces.
compliance_preset: default

# Database tables. Use forge migration spec format:
#   columns: ["id pk", "email text unique notnull", ...]
#   rls: public | own-row | own-or-public | custom
#   soft_delete: true       (adds deleted_at)
#   audit_columns: true     (adds created_by/updated_by/version)
tables: []

# Auth providers (OAuth + local). Names: google, github, apple,
# microsoft, gitlab, discord, slack, email-password, magic-link,
# webauthn.
auth:
  providers: []

# Storage buckets.
#   name (required), public (default false), region (default 'auto')
storage:
  buckets: []

# Scheduled jobs. target.type: function | url | event.
schedules: []

# Model gateway routes. Cost-aware routing picks the cheapest viable
# route per model.
gateway:
  routes: []

# Secrets are NOT declared here - use `forge_secret_set` or the
# `loki forge` CLI. forge.yaml is a place for declarations, not
# secret values.
'''


def init(project_dir: str, *, force: bool = False) -> Dict[str, Any]:
    """Write a starter forge.yaml at project_dir/forge.yaml.

    Returns {created, path}. Refuses to overwrite existing yaml
    unless force=True.
    """
    path = os.path.join(project_dir, "forge.yaml")
    if os.path.exists(path) and not force:
        return {
            "created": False,
            "path": path,
            "error": "file exists; pass force=True to overwrite",
        }
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(_TEMPLATE)
    os.replace(tmp, path)
    return {"created": True, "path": os.path.abspath(path)}
