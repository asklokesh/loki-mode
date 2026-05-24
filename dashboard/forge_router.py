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
        sandbox diagnose surfaces. Lightweight; safe to poll. N-06:
        delegated to forge.health.compute_health so `loki forge doctor`
        and this route never drift."""
        from forge.health import compute_health
        return compute_health(_forge_dir())

    @app.get("/api/forge/metrics")
    async def forge_metrics() -> Any:
        """X-79: Prometheus exposition for forge counters."""
        from fastapi.responses import PlainTextResponse
        try:
            from forge.metrics import render
            return PlainTextResponse(
                render(_forge_dir()),
                media_type="text/plain; version=0.0.4",
            )
        except Exception as e:
            return PlainTextResponse(
                f"# metrics error: {e}\n",
                media_type="text/plain",
            )

    @app.get("/api/forge/tail")
    async def forge_tail(source: str = "audit", lines: int = 100) -> Any:
        """X-71: tail the audit chain or a function's logs."""
        from fastapi.responses import JSONResponse as _JR
        d = _forge_dir()
        if source == "audit":
            try:
                from dashboard import audit as _audit
                if hasattr(_audit, "_get_current_log_file"):
                    p = str(_audit._get_current_log_file())
                    if os.path.isfile(p):
                        with open(p, "r", encoding="utf-8") as f:
                            tail = f.readlines()[-max(1, min(lines, 10000)):]
                        return {"source": "audit", "lines": tail}
                return {"source": "audit", "lines": [],
                        "warning": "no audit log"}
            except Exception as e:
                return _JR(status_code=500, content={"error": str(e)})
        if source.startswith("function:"):
            name = source.split(":", 1)[1]
            try:
                from forge.services.functions import list_runs
                runs = list_runs(d, name, limit=lines)
                return {"source": source, "runs": runs}
            except Exception as e:
                return _JR(status_code=500, content={"error": str(e)})
        return _JR(status_code=400,
                   content={"error": "source must be 'audit' or 'function:<name>'"})

    @app.get("/api/forge/analytics")
    async def forge_analytics(window_seconds: int = 7 * 24 * 3600
                              ) -> Dict[str, Any]:
        """X-56: rollup across forge services. Tables row-count estimate,
        bucket object/size counts, function call counts, gateway usage,
        schedule tick history."""
        d = _forge_dir()
        out: Dict[str, Any] = {
            "schema": "loki.forge.analytics/v1",
            "window_seconds": window_seconds,
        }
        try:
            from forge.services.database import open_engine, introspect
            if os.path.exists(os.path.join(d, "db.sqlite")):
                snap = introspect(open_engine(d))
                out["tables"] = [
                    {"name": t["name"],
                     "row_count_estimate": t.get("row_count_estimate", 0)}
                    for t in snap.get("tables", [])
                ]
            else:
                out["tables"] = []
        except Exception:
            out["tables"] = []
        try:
            from forge.services.storage import list_buckets, list_objects
            buckets = []
            for b in list_buckets(d):
                objs = list_objects(d, b["name"], limit=10000)
                buckets.append({
                    "name": b["name"],
                    "objects": len(objs),
                    "bytes": sum(o.get("size", 0) for o in objs),
                })
            out["buckets"] = buckets
        except Exception:
            out["buckets"] = []
        try:
            from forge.services.functions import list_functions, list_runs
            fns = []
            for fn in list_functions(d):
                runs = list_runs(d, fn["name"], limit=10000)
                fns.append({
                    "name": fn["name"],
                    "calls": len(runs),
                    "ok": sum(1 for r in runs if r.get("ok")),
                })
            out["functions"] = fns
        except Exception:
            out["functions"] = []
        try:
            from forge.services.gateway import usage_summary
            out["gateway_usage"] = [
                {"model": k[0], "provider": k[1], **v}
                for k, v in usage_summary(d,
                                          window_seconds=window_seconds).items()
            ]
        except Exception:
            out["gateway_usage"] = []
        try:
            from forge.services.schedules import list_schedules, list_runs as sr_list
            sched = []
            for s in list_schedules(d):
                sched.append({
                    "name": s["name"],
                    "next_fire_ts": s.get("next_fire_ts"),
                    "ticks": len(sr_list(d, s["name"])),
                })
            out["schedules"] = sched
        except Exception:
            out["schedules"] = []
        return out

    @app.get("/api/forge/gateway/rate-limit")
    async def forge_gateway_rate_limit() -> Dict[str, Any]:
        """X-38: rate-limit bucket telemetry."""
        try:
            from forge.services.gateway.rate_limit import snapshot
            return snapshot()
        except Exception as e:
            return {"buckets": [], "error": str(e)}

    @app.get("/api/forge/database/diff/{migration_id}")
    async def forge_db_diff(migration_id: str) -> Dict[str, Any]:
        """X-11: rendered diff for one migration review record."""
        d = _forge_dir()
        try:
            from fastapi import HTTPException as _HE
            from forge.services.database import open_engine
            from forge.services.database.diff import render_diff
            engine = open_engine(d)
            rows = engine.execute(
                "SELECT id, spec_json, summary, applied_at, sql "
                "FROM _forge_migrations WHERE id = ?",
                (migration_id,),
            )
            if not rows:
                raise _HE(status_code=404, detail="migration not found")
            rec = rows[0]
            spec = json.loads(rec["spec_json"])
            return {
                "schema": "loki.forge.migration.diff/v1",
                "migration_id": migration_id,
                "summary": rec["summary"],
                "applied_at": rec["applied_at"],
                "diff": render_diff(spec),
                "sql": rec["sql"],
            }
        except Exception as e:
            from fastapi import HTTPException as _HE
            if isinstance(e, _HE):
                raise
            raise _HE(status_code=500, detail=str(e))

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

        # --- X-24: Payments webhook receivers ----------------------------

        @app.post("/forge/payments/{provider}/webhook")
        async def forge_payments_webhook(provider: str, req: Request) -> Any:
            if provider not in ("stripe", "lemon-squeezy", "paddle"):
                raise HTTPException(status_code=404,
                                    detail=f"unsupported provider: {provider}")
            d = _forge_dir()
            body = await req.body()
            headers = {k.lower(): v for k, v in req.headers.items()}
            cfg_path = os.path.join(d, "payments", f"{provider}.json")
            if not os.path.isfile(cfg_path):
                raise HTTPException(status_code=503,
                                    detail=f"{provider} not configured")
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            secret_ref = cfg.get("webhook_secret_ref")
            if not secret_ref:
                raise HTTPException(status_code=503,
                                    detail="webhook_secret_ref unset")
            try:
                from forge.services.secrets import get_secret
                secret = get_secret(d, secret_ref)
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))
            if secret is None:
                raise HTTPException(status_code=503,
                                    detail=f"webhook secret {secret_ref} missing from vault")
            if provider == "stripe":
                sig = headers.get("stripe-signature", "")
                from forge.services.payments.stripe import verify_webhook_signature
                verified = verify_webhook_signature(secret, body, sig)
            elif provider == "lemon-squeezy":
                sig = headers.get("x-signature", "")
                from forge.services.payments.lemon_squeezy import verify_webhook_signature
                verified = verify_webhook_signature(secret, body, sig)
            else:  # paddle
                sig = headers.get("paddle-signature", "")
                from forge.services.payments.paddle import verify_webhook_signature
                verified = verify_webhook_signature(secret, body, sig)
            if not verified:
                raise HTTPException(status_code=401, detail="invalid signature")
            try:
                event = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise HTTPException(status_code=400, detail="invalid JSON body")
            try:
                from forge.services.payments import record_webhook_event
                record_webhook_event(d, provider, event)
            except Exception as e:
                logger.warning("webhook record failed: %s", e)
            try:
                from forge.services.functions import get_function, invoke
                fn_name = f"{provider.replace('-', '_')}_webhook"
                if get_function(d, fn_name):
                    invoke(d, fn_name, payload=event)
            except Exception:
                pass
            return {"ok": True,
                    "received": event.get("type") or event.get("event_name")}

        # --- X-25/X-30: OAuth callback handler ---------------------------

        @app.get("/forge/auth/callback/{provider}")
        async def forge_auth_callback(provider: str, req: Request) -> Any:
            from forge.services.auth.providers import SUPPORTED_PROVIDERS
            if provider not in SUPPORTED_PROVIDERS:
                raise HTTPException(status_code=404,
                                    detail=f"unsupported provider: {provider}")
            params = dict(req.query_params)
            code = params.get("code")
            state = params.get("state")
            if not code or not state:
                raise HTTPException(status_code=400,
                                    detail="missing code/state")
            d = _forge_dir()
            log_dir = os.path.join(d, "auth", "callbacks")
            os.makedirs(log_dir, exist_ok=True)
            import time as _time
            rec = {
                "provider": provider, "state": state,
                "received_at": int(_time.time()),
                "code": code,
                "params": {k: v for k, v in params.items()
                           if k not in ("code", "state")},
            }
            path = os.path.join(log_dir, f"{provider}-{state}.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(rec, f, indent=2, sort_keys=True)
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
            try:
                from forge.services.functions import get_function, invoke
                if get_function(d, "oauth_exchange"):
                    res = invoke(d, "oauth_exchange", payload={
                        "provider": provider, "state": state, "code": code,
                        "params": rec["params"],
                    })
                    if res.get("ok"):
                        try:
                            return json.loads(res.get("stdout", "{}"))
                        except json.JSONDecodeError:
                            return {"raw": res.get("stdout", "")}
                    return JSONResponse(status_code=502, content={
                        "ok": False, "exit_code": res.get("exit_code"),
                        "stderr": res.get("stderr"),
                    })
            except Exception as e:
                return JSONResponse(status_code=500, content={"error": str(e)})
            return {
                "ok": True, "provider": provider, "state": state,
                "hint": "deploy a forge function named 'oauth_exchange' "
                        "to complete the token-exchange flow",
            }

        # --- N-10: magic-link redeem ------------------------------------

        @app.get("/forge/auth/magic/redeem")
        async def forge_magic_redeem(token: str = "",
                                     redirect: str = "") -> Any:
            """N-10: HTTP handler over magic_link.redeem(). Returns a
            session JWT on success; mirrors the OAuth callback shape so
            clients can treat magic-link and OAuth identically.
            Maps redeem() error codes onto standard HTTP statuses:
                invalid_token_shape -> 422
                consumed_or_unknown -> 404
                expired             -> 410

            N-24: when `redirect=` is supplied AND it parses as a
            safe http(s) URL, on success we 302 to that URL with the
            session JWT appended as `?session=...`. Lets operators
            wire the magic link straight into their app without a
            JSON intermediate step. Unsafe schemes (javascript:,
            data:, file://, ...) are rejected with 400.
            """
            if not token:
                raise HTTPException(status_code=422,
                                    detail="token query param required")
            from forge.services.auth import magic_link_redeem
            result = magic_link_redeem(_forge_dir(), token)
            if result.get("ok"):
                if redirect:
                    from urllib.parse import urlparse, urlencode
                    parsed = urlparse(redirect)
                    if parsed.scheme not in ("http", "https") or not parsed.netloc:
                        raise HTTPException(
                            status_code=400,
                            detail="redirect must be an absolute http(s) URL"
                        )
                    # N-34: when LOKI_FORGE_MAGIC_REDIRECT_ALLOW is set,
                    # check the redirect hostname against the allow-list
                    # (comma-separated). Empty allow-list = unrestricted
                    # (back-compat). Prevents open-redirect abuse.
                    allow_env = os.environ.get(
                        "LOKI_FORGE_MAGIC_REDIRECT_ALLOW", ""
                    ).strip()
                    if allow_env:
                        allowed = {h.strip().lower() for h in allow_env.split(",")
                                   if h.strip()}
                        host = (parsed.hostname or "").lower()
                        # Exact match or *.suffix match.
                        ok_host = host in allowed or any(
                            a.startswith("*.") and host.endswith(a[1:])
                            for a in allowed
                        )
                        if not ok_host:
                            raise HTTPException(
                                status_code=400,
                                detail=f"redirect host {host!r} not in "
                                       "LOKI_FORGE_MAGIC_REDIRECT_ALLOW"
                            )
                    sep = "&" if parsed.query else "?"
                    jwt = result.get("token") or result.get("jwt") or ""
                    target = f"{redirect}{sep}{urlencode({'session': jwt})}"
                    from fastapi.responses import RedirectResponse
                    return RedirectResponse(url=target, status_code=302)
                return result
            err = result.get("error", "unknown")
            status = {
                "invalid_token_shape": 422,
                "consumed_or_unknown": 404,
                "expired": 410,
            }.get(err, 400)
            return JSONResponse(status_code=status, content={
                "ok": False, "error": err,
            })

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
