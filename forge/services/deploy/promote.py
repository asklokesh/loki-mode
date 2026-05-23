"""Deploy promotion controller.

F-3 implementation: Railway only. The promote() flow runs:

    1. Dump current forge state via forge_state_dump
    2. Render a provider-native deploy plan (Nixpacks + service env +
       Postgres + Redis for Railway)
    3. Apply the plan (in F-3: write to disk + record promotion; the
       actual Railway-API call lives in the user-app deployment flow
       so Loki itself never holds Railway credentials).
    4. Record promotion in <forge_dir>/deploy/promotions.jsonl

This is the structural break from InsForge: we don't manage deploys
ourselves; we *plan* the deploy and hand it off to the user's CI.
That keeps the Loki sandbox secure and the user in control.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional


class DeployError(Exception):
    pass


_ALLOWED_PROVIDERS = {"railway", "fly", "vercel", "cloudflare", "local"}
_ALLOWED_ENVS = {"dev", "staging", "prod"}


def _config_path(forge_dir: str, provider: str) -> str:
    return os.path.join(forge_dir, "deploy", f"{provider}.json")


def setup_provider(forge_dir: str, provider: str, *,
                   credentials_ref: Optional[str] = None,
                   project_id: Optional[str] = None,
                   region: Optional[str] = None) -> Dict[str, Any]:
    if provider not in _ALLOWED_PROVIDERS:
        raise DeployError(f"unsupported provider: {provider!r}")
    if credentials_ref is not None and not (
        isinstance(credentials_ref, str)
        and credentials_ref.replace("_", "").isalnum()
    ):
        raise DeployError("credentials_ref must be a forge secret name")
    cfg = {
        "provider": provider,
        "credentials_ref": credentials_ref,
        "project_id": project_id,
        "region": region,
        "configured_at": int(time.time()),
    }
    os.makedirs(os.path.dirname(_config_path(forge_dir, provider)),
                exist_ok=True)
    tmp = _config_path(forge_dir, provider) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)
    os.replace(tmp, _config_path(forge_dir, provider))
    os.chmod(_config_path(forge_dir, provider), 0o600)
    return cfg


def plan(forge_dir: str, provider: str, *,
         env: str = "prod") -> Dict[str, Any]:
    if provider not in _ALLOWED_PROVIDERS:
        raise DeployError(f"unsupported provider: {provider!r}")
    if env not in _ALLOWED_ENVS:
        raise DeployError(f"env must be one of {sorted(_ALLOWED_ENVS)}")
    # Pull live state.
    state: Dict[str, Any] = {}
    try:
        from forge.services.database import open_engine, introspect
        if os.path.exists(os.path.join(forge_dir, "db.sqlite")):
            state["database"] = introspect(open_engine(forge_dir))
    except Exception as e:
        state["database_error"] = str(e)
    try:
        from forge.services.storage import list_buckets
        state["buckets"] = list_buckets(forge_dir)
    except Exception:
        state["buckets"] = []
    try:
        from forge.services.functions import list_functions
        state["functions"] = list_functions(forge_dir)
    except Exception:
        state["functions"] = []
    try:
        from forge.services.schedules import list_schedules
        state["schedules"] = list_schedules(forge_dir)
    except Exception:
        state["schedules"] = []
    try:
        from forge.services.secrets import list_secrets
        state["secrets"] = [s["name"] for s in list_secrets(forge_dir)]
    except Exception:
        state["secrets"] = []

    if provider == "railway":
        return _plan_railway(state, env)
    if provider == "fly":
        return _plan_fly(state, env)
    if provider == "vercel":
        return _plan_vercel(state, env)
    if provider == "cloudflare":
        return _plan_cloudflare(state, env)
    if provider == "local":
        return _plan_local(state, env)
    raise DeployError(f"no planner for {provider}")


def _plan_railway(state: Dict[str, Any], env: str) -> Dict[str, Any]:
    """Render a Railway plan: one service + Postgres + (Redis if realtime
    or rate limiting present)."""
    services: List[Dict[str, Any]] = [
        {
            "name": "app",
            "builder": "nixpacks",
            "envs_required": state.get("secrets", []),
            "exposed_port": 3000,
        }
    ]
    if state.get("database"):
        services.append({"name": "postgres", "plugin": "postgresql"})
    if state.get("functions") or state.get("schedules"):
        services.append({"name": "redis", "plugin": "redis"})
    return {
        "schema": "loki.forge.deploy.plan/v1",
        "provider": "railway",
        "env": env,
        "services": services,
        "buckets": [b["name"] for b in state.get("buckets", [])],
        "functions": [f["name"] for f in state.get("functions", [])],
        "schedules": [s["name"] for s in state.get("schedules", [])],
    }


def _plan_fly(state: Dict[str, Any], env: str) -> Dict[str, Any]:
    return {
        "schema": "loki.forge.deploy.plan/v1",
        "provider": "fly",
        "env": env,
        "primary_region": "iad",
        "app_name": f"forge-{env}",
        "vm_size": "shared-cpu-1x",
        "buckets": [b["name"] for b in state.get("buckets", [])],
        "functions": [f["name"] for f in state.get("functions", [])],
        "schedules": [s["name"] for s in state.get("schedules", [])],
        "envs_required": state.get("secrets", []),
    }


def _plan_vercel(state: Dict[str, Any], env: str) -> Dict[str, Any]:
    return {
        "schema": "loki.forge.deploy.plan/v1",
        "provider": "vercel",
        "env": env,
        "framework": "nextjs",
        "envs_required": state.get("secrets", []),
        "kv": bool(state.get("functions")),
        "blob": bool(state.get("buckets")),
        "postgres": bool(state.get("database")),
    }


def _plan_cloudflare(state: Dict[str, Any], env: str) -> Dict[str, Any]:
    return {
        "schema": "loki.forge.deploy.plan/v1",
        "provider": "cloudflare",
        "env": env,
        "workers": [f["name"] for f in state.get("functions", [])],
        "r2_buckets": [b["name"] for b in state.get("buckets", [])],
        "d1_databases": ["forge"] if state.get("database") else [],
        "queues": [s["name"] for s in state.get("schedules", [])],
        "envs_required": state.get("secrets", []),
    }


def _plan_local(state: Dict[str, Any], env: str) -> Dict[str, Any]:
    services = ["app"]
    if state.get("database"):
        services.append("postgres")
    if state.get("functions") or state.get("schedules"):
        services.append("redis")
    return {
        "schema": "loki.forge.deploy.plan/v1",
        "provider": "local",
        "env": env,
        "compose_services": services,
    }


def promote(forge_dir: str, provider: str, *,
            from_env: str = "dev", to_env: str = "prod") -> Dict[str, Any]:
    if from_env not in _ALLOWED_ENVS or to_env not in _ALLOWED_ENVS:
        raise DeployError("env must be dev/staging/prod")
    cfg_path = _config_path(forge_dir, provider)
    if not os.path.isfile(cfg_path):
        raise DeployError(
            f"provider {provider} not configured; call setup_provider first"
        )
    p = plan(forge_dir, provider, env=to_env)
    rec = {
        "promotion_id": uuid.uuid4().hex,
        "provider": provider,
        "from_env": from_env,
        "to_env": to_env,
        "plan": p,
        "started_at": int(time.time()),
        "status": "planned",
    }
    log_path = os.path.join(forge_dir, "deploy", "promotions.jsonl")
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    return rec


def rollback(forge_dir: str, provider: str, *,
             env: str = "prod") -> Dict[str, Any]:
    """Mark the last promotion as rolled-back (records intent; the actual
    rollback runs in the user-app CI based on the promotion record)."""
    log_path = os.path.join(forge_dir, "deploy", "promotions.jsonl")
    if not os.path.isfile(log_path):
        return {"ok": False, "error": "no promotions"}
    try:
        lines = open(log_path, "r", encoding="utf-8").readlines()
    except OSError as e:
        return {"ok": False, "error": str(e)}
    matching = [
        json.loads(l) for l in lines
        if l.strip() and json.loads(l).get("provider") == provider
        and json.loads(l).get("to_env") == env
    ]
    if not matching:
        return {"ok": False, "error": "no promotion for env"}
    last = matching[-1]
    rec = {
        "rollback_id": uuid.uuid4().hex,
        "of_promotion": last["promotion_id"],
        "provider": provider,
        "env": env,
        "started_at": int(time.time()),
    }
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps({**last, **rec, "status": "rolled_back"},
                            separators=(",", ":")) + "\n")
    return {"ok": True, **rec}


def status(forge_dir: str, provider: str, *,
           env: str = "prod") -> Dict[str, Any]:
    log_path = os.path.join(forge_dir, "deploy", "promotions.jsonl")
    if not os.path.isfile(log_path):
        return {"provider": provider, "env": env, "history": []}
    history: List[Dict[str, Any]] = []
    try:
        for line in open(log_path, "r", encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("provider") != provider or rec.get("to_env") != env:
                continue
            history.append(rec)
    except OSError:
        pass
    return {
        "provider": provider,
        "env": env,
        "last_status": history[-1]["status"] if history else "no_promotions",
        "history": history[-10:],
    }
