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

    @app.get("/api/forge/health")
    async def forge_health() -> Dict[str, Any]:
        """X-29 health check. Flips RED based on the same FRG* codes the
        sandbox diagnose surfaces. Lightweight; safe to poll."""
        d = _forge_dir()
        codes: list = []
        if os.path.isdir(d):
            if os.path.isfile(os.path.join(d, "required.json")) \
               and not os.path.isfile(os.path.join(d, "db.sqlite")):
                codes.append({"code": "FRG001", "severity": "warn",
                              "message": "required.json present but db.sqlite missing"})
            errlog = os.path.join(d, "errors.log")
            if os.path.isfile(errlog) and os.path.getsize(errlog) > 0:
                codes.append({"code": "FRG002", "severity": "warn",
                              "message": "forge_detector errors.log non-empty"})
            vault = os.path.join(d, "secrets.vault")
            if os.path.isfile(vault):
                try:
                    text = open(vault, "r", encoding="utf-8", errors="replace").read()
                    if '"HMAC-XOR"' in text:
                        codes.append({"code": "FRG003", "severity": "warn",
                                      "message": "secrets vault on HMAC-XOR fallback"})
                except OSError:
                    pass
        severity_max = (max((c["severity"] for c in codes),
                            key=lambda s: {"info": 0, "warn": 1, "critical": 2}.get(s, 0))
                        if codes else "ok")
        return {
            "schema": "loki.forge.health/v1",
            "forge_dir": d,
            "ok": not codes,
            "status": severity_max,
            "codes": codes,
        }

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

    # --- X-13: OpenAI-compat model gateway HTTP front --------------------
    # POST /forge/gateway/v1/chat/completions
    # Body: {"model": "<name>", "messages": [...], "max_tokens": ...}
    # Routes via pick_route() and either streams from the upstream
    # provider or returns the full response. F-5: the upstream call is
    # delegated to a forge function the agent has deployed; if no such
    # function exists we surface a clear error rather than embed an
    # HTTP client for every provider in Loki itself.

    try:
        from fastapi import Body, Request, HTTPException
        from fastapi.responses import JSONResponse
        _FASTAPI_OK = True
    except ImportError:
        _FASTAPI_OK = False

    if _FASTAPI_OK:
        @app.post("/forge/gateway/v1/chat/completions")
        async def forge_gateway_chat(req: Request) -> Any:
            d = _forge_dir()
            body = await req.json()
            model = body.get("model")
            if not isinstance(model, str) or not model:
                raise HTTPException(status_code=400, detail="model required")
            try:
                from forge.services.gateway import pick_route, record_usage
                from forge.services.functions import invoke as fn_invoke, get_function
            except ImportError as e:
                raise HTTPException(status_code=503, detail=f"forge unavailable: {e}")
            route = pick_route(d, model)
            if route is None:
                raise HTTPException(status_code=404,
                                    detail=f"no route for model {model}")
            # The forge function `gateway_dispatch` (if deployed) handles
            # the upstream call. This keeps provider HTTP clients out of
            # Loki itself.
            if not get_function(d, "gateway_dispatch"):
                return JSONResponse(
                    status_code=501,
                    content={
                        "error": "gateway_dispatch function not deployed",
                        "hint": "deploy a forge function named 'gateway_dispatch' "
                                "that takes {model, route, body} and returns the "
                                "upstream response",
                        "route": route,
                    },
                )
            import time as _time
            t0 = _time.time()
            res = fn_invoke(d, "gateway_dispatch",
                            payload={"model": model, "route": route, "body": body})
            latency_ms = int((_time.time() - t0) * 1000)
            try:
                record_usage(d, model, route["provider"],
                             latency_ms=latency_ms,
                             input_tokens=int(body.get("_input_tokens") or 0),
                             output_tokens=int(body.get("_output_tokens") or 0),
                             ok=bool(res.get("ok")))
            except Exception:
                pass
            if not res.get("ok"):
                raise HTTPException(status_code=502,
                                    detail={"upstream_error": res.get("stderr"),
                                            "exit_code": res.get("exit_code")})
            try:
                return json.loads(res["stdout"])
            except (json.JSONDecodeError, TypeError):
                return {"raw_stdout": res.get("stdout", "")}

        # --- X-14: Realtime WebSocket endpoint --------------------------
        # /forge/realtime/v1?channel=<name> - mounts on the existing
        # dashboard WS manager so we inherit 30s keepalive + per-IP
        # rate limit. Each connected client subscribes via the bus.

        from fastapi import WebSocket as _WS, WebSocketDisconnect as _WSD

        @app.websocket("/forge/realtime/v1")
        async def forge_realtime_ws(websocket: _WS) -> None:
            channel = websocket.query_params.get("channel")
            if not channel:
                await websocket.accept()
                await websocket.close(code=1008)  # policy violation
                return
            try:
                from forge.services.realtime import get_channel, subscribe
                from forge.services.realtime.bus import unsubscribe
            except Exception:
                await websocket.accept()
                await websocket.close(code=1011)  # server error
                return

            cfg = get_channel(_forge_dir(), channel)
            if cfg is None:
                await websocket.accept()
                await websocket.close(code=1008)
                return
            if not cfg.get("public"):
                # Private channels require an auth token + identity
                # check; F-5 surfaces the contract but the WS-bound
                # identity validation lands with the Auth handoff in
                # X-20 (magic-link).
                token = websocket.query_params.get("token")
                if not token:
                    await websocket.accept()
                    await websocket.close(code=1008)
                    return

            await websocket.accept()
            q = await subscribe(channel)
            try:
                # Send recent history on connect so reconnecting clients
                # don't miss messages.
                from forge.services.realtime import history
                for msg in history(_forge_dir(), channel, limit=20):
                    try:
                        await websocket.send_json(msg)
                    except Exception:
                        break
                # Then live-forward.
                while True:
                    msg = await q.get()
                    try:
                        await websocket.send_json(msg)
                    except Exception:
                        break
            except _WSD:
                pass
            finally:
                unsubscribe(channel, q)
