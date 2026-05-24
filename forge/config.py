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


def find_local_override(project_dir: str) -> Optional[str]:
    """X-74: per-developer override at .loki/forge.local.yaml. Merged
    into the project-root config when apply() runs."""
    for name in ("forge.local.yaml", "forge.local.yml"):
        path = os.path.join(project_dir, ".loki", name)
        if os.path.isfile(path) and not os.path.islink(path):
            return path
    return None


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """X-74: simple deep merge. Lists are concatenated; dicts merged;
    scalars from override win."""
    out = dict(base)
    for k, v in override.items():
        if k in out:
            if isinstance(out[k], dict) and isinstance(v, dict):
                out[k] = _deep_merge(out[k], v)
            elif isinstance(out[k], list) and isinstance(v, list):
                out[k] = out[k] + v
            else:
                out[k] = v
        else:
            out[k] = v
    return out


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


_ALLOWED_TOP_KEYS = {
    "schema_version", "compliance_preset", "tables", "auth",
    "storage", "schedules", "gateway", "secrets",
}


def validate(cfg: Dict[str, Any], *, strict: bool = False) -> Dict[str, Any]:
    """X-58: structural validation of a parsed forge.yaml. Returns
    {errors, warnings}; never raises.

    N-01: when strict=True every warning is promoted to an error so
    CI can gate on "no unknown keys / unknown rls / unsupported
    schema_version" rather than tolerating drift.
    """
    errors: List[str] = []
    warnings: List[str] = []
    if not isinstance(cfg, dict):
        return {"errors": ["forge.yaml root must be a mapping"],
                "warnings": []}
    for k in cfg.keys():
        if k not in _ALLOWED_TOP_KEYS:
            warnings.append(
                f"unknown top-level key: {k!r} "
                f"(allowed: {sorted(_ALLOWED_TOP_KEYS)})"
            )
    sv = cfg.get("schema_version")
    if sv not in (None, 1, "1"):
        warnings.append(
            f"unsupported schema_version: {sv!r} (only 1 is known)"
        )
    for t in cfg.get("tables") or []:
        if not isinstance(t, dict):
            errors.append(f"tables[]: must be a dict, got {type(t).__name__}")
            continue
        if not t.get("name"):
            errors.append("tables[]: needs a `name`")
        if "rls" in t and t["rls"] not in (
            "public", "own-row", "own-or-public", "custom",
        ):
            warnings.append(
                f"tables.{t.get('name')!r}: unknown rls {t['rls']!r}"
            )
        cols = t.get("columns")
        if cols is not None and not isinstance(cols, list):
            errors.append(
                f"tables.{t.get('name')!r}: columns must be a list"
            )
    auth = cfg.get("auth") or {}
    if not isinstance(auth, dict):
        errors.append("auth: must be a mapping")
    else:
        for p in auth.get("providers") or []:
            if not isinstance(p, str):
                errors.append(f"auth.providers[]: each entry must be a string")
    storage = cfg.get("storage") or {}
    if not isinstance(storage, dict):
        errors.append("storage: must be a mapping")
    else:
        for b in storage.get("buckets") or []:
            if isinstance(b, str):
                continue
            if not isinstance(b, dict):
                errors.append("storage.buckets[]: each entry must be string or dict")
                continue
            if not b.get("name"):
                errors.append("storage.buckets[]: needs a `name`")
    for s in cfg.get("schedules") or []:
        if not isinstance(s, dict):
            errors.append("schedules[]: each entry must be a dict")
            continue
        if not s.get("name") or not s.get("cron") or not s.get("target"):
            errors.append(
                f"schedules.{s.get('name')!r}: need name + cron + target"
            )
    for r in (cfg.get("gateway") or {}).get("routes") or []:
        if not isinstance(r, dict):
            errors.append("gateway.routes[]: each entry must be a dict")
            continue
        if not r.get("model") or not r.get("provider") or not r.get("base_url"):
            errors.append(
                f"gateway.routes.{r.get('model')!r}: "
                f"need model + provider + base_url"
            )
    # N-01 strict mode: promote warnings to errors.
    if strict and warnings:
        for w in warnings:
            errors.append(f"strict: {w}")
        warnings = []
    return {"errors": errors, "warnings": warnings, "strict": bool(strict)}


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
    # X-74: merge with per-developer override if present.
    override_path = find_local_override(project_dir)
    if override_path:
        override = _parse_yaml(override_path)
        if override:
            cfg = _deep_merge(cfg, override)
    # X-58: lint the structure before doing anything.
    lint_report = validate(cfg)
    if lint_report["errors"]:
        return {"applied": [], "skipped": [],
                "errors": [f"validation: {e}" for e in lint_report["errors"]],
                "warnings": lint_report["warnings"]}

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

    # X-70: secrets (names + rotation policy only - values are never
    # in yaml). The agent declares which secrets the project NEEDS;
    # operator/CI populates the values via forge_secret_set.
    for sec in (cfg.get("secrets") or []):
        if isinstance(sec, str):
            name, rotation = sec, None
        elif isinstance(sec, dict):
            name = sec.get("name")
            rotation = sec.get("rotation")
        else:
            continue
        if not name:
            continue
        skipped.append(f"secret_declared:{name}")
        if rotation and not dryrun:
            try:
                from forge.services.secrets import (
                    set_rotation_policy, list_secrets,
                )
                # Skip if no value yet - rotation policy requires the
                # secret exists.
                if any(s["name"] == name for s in list_secrets(fd)):
                    set_rotation_policy(fd, name,
                                        cron=rotation.get("cron", "@monthly"),
                                        action=rotation.get("action", "alert"),
                                        target=rotation.get("target"))
                    applied.append({"secret_rotation": name})
                else:
                    skipped.append(f"secret_rotation:{name}: value not set yet")
            except Exception as e:
                skipped.append(f"secret_rotation:{name}: {e}")

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
