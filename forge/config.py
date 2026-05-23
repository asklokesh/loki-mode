"""forge.yaml declarative config (X-49).

The agent (or operator) can drop a `forge.yaml` at the project root
to declare known resources up-front. forge.config.apply() reads it
once on iter 0 and provisions whatever isn't already there. Idempotent
- safe to re-run.

Schema (best-effort YAML; we use the same parse_simple_yaml helper
elsewhere in Loki so projects without yq still work):

    schema_version: 1
    compliance_preset: healthcare        # propagates to LOKI_COMPLIANCE_PRESET
    tables:
      - name: users
        rls: own-row
        columns: [id pk, email text unique notnull, created_at timestamp default(now())]
      - name: posts
        rls: own-or-public
        columns: [id pk, user_id integer notnull references=users.id, ...]
    auth:
      providers: [google, github, magic-link]
    storage:
      buckets:
        - {name: avatars, public: false, region: us-east-1}
        - {name: public-assets, public: true}
    schedules:
      - {name: daily-digest, cron: "0 8 * * *", target: {type: event, topic: digest}}
    gateway:
      routes:
        - {model: claude-sonnet, provider: anthropic, base_url: https://api.anthropic.com}

We use the same yq-or-fallback path as autonomy/run.sh. No new
dependency.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional


def find_config(project_dir: str) -> Optional[str]:
    """Return the path to forge.yaml/forge.yml at the project root, or
    None if not present. Symlinks rejected (path-traversal hardening
    matches the rest of Loki)."""
    for name in ("forge.yaml", "forge.yml"):
        path = os.path.join(project_dir, name)
        if os.path.isfile(path) and not os.path.islink(path):
            return path
    return None


def _parse_yaml(path: str) -> Dict[str, Any]:
    """Lightweight YAML parser - same approach as autonomy/run.sh's
    parse_simple_yaml fallback. We don't pull in PyYAML to keep the
    dep footprint minimal."""
    try:
        import yaml  # type: ignore
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        if not isinstance(data, dict):
            return {}
        return data
    except ImportError:
        # PyYAML not available; best-effort regex parse for the very
        # specific shape forge.yaml uses.
        return _parse_yaml_minimal(path)


def _parse_yaml_minimal(path: str) -> Dict[str, Any]:
    """Minimal YAML reader for forge.yaml. Handles scalar and list-of-
    scalars/dicts at depth 2. Returns an empty dict on errors so the
    detector path keeps working."""
    out: Dict[str, Any] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return out
    # Use a regex that handles `key: value` at top level only.
    for m in re.finditer(r"^([a-z_][a-z0-9_]*)\s*:\s*([^\n]*)$",
                          text, re.MULTILINE):
        key = m.group(1)
        val_text = m.group(2).strip()
        if not val_text:
            continue
        if val_text.startswith("[") and val_text.endswith("]"):
            try:
                out[key] = json.loads(val_text)
            except json.JSONDecodeError:
                pass
        elif val_text.lower() in ("true", "false"):
            out[key] = val_text.lower() == "true"
        else:
            out[key] = val_text.strip("'\"")
    return out


def apply(project_dir: str, forge_dir: Optional[str] = None,
          dryrun: bool = False) -> Dict[str, Any]:
    """Read forge.yaml + apply. Returns {applied, skipped, errors}."""
    config_path = find_config(project_dir)
    if config_path is None:
        return {"applied": [], "skipped": ["no_forge_yaml"], "errors": []}
    cfg = _parse_yaml(config_path)
    if not cfg:
        return {"applied": [], "skipped": ["forge_yaml_empty_or_unreadable"],
                "errors": []}

    fd = forge_dir or os.path.join(project_dir, ".loki", "forge")
    os.makedirs(fd, exist_ok=True)

    applied: List[Dict[str, Any]] = []
    skipped: List[str] = []
    errors: List[str] = []

    # Compliance preset.
    preset = cfg.get("compliance_preset")
    if preset:
        os.environ["LOKI_COMPLIANCE_PRESET"] = str(preset)
        applied.append({"compliance_preset": preset})

    # Tables.
    for t in cfg.get("tables") or []:
        if not isinstance(t, dict) or not t.get("name"):
            continue
        spec = {
            "summary": f"forge.yaml: ensure table {t['name']}",
            "operations": [{"add_table": {
                "name": t["name"],
                "columns": t.get("columns") or ["id pk"],
                "rls": t.get("rls") or "own-row",
                "indices": t.get("indices") or [],
            }}],
        }
        if dryrun:
            applied.append({"table_dryrun": t["name"]})
            continue
        try:
            from forge.services.database import open_engine, migrate_apply
            engine = open_engine(fd)
            res = migrate_apply(engine, spec)
            applied.append({"table": t["name"],
                            "migration_id": res["migration_id"]})
        except Exception as e:
            errors.append(f"table {t['name']}: {e}")

    # Auth providers.
    for p in (cfg.get("auth") or {}).get("providers") or []:
        if dryrun:
            applied.append({"auth_dryrun": p})
            continue
        try:
            from forge.services.auth import add_provider
            add_provider(fd, p, {"_provisioned_by": "forge.yaml"})
            applied.append({"auth_provider": p})
        except Exception as e:
            skipped.append(f"auth:{p}: {e}")

    # Storage buckets.
    for b in (cfg.get("storage") or {}).get("buckets") or []:
        if isinstance(b, str):
            name, public, region = b, False, "auto"
        elif isinstance(b, dict):
            name = b.get("name")
            public = bool(b.get("public"))
            region = b.get("region", "auto")
        else:
            continue
        if not name:
            continue
        if dryrun:
            applied.append({"bucket_dryrun": name})
            continue
        try:
            from forge.services.storage import create_bucket
            create_bucket(fd, name, public=public, region=region)
            applied.append({"bucket": name})
        except Exception as e:
            skipped.append(f"bucket:{name}: {e}")

    # Schedules.
    for s in cfg.get("schedules") or []:
        if not isinstance(s, dict) or not s.get("name"):
            continue
        if dryrun:
            applied.append({"schedule_dryrun": s["name"]})
            continue
        try:
            from forge.services.schedules import create as schedule_create
            schedule_create(fd, s["name"], s["cron"], s.get("target") or {})
            applied.append({"schedule": s["name"]})
        except Exception as e:
            skipped.append(f"schedule:{s['name']}: {e}")

    # Gateway routes.
    for r in (cfg.get("gateway") or {}).get("routes") or []:
        if not isinstance(r, dict) or not r.get("model"):
            continue
        if dryrun:
            applied.append({"route_dryrun": r["model"]})
            continue
        try:
            from forge.services.gateway import add_route
            add_route(fd, r)
            applied.append({"route": r["model"]})
        except Exception as e:
            skipped.append(f"route:{r.get('model')}: {e}")

    return {"applied": applied, "skipped": skipped, "errors": errors,
            "config_path": os.path.abspath(config_path)}
