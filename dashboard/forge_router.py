"""Dashboard router for /api/forge/* - Phase F-2.

Exposes read-only forge state over HTTP for the dashboard UI. Mutating
endpoints (which would let any dashboard user reconfigure the user-app
backend) are intentionally not added in F-2; agents perform mutations
via MCP tools.

Wired into dashboard/server.py via the `register_forge_router(app)`
function, which is called at the same point the existing routers are
registered. If forge state is absent the routes still respond - they
just return empty payloads.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional


def _forge_dir() -> str:
    return os.path.abspath(os.path.join(os.getcwd(), ".loki", "forge"))


def register_forge_router(app) -> None:
    """Register /api/forge/* on the given FastAPI app. Idempotent."""
    # Import lazily so the dashboard does not pull forge transitively.
    try:
        from fastapi import HTTPException
    except ImportError:
        # No FastAPI in this env - dashboard would have failed earlier
        # so skip registration silently.
        return

    @app.get("/api/forge/state")
    async def forge_state() -> Dict[str, Any]:
        """Full forge state snapshot. Mirrors forge_state_dump MCP tool."""
        d = _forge_dir()
        out: Dict[str, Any] = {
            "schema": "loki.forge.state/v1",
            "forge_dir": d,
            "exists": os.path.isdir(d),
        }
        if not os.path.isdir(d):
            return out
        # Database
        if os.path.exists(os.path.join(d, "db.sqlite")):
            try:
                from forge.services.database import open_engine, introspect
                out["database"] = introspect(open_engine(d))
            except Exception as e:
                out["database_error"] = str(e)
        # Required (last detector run)
        req_path = os.path.join(d, "required.json")
        if os.path.isfile(req_path):
            try:
                with open(req_path, "r", encoding="utf-8") as f:
                    out["required"] = json.load(f)
            except (OSError, json.JSONDecodeError) as e:
                out["required_error"] = str(e)
        # Auth providers + users
        if os.path.isdir(os.path.join(d, "auth", "providers")):
            try:
                from forge.services.auth import list_providers, list_users
                out["auth"] = {
                    "providers": list_providers(d),
                    "user_count": len(list_users(d, limit=1000)),
                }
            except Exception as e:
                out["auth_error"] = str(e)
        # Storage buckets
        if os.path.isdir(os.path.join(d, "storage")):
            try:
                from forge.services.storage import list_buckets
                out["storage"] = {"buckets": list_buckets(d)}
            except Exception as e:
                out["storage_error"] = str(e)
        # Functions
        if os.path.isdir(os.path.join(d, "functions")):
            try:
                from forge.services.functions import list_functions
                out["functions"] = {"list": list_functions(d)}
            except Exception as e:
                out["functions_error"] = str(e)
        # Gateway routes + usage
        if os.path.isdir(os.path.join(d, "gateway")):
            try:
                from forge.services.gateway import list_routes, usage_summary
                out["gateway"] = {
                    "routes": list_routes(d),
                    "usage": [
                        {"model": k[0], "provider": k[1], **v}
                        for k, v in usage_summary(d).items()
                    ],
                }
            except Exception as e:
                out["gateway_error"] = str(e)
        return out

    @app.get("/api/forge/database/tables")
    async def forge_db_tables() -> Dict[str, Any]:
        d = _forge_dir()
        db_path = os.path.join(d, "db.sqlite")
        if not os.path.exists(db_path):
            return {"tables": []}
        try:
            from forge.services.database import open_engine, introspect
            snap = introspect(open_engine(d))
            return {"tables": snap.get("tables", [])}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    @app.get("/api/forge/database/migrations")
    async def forge_db_migrations() -> Dict[str, Any]:
        """Return the migration history + any pending review records."""
        d = _forge_dir()
        out: Dict[str, Any] = {"history": [], "review_queue": []}
        if os.path.exists(os.path.join(d, "db.sqlite")):
            try:
                from forge.services.database import open_engine, introspect
                out["history"] = introspect(open_engine(d)).get(
                    "internal", {}).get("migrations", [])
            except Exception:
                pass
        rev = os.path.join(os.path.dirname(os.path.dirname(d)),
                           "quality", "forge-migrations")
        if os.path.isdir(rev):
            entries = []
            for f in sorted(os.listdir(rev)):
                if not f.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(rev, f), "r", encoding="utf-8") as fh:
                        entries.append(json.load(fh))
                except (OSError, json.JSONDecodeError):
                    continue
            out["review_queue"] = entries
        return out

    @app.get("/api/forge/storage/buckets")
    async def forge_storage_buckets() -> Dict[str, Any]:
        d = _forge_dir()
        try:
            from forge.services.storage import list_buckets
            return {"buckets": list_buckets(d)}
        except Exception:
            return {"buckets": []}

    @app.get("/api/forge/functions")
    async def forge_functions() -> Dict[str, Any]:
        d = _forge_dir()
        try:
            from forge.services.functions import list_functions
            return {"functions": list_functions(d)}
        except Exception:
            return {"functions": []}

    @app.get("/api/forge/gateway/routes")
    async def forge_gateway_routes(model: Optional[str] = None) -> Dict[str, Any]:
        d = _forge_dir()
        try:
            from forge.services.gateway import list_routes, usage_summary
            return {
                "routes": list_routes(d, model=model),
                "usage": [
                    {"model": k[0], "provider": k[1], **v}
                    for k, v in usage_summary(d, model=model).items()
                ],
            }
        except Exception:
            return {"routes": [], "usage": []}
