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
