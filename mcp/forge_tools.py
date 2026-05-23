"""Forge MCP tools - Phase F-1.

Registers forge_* tools on the existing FastMCP instance. F-1 ships five DB
tools that mirror InsForge's headline 'semantic layer'; F-2 expands to auth,
storage, functions, gateway, realtime, schedules, secrets, payments.

Registration follows the same conventional pattern used in mcp/server.py
for managed-memory and magic-modules tools: a single register(mcp) function
the parent module imports lazily so an import-time failure here doesn't
sink the rest of the MCP server.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any, Dict, List, Optional


logger = logging.getLogger("loki-mcp.forge")


def _emit_event_safe(name: str, action: str, **kw):
    """Emit a tool-call event using the same async helper the rest of the
    MCP tools use. Falls back to a no-op if the helper is unavailable
    (e.g. early import order)."""
    try:
        from mcp.server import _emit_tool_event_async  # type: ignore
        _emit_tool_event_async(name, action, **kw)
    except Exception:
        pass


def _forge_dir() -> str:
    """Resolve the forge state directory for the current project. Mirrors
    the convention used by autonomy/run.sh: <project>/.loki/forge/."""
    return os.path.abspath(os.path.join(os.getcwd(), ".loki", "forge"))


def register(mcp) -> None:
    """Register all forge_* tools on the FastMCP instance. Called once from
    mcp/server.py near the magic_tools / managed_tools registration block."""

    @mcp.tool()
    async def forge_db_introspect() -> str:
        """Return the live database schema (tables, columns, RLS, indices,
        foreign keys, row count estimates). This is the InsForge-style
        semantic layer for the user's app database - call this before
        writing any code that touches user-app data so you do not invent
        columns that do not exist.
        """
        _emit_event_safe("forge_db_introspect", "start")
        try:
            from forge.services.database import open_engine, introspect
            engine = open_engine(_forge_dir())
            snap = introspect(engine)
            _emit_event_safe("forge_db_introspect", "complete",
                             result_status="success")
            return json.dumps(snap, default=str)
        except Exception as e:
            logger.error("forge_db_introspect failed: %s", e)
            _emit_event_safe("forge_db_introspect", "complete",
                             result_status="error", error=str(e))
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_db_query(sql: str, allow_writes: bool = False) -> str:
        """Run one SQL statement against the user-app database. SELECTs are
        always allowed; writes require allow_writes=True and should usually
        go through forge_db_migrate instead so the change passes through
        the council and is recorded.

        Args:
            sql: A single SQL statement (no semicolons except trailing one).
            allow_writes: Set True to permit INSERT/UPDATE/DELETE/DDL.

        Returns:
            JSON {"rows": [...]} on success, {"error": str} on failure.
        """
        _emit_event_safe("forge_db_query", "start",
                         parameters={"writes": allow_writes})
        try:
            from forge.services.database import open_engine
            engine = open_engine(_forge_dir())
            rows = engine.execute(sql, allow_writes=allow_writes)
            _emit_event_safe("forge_db_query", "complete",
                             result_status="success")
            return json.dumps({"rows": rows}, default=str)
        except Exception as e:
            logger.error("forge_db_query failed: %s", e)
            _emit_event_safe("forge_db_query", "complete",
                             result_status="error", error=str(e))
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_db_migrate(spec: Dict[str, Any]) -> str:
        """Apply a spec-driven database migration. The spec is a structured
        dict (NOT raw SQL) describing what should change in domain terms:

            {
              "summary": "add posts table for user blog feature",
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

        Operations supported in F-1: add_table, drop_table, add_column,
        drop_column, set_rls, create_index.

        Returns JSON {"migration_id", "applied_at", "summary", "sql",
        "already_applied"} on success.
        """
        _emit_event_safe("forge_db_migrate", "start")
        try:
            from forge.services.database import open_engine, migrate_apply
            engine = open_engine(_forge_dir())
            res = migrate_apply(engine, spec)
            _emit_event_safe("forge_db_migrate", "complete",
                             result_status="success")
            return json.dumps(res, default=str)
        except Exception as e:
            logger.error("forge_db_migrate failed: %s", e)
            _emit_event_safe("forge_db_migrate", "complete",
                             result_status="error", error=str(e))
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_db_migrate_dryrun(spec: Dict[str, Any]) -> str:
        """Compile a migration spec to SQL without applying. Useful when the
        agent wants to preview the diff (or surface it for a human
        operator) before committing.
        """
        _emit_event_safe("forge_db_migrate_dryrun", "start")
        try:
            from forge.services.database import open_engine, migrate_dryrun
            engine = open_engine(_forge_dir())
            sql = migrate_dryrun(engine, spec)
            _emit_event_safe("forge_db_migrate_dryrun", "complete",
                             result_status="success")
            return json.dumps({"sql": sql})
        except Exception as e:
            logger.error("forge_db_migrate_dryrun failed: %s", e)
            _emit_event_safe("forge_db_migrate_dryrun", "complete",
                             result_status="error", error=str(e))
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_db_migrate_rollback(migration_id: str) -> str:
        """Roll back a previously-applied migration by id. Best-effort:
        SQLite cannot rollback DDL natively, so we synthesize the inverse
        spec where safe (drop_table for add_table, drop_column for
        add_column). Returns {"ok": bool, "error": str?, "down_sql": str?}.
        """
        _emit_event_safe("forge_db_migrate_rollback", "start",
                         parameters={"migration_id": migration_id})
        try:
            from forge.services.database import open_engine, migrate_rollback
            engine = open_engine(_forge_dir())
            res = migrate_rollback(engine, migration_id)
            _emit_event_safe("forge_db_migrate_rollback", "complete",
                             result_status="success")
            return json.dumps(res, default=str)
        except Exception as e:
            logger.error("forge_db_migrate_rollback failed: %s", e)
            _emit_event_safe("forge_db_migrate_rollback", "complete",
                             result_status="error", error=str(e))
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_state_dump() -> str:
        """Return a full snapshot of forge state for this project (DB schema,
        any provisioned services). The Semantic Layer prompt-injection block
        is generated from this.
        """
        _emit_event_safe("forge_state_dump", "start")
        try:
            from forge.semantic_layer import render_prompt_block
            from forge.services.database import open_engine, introspect
            d = _forge_dir()
            payload: Dict[str, Any] = {
                "schema": "loki.forge.state/v1",
                "forge_dir": d,
                "exists": os.path.isdir(d),
                "prompt_block": render_prompt_block(d),
            }
            if os.path.exists(os.path.join(d, "db.sqlite")):
                try:
                    payload["database"] = introspect(open_engine(d))
                except Exception as e:
                    payload["database_error"] = str(e)
            req = os.path.join(d, "required.json")
            if os.path.isfile(req):
                try:
                    with open(req, "r", encoding="utf-8") as f:
                        payload["required"] = json.load(f)
                except Exception as e:
                    payload["required_error"] = str(e)
            # F-2: auth + storage state.
            try:
                from forge.services.auth import list_providers, list_users
                payload["auth"] = {
                    "providers": list_providers(d),
                    "user_count": len(list_users(d, limit=1000)),
                }
            except Exception as e:
                payload["auth_error"] = str(e)
            try:
                from forge.services.storage import list_buckets
                payload["storage"] = {"buckets": list_buckets(d)}
            except Exception as e:
                payload["storage_error"] = str(e)
            _emit_event_safe("forge_state_dump", "complete",
                             result_status="success")
            return json.dumps(payload, default=str)
        except Exception as e:
            logger.error("forge_state_dump failed: %s", e)
            _emit_event_safe("forge_state_dump", "complete",
                             result_status="error", error=str(e))
            return json.dumps({"error": str(e)})

    # --- Auth tools (F-2) -------------------------------------------------

    @mcp.tool()
    async def forge_auth_provider_add(name: str,
                                      config: Optional[Dict[str, Any]] = None
                                      ) -> str:
        """Register an OAuth or local auth provider for this project.

        Supported names: google, github, apple, microsoft, gitlab,
        discord, slack, email-password, magic-link, webauthn.

        For OAuth providers, config must include `client_id` and may
        include `redirect_uri`, `scopes`, or any *_ref pointer to a
        forge secret. Raw secrets in config are rejected.
        """
        _emit_event_safe("forge_auth_provider_add", "start",
                         parameters={"name": name})
        try:
            from forge.services.auth import add_provider
            res = add_provider(_forge_dir(), name, config or {})
            _emit_event_safe("forge_auth_provider_add", "complete",
                             result_status="success")
            return json.dumps(res, default=str)
        except Exception as e:
            logger.error("forge_auth_provider_add failed: %s", e)
            _emit_event_safe("forge_auth_provider_add", "complete",
                             result_status="error", error=str(e))
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_auth_provider_list() -> str:
        """List configured auth providers (config minus raw secrets)."""
        _emit_event_safe("forge_auth_provider_list", "start")
        try:
            from forge.services.auth import list_providers
            return json.dumps({"providers": list_providers(_forge_dir())},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_auth_provider_remove(name: str) -> str:
        """Unregister an auth provider."""
        _emit_event_safe("forge_auth_provider_remove", "start",
                         parameters={"name": name})
        try:
            from forge.services.auth import remove_provider
            return json.dumps({"removed": remove_provider(_forge_dir(), name)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_auth_user_create(email: Optional[str] = None,
                                     password: Optional[str] = None,
                                     oauth_subject: Optional[Dict[str, str]] = None
                                     ) -> str:
        """Create a user. Either email+password OR oauth_subject required.
        Used by the agent's admin-bootstrap flow; ordinary signups go
        through the auth provider's OAuth callback.
        """
        _emit_event_safe("forge_auth_user_create", "start")
        try:
            from forge.services.auth import create_user
            res = create_user(_forge_dir(), email=email, password=password,
                              oauth_subject=oauth_subject)
            return json.dumps(res, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_auth_user_list(filter: Optional[Dict[str, Any]] = None,
                                   limit: int = 100) -> str:
        """List users (admin)."""
        _emit_event_safe("forge_auth_user_list", "start")
        try:
            from forge.services.auth import list_users
            return json.dumps({"users": list_users(_forge_dir(), filter, limit)},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_auth_session_revoke(user_id: str) -> str:
        """Revoke all active sessions for a user."""
        _emit_event_safe("forge_auth_session_revoke", "start")
        try:
            from forge.services.auth import revoke_session
            return json.dumps({"revoked": revoke_session(_forge_dir(), user_id)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- Storage tools (F-2) ----------------------------------------------

    @mcp.tool()
    async def forge_storage_bucket_create(name: str, public: bool = False,
                                          max_file_size: int = 52428800,
                                          allowed_content_types: Optional[List[str]] = None
                                          ) -> str:
        """Create a storage bucket. max_file_size in bytes (default 50MB).
        allowed_content_types is an allowlist; empty means any."""
        _emit_event_safe("forge_storage_bucket_create", "start",
                         parameters={"name": name, "public": public})
        try:
            from forge.services.storage import create_bucket
            res = create_bucket(_forge_dir(), name, public=public,
                                max_file_size=max_file_size,
                                allowed_content_types=allowed_content_types)
            return json.dumps(res, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_storage_bucket_list() -> str:
        """List all storage buckets and their manifests."""
        _emit_event_safe("forge_storage_bucket_list", "start")
        try:
            from forge.services.storage import list_buckets
            return json.dumps({"buckets": list_buckets(_forge_dir())},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_storage_bucket_delete(name: str) -> str:
        """Delete a storage bucket and all of its objects."""
        _emit_event_safe("forge_storage_bucket_delete", "start",
                         parameters={"name": name})
        try:
            from forge.services.storage import delete_bucket
            return json.dumps({"deleted": delete_bucket(_forge_dir(), name)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_storage_signed_url(bucket: str, path: str,
                                       expires_in: int = 3600,
                                       base_url: str = "",
                                       transform: str = "") -> str:
        """Mint a signed URL for an object. Use the result in HTML/redirects
        so end users can fetch private content without forge auth."""
        _emit_event_safe("forge_storage_signed_url", "start")
        try:
            from forge.services.storage import sign_url
            url = sign_url(_forge_dir(), bucket, path,
                           expires_in=expires_in,
                           base_url=base_url,
                           transform=transform)
            return json.dumps({"url": url})
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_storage_transform_preset(bucket: str,
                                             preset: Dict[str, Any]) -> str:
        """Register an image-transform preset on a bucket (avatar, thumb, etc).
        Once registered the agent can reference it in signed URLs via the
        transform=<name> parameter."""
        _emit_event_safe("forge_storage_transform_preset", "start")
        try:
            from forge.services.storage import register_transform_preset
            res = register_transform_preset(_forge_dir(), bucket, preset)
            return json.dumps(res, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_storage_list_objects(bucket: str, prefix: str = "",
                                         limit: int = 1000) -> str:
        """List objects in a bucket, optionally filtered by prefix."""
        _emit_event_safe("forge_storage_list_objects", "start")
        try:
            from forge.services.storage import list_objects
            return json.dumps({"objects": list_objects(_forge_dir(), bucket,
                                                       prefix=prefix,
                                                       limit=limit)},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- Functions tools (F-2) --------------------------------------------

    @mcp.tool()
    async def forge_function_deploy(name: str, runtime: str, source_b64: str,
                                    entry: str = "index",
                                    env_secrets: Optional[List[str]] = None,
                                    timeout_ms: int = 10000,
                                    memory_mb: int = 128,
                                    triggers: Optional[List[Dict[str, Any]]] = None
                                    ) -> str:
        """Deploy a new version of an edge function. runtime: bun, deno,
        python. source_b64: base64-encoded source file. The manifest
        promotes the new version on success; old versions retained for
        rollback (up to 25).
        """
        _emit_event_safe("forge_function_deploy", "start",
                         parameters={"name": name, "runtime": runtime})
        try:
            from forge.services.functions import deploy
            res = deploy(_forge_dir(), name, runtime, source_b64,
                         entry=entry, env_secrets=env_secrets,
                         timeout_ms=timeout_ms, memory_mb=memory_mb,
                         triggers=triggers)
            return json.dumps(res, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_function_list() -> str:
        """List all deployed edge functions with their manifests."""
        _emit_event_safe("forge_function_list", "start")
        try:
            from forge.services.functions import list_functions
            return json.dumps({"functions": list_functions(_forge_dir())},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_function_invoke(name: str,
                                    payload: Optional[Dict[str, Any]] = None,
                                    version: Optional[int] = None,
                                    env_overrides: Optional[Dict[str, str]] = None
                                    ) -> str:
        """Invoke a forge function synchronously. Returns ok/exit_code/
        stdout/stderr/duration_ms/run_id."""
        _emit_event_safe("forge_function_invoke", "start",
                         parameters={"name": name})
        try:
            from forge.services.functions import invoke
            res = invoke(_forge_dir(), name, payload=payload,
                         version=version, env_overrides=env_overrides)
            return json.dumps(res, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_function_logs(name: str, limit: int = 100) -> str:
        """Return recent run-log entries for a function (newest first)."""
        _emit_event_safe("forge_function_logs", "start")
        try:
            from forge.services.functions import list_runs
            return json.dumps({"runs": list_runs(_forge_dir(), name, limit)},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_function_delete(name: str) -> str:
        """Delete a function and all of its versions + logs."""
        _emit_event_safe("forge_function_delete", "start",
                         parameters={"name": name})
        try:
            from forge.services.functions import delete_function
            return json.dumps({"deleted": delete_function(_forge_dir(), name)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_function_rollback(name: str, to_version: int) -> str:
        """Switch the active_version pointer back to a prior deploy."""
        _emit_event_safe("forge_function_rollback", "start")
        try:
            from forge.services.functions import rollback
            return json.dumps(rollback(_forge_dir(), name, to_version),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- Gateway tools (F-2) ----------------------------------------------

    @mcp.tool()
    async def forge_gateway_route_add(route: Dict[str, Any]) -> str:
        """Register a model-gateway route. Shape:
            {"model": "...", "provider": "anthropic|openai|google|...",
             "base_url": "https://...", "api_key_ref": "SECRET_NAME",
             "tier": 1, "cost_per_1m_input_tokens": 3.0,
             "cost_per_1m_output_tokens": 15.0,
             "p50_latency_ms_target": 1500}
        """
        _emit_event_safe("forge_gateway_route_add", "start")
        try:
            from forge.services.gateway import add_route
            return json.dumps(add_route(_forge_dir(), route), default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_gateway_route_list(model: Optional[str] = None) -> str:
        """List configured gateway routes."""
        _emit_event_safe("forge_gateway_route_list", "start")
        try:
            from forge.services.gateway import list_routes
            return json.dumps({"routes": list_routes(_forge_dir(), model=model)},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_gateway_usage(window_seconds: int = 86400,
                                  model: Optional[str] = None) -> str:
        """Return aggregated usage stats over the last window."""
        _emit_event_safe("forge_gateway_usage", "start")
        try:
            from forge.services.gateway import usage_summary
            data = usage_summary(_forge_dir(), model=model,
                                  window_seconds=window_seconds)
            return json.dumps({
                "schema": "loki.forge.gateway.usage/v1",
                "buckets": [
                    {"model": k[0], "provider": k[1], **v}
                    for k, v in data.items()
                ],
            }, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_gateway_route_pick(model: str) -> str:
        """Pick the best route for a given model. Returns the chosen route
        plus the routing rationale. Used internally by the OpenAI-compat
        front; exposed here so the agent can verify routing decisions."""
        _emit_event_safe("forge_gateway_route_pick", "start")
        try:
            from forge.services.gateway import pick_route, usage_summary
            r = pick_route(_forge_dir(), model)
            if r is None:
                return json.dumps({"error": "no route for model", "model": model})
            return json.dumps({
                "route": r,
                "usage": usage_summary(_forge_dir(), model=model),
            }, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- Realtime tools (F-3) ---------------------------------------------

    @mcp.tool()
    async def forge_realtime_channel_create(name: str, public: bool = False,
                                            rls: str = "own-row",
                                            custom_predicate: Optional[str] = None
                                            ) -> str:
        """Create a realtime channel. rls: public | own-row | own-or-public
        | custom (with custom_predicate)."""
        _emit_event_safe("forge_realtime_channel_create", "start")
        try:
            from forge.services.realtime import create_channel
            res = create_channel(_forge_dir(), name, public=public, rls=rls,
                                 custom_predicate=custom_predicate)
            return json.dumps(res, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_realtime_channel_list() -> str:
        _emit_event_safe("forge_realtime_channel_list", "start")
        try:
            from forge.services.realtime import list_channels
            return json.dumps({"channels": list_channels(_forge_dir())},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_realtime_publish(channel: str,
                                     payload: Dict[str, Any],
                                     sender_user_id: Optional[str] = None
                                     ) -> str:
        """Publish a message to a channel. RLS gating is the caller's
        responsibility (or the dashboard WS endpoint, when wired)."""
        _emit_event_safe("forge_realtime_publish", "start")
        try:
            from forge.services.realtime import publish
            res = publish(_forge_dir(), channel, payload,
                          sender_user_id=sender_user_id)
            return json.dumps(res, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_realtime_history(channel: str, limit: int = 100,
                                     since_ms: Optional[int] = None) -> str:
        _emit_event_safe("forge_realtime_history", "start")
        try:
            from forge.services.realtime import history
            return json.dumps({"messages": history(_forge_dir(), channel,
                                                    limit=limit,
                                                    since_ms=since_ms)},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- Schedules tools (F-3) --------------------------------------------

    @mcp.tool()
    async def forge_schedule_create(name: str, cron: str,
                                    target: Dict[str, Any],
                                    payload: Optional[Dict[str, Any]] = None
                                    ) -> str:
        """Create a scheduled job. target is one of:
            {"type": "function", "name": "<fn>"}
            {"type": "url", "url": "https://..."}
            {"type": "event", "topic": "<bus.topic>"}
        cron is a standard 5-field expression or @hourly/@daily/etc.
        """
        _emit_event_safe("forge_schedule_create", "start")
        try:
            from forge.services.schedules import create
            return json.dumps(create(_forge_dir(), name, cron, target,
                                     payload=payload), default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_schedule_list() -> str:
        _emit_event_safe("forge_schedule_list", "start")
        try:
            from forge.services.schedules import list_schedules
            return json.dumps({"schedules": list_schedules(_forge_dir())},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_schedule_delete(name: str) -> str:
        _emit_event_safe("forge_schedule_delete", "start")
        try:
            from forge.services.schedules import delete
            return json.dumps({"deleted": delete(_forge_dir(), name)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_schedule_logs(name: str, limit: int = 100) -> str:
        _emit_event_safe("forge_schedule_logs", "start")
        try:
            from forge.services.schedules import list_runs
            return json.dumps({"runs": list_runs(_forge_dir(), name, limit)},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- Secrets tools (F-3) ----------------------------------------------

    @mcp.tool()
    async def forge_secret_set(name: str, value: str) -> str:
        """Store a secret value. Returns name + metadata; value never echoed."""
        _emit_event_safe("forge_secret_set", "start",
                         parameters={"name": name})
        try:
            from forge.services.secrets import set_secret
            return json.dumps(set_secret(_forge_dir(), name, value),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_secret_list() -> str:
        """List secret names + metadata. Values are NOT returned."""
        _emit_event_safe("forge_secret_list", "start")
        try:
            from forge.services.secrets import list_secrets
            return json.dumps({"secrets": list_secrets(_forge_dir())},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_secret_delete(name: str) -> str:
        _emit_event_safe("forge_secret_delete", "start",
                         parameters={"name": name})
        try:
            from forge.services.secrets import delete_secret
            return json.dumps({"deleted": delete_secret(_forge_dir(), name)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_secret_rotate(name: str, cron: str = "@monthly",
                                  action: str = "alert",
                                  target: Optional[Dict[str, Any]] = None
                                  ) -> str:
        """Set a rotation policy for a secret. action: alert | function |
        manual. cron is the rotation cadence (passed to the scheduler)."""
        _emit_event_safe("forge_secret_rotate", "start")
        try:
            from forge.services.secrets import set_rotation_policy
            return json.dumps(set_rotation_policy(_forge_dir(), name,
                                                   cron=cron, action=action,
                                                   target=target),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- Payments tools (F-3) ---------------------------------------------

    @mcp.tool()
    async def forge_payments_provider_setup(provider: str,
                                            api_key_ref: str,
                                            api_version: Optional[str] = None,
                                            webhook_secret_ref: Optional[str] = None
                                            ) -> str:
        """Configure a payments provider (stripe / lemon-squeezy / paddle)."""
        _emit_event_safe("forge_payments_provider_setup", "start")
        try:
            from forge.services.payments import setup_provider
            return json.dumps(setup_provider(_forge_dir(), provider,
                                              api_key_ref=api_key_ref,
                                              api_version=api_version,
                                              webhook_secret_ref=webhook_secret_ref),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_payments_product_create(provider: str, name: str,
                                            prices: List[Dict[str, Any]],
                                            metadata: Optional[Dict[str, Any]] = None
                                            ) -> str:
        _emit_event_safe("forge_payments_product_create", "start")
        try:
            from forge.services.payments import create_product
            return json.dumps(create_product(_forge_dir(), provider, name=name,
                                              prices=prices, metadata=metadata),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_payments_product_list(provider: str) -> str:
        _emit_event_safe("forge_payments_product_list", "start")
        try:
            from forge.services.payments import list_products
            return json.dumps({"products": list_products(_forge_dir(), provider)},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_payments_webhook_register(provider: str,
                                              target_function: str,
                                              events: List[str]) -> str:
        _emit_event_safe("forge_payments_webhook_register", "start")
        try:
            from forge.services.payments import register_webhook
            return json.dumps(register_webhook(_forge_dir(), provider,
                                                target_function=target_function,
                                                events=events),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- Deploy tools (F-3) -----------------------------------------------

    @mcp.tool()
    async def forge_deploy_provider_setup(provider: str,
                                          credentials_ref: Optional[str] = None,
                                          project_id: Optional[str] = None,
                                          region: Optional[str] = None) -> str:
        """Configure a deploy provider (railway / fly / vercel /
        cloudflare / local). credentials_ref points to a forge secret."""
        _emit_event_safe("forge_deploy_provider_setup", "start")
        try:
            from forge.services.deploy import setup_provider
            return json.dumps(setup_provider(_forge_dir(), provider,
                                              credentials_ref=credentials_ref,
                                              project_id=project_id,
                                              region=region),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_deploy_plan(provider: str, env: str = "prod") -> str:
        """Render a deploy plan for inspection without applying."""
        _emit_event_safe("forge_deploy_plan", "start")
        try:
            from forge.services.deploy import plan
            return json.dumps(plan(_forge_dir(), provider, env=env),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_deploy_promote(provider: str,
                                   from_env: str = "dev",
                                   to_env: str = "prod") -> str:
        """Promote forge resources from one env to another. Records the
        promotion intent + the rendered plan; the actual provider-API
        call runs in user-app CI."""
        _emit_event_safe("forge_deploy_promote", "start")
        try:
            from forge.services.deploy import promote
            return json.dumps(promote(_forge_dir(), provider,
                                       from_env=from_env, to_env=to_env),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_deploy_status(provider: str, env: str = "prod") -> str:
        _emit_event_safe("forge_deploy_status", "start")
        try:
            from forge.services.deploy import status
            return json.dumps(status(_forge_dir(), provider, env=env),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_deploy_rollback(provider: str, env: str = "prod") -> str:
        _emit_event_safe("forge_deploy_rollback", "start")
        try:
            from forge.services.deploy import rollback
            return json.dumps(rollback(_forge_dir(), provider, env=env),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- External auth adapters (F-4) -------------------------------------

    @mcp.tool()
    async def forge_auth_external_configure(name: str, issuer: str,
                                            audience: str,
                                            jwks_url: Optional[str] = None,
                                            extra: Optional[Dict[str, Any]] = None
                                            ) -> str:
        """Configure an external auth provider (auth0 / clerk / kinde /
        stytch / workos). issuer + audience must match the tokens you
        want to accept. jwks_url defaults to <issuer>/.well-known/jwks.json."""
        _emit_event_safe("forge_auth_external_configure", "start")
        try:
            from forge.services.auth.external import configure
            return json.dumps(configure(_forge_dir(), name, issuer=issuer,
                                         audience=audience,
                                         jwks_url=jwks_url, extra=extra),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_auth_external_list() -> str:
        _emit_event_safe("forge_auth_external_list", "start")
        try:
            from forge.services.auth.external import list_external
            return json.dumps({"adapters": list_external(_forge_dir())},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_auth_external_remove(name: str) -> str:
        _emit_event_safe("forge_auth_external_remove", "start")
        try:
            from forge.services.auth.external import remove_external
            return json.dumps({"removed": remove_external(_forge_dir(), name)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- Stripe Connect (F-4) ---------------------------------------------

    @mcp.tool()
    async def forge_payments_connect_record(account_id: str,
                                            owner_user_id: str,
                                            account_type: str = "express",
                                            country: Optional[str] = None,
                                            metadata: Optional[Dict[str, Any]] = None
                                            ) -> str:
        _emit_event_safe("forge_payments_connect_record", "start")
        try:
            from forge.services.payments.stripe_connect import record_account
            return json.dumps(record_account(_forge_dir(), account_id,
                                              owner_user_id,
                                              account_type=account_type,
                                              country=country,
                                              metadata=metadata),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_payments_connect_list(owner_user_id: Optional[str] = None
                                          ) -> str:
        _emit_event_safe("forge_payments_connect_list", "start")
        try:
            from forge.services.payments.stripe_connect import list_accounts
            return json.dumps({"accounts": list_accounts(_forge_dir(),
                                                          owner_user_id=owner_user_id)},
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_payments_connect_status(account_id: str) -> str:
        _emit_event_safe("forge_payments_connect_status", "start")
        try:
            from forge.services.payments.stripe_connect import get_effective_status
            return json.dumps({"account_id": account_id,
                               "status": get_effective_status(_forge_dir(),
                                                              account_id)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    # --- Migration tooling (F-4) ------------------------------------------

    @mcp.tool()
    async def forge_migrate_from_supabase(dump_path: str) -> str:
        """Import a Supabase pg_dump SQL file. Parses CREATE TABLE
        statements and applies equivalent forge migrations."""
        _emit_event_safe("forge_migrate_from_supabase", "start",
                         parameters={"dump_path": dump_path})
        try:
            from forge.migrations import import_from_supabase
            return json.dumps(import_from_supabase(_forge_dir(), dump_path),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    @mcp.tool()
    async def forge_migrate_from_insforge(export_path: str) -> str:
        """Import an InsForge metadata --json export."""
        _emit_event_safe("forge_migrate_from_insforge", "start")
        try:
            from forge.migrations import import_from_insforge
            return json.dumps(import_from_insforge(_forge_dir(), export_path),
                              default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})
