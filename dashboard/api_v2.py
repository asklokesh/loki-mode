"""
V2 REST API Router for Loki Mode Dashboard.

Provides /api/v2/ endpoints for tenants, runs, API keys, policies, and audit.
Mount this router in server.py with:
    from .api_v2 import router as api_v2_router
    app.include_router(api_v2_router)
"""

from __future__ import annotations

import csv
import io
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import auth
from . import audit
from . import api_keys
from . import tenants as tenants_mod
from . import runs as runs_mod
from .database import get_db
from .models import Project, Run


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/v2", tags=["v2"])


# ---------------------------------------------------------------------------
# Pydantic schemas for policies
# ---------------------------------------------------------------------------

class PolicyUpdate(BaseModel):
    """Schema for updating policies."""
    policies: dict = Field(..., description="Policy configuration dict")


class PolicyEvaluateRequest(BaseModel):
    """Schema for evaluating a policy check."""
    action: str
    resource_type: str
    resource_id: Optional[str] = None
    context: Optional[dict] = None


class ApiKeyUpdateRequest(BaseModel):
    """Schema for updating API key metadata."""
    description: Optional[str] = None
    allowed_ips: Optional[list[str]] = None
    rate_limit: Optional[int] = None


# ---------------------------------------------------------------------------
# Helper: resolve policies file path
# ---------------------------------------------------------------------------

_LOKI_DIR = Path(os.environ.get("LOKI_DATA_DIR", os.path.expanduser("~/.loki")))


def _get_policies_path() -> Path:
    """Return the path to the policies file (.json preferred, then .yaml)."""
    json_path = _LOKI_DIR / "policies.json"
    yaml_path = _LOKI_DIR / "policies.yaml"
    if json_path.exists():
        return json_path
    if yaml_path.exists():
        return yaml_path
    return json_path  # default to .json if neither exists


def _load_policies() -> dict:
    """Load policies from disk."""
    path = _get_policies_path()
    if not path.exists():
        return {}
    try:
        with open(path, "r") as f:
            if path.suffix == ".yaml" or path.suffix == ".yml":
                try:
                    import yaml
                    return yaml.safe_load(f) or {}
                except ImportError:
                    return {}
            else:
                return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def _save_policies(policies: dict) -> None:
    """Save policies to disk as JSON."""
    path = _LOKI_DIR / "policies.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(policies, f, indent=2)


# ---------------------------------------------------------------------------
# Helper: extract audit context from request
# ---------------------------------------------------------------------------

def _audit_context(request: Request, token_info: Optional[dict] = None) -> dict:
    """Extract IP address and user agent from a request for audit logging."""
    return {
        "ip_address": request.client.host if request.client else None,
        "user_agent": request.headers.get("user-agent"),
        "user_id": token_info.get("name") if token_info else None,
        "token_id": token_info.get("id") if token_info else None,
    }


# ---------------------------------------------------------------------------
# Tenant isolation (P3-7)
# ---------------------------------------------------------------------------
#
# The audit (backlog P3-7) flagged that API-level cross-tenant access was NOT
# enforced: any authenticated caller with the `read` scope could list every
# tenant and read any tenant's projects, regardless of which tenant they
# belong to. A caller authenticated for tenant A could read tenant B's data.
#
# The caller's tenant MUST come from the trusted, server-validated token --
# never from a client-supplied request header, which the caller could simply
# set to a victim tenant's id and bypass the boundary entirely. The auth layer
# (dashboard/auth.py) has no dedicated tenant field, but a validated token's
# `scopes` list IS trusted: it is returned by validate_token() (from the
# server-side token store) and by validate_oidc_token() (from
# cryptographically/issuer-validated claims). We therefore bind a token to a
# tenant via a `tenant:<id>` scope, parsed out of token_info["scopes"]. To
# scope a token to tenant 5, mint it with that scope in its scope list, e.g.
# via the API-key endpoint or auth.generate_token:
#
#     POST /api/v2/api-keys  {"name": "...", "scopes": ["read", "tenant:5"]}
#     auth.generate_token(name="...", scopes=["read", "tenant:5"])
#
# A token's scopes decide crossing rights:
#
#   * A global admin (scope `*`, i.e. the admin role) may cross any tenant.
#   * A non-admin token is pinned to the tenant in its `tenant:<id>` scope;
#     a request that targets a different tenant is denied with 403.
#   * When auth is disabled (no enterprise token auth and no OIDC) there is no
#     caller identity to isolate -- this is single-user local mode -- so access
#     is not restricted.
#
# This boundary is deliberately fail-closed for authenticated non-admin
# callers: a token with no `tenant:<id>` scope cannot reach ANY tenant-scoped
# resource (every cross-tenant check fails), so an un-scoped token is not
# silently granted access to a tenant it was never bound to.

TENANT_SCOPE_PREFIX = "tenant:"


class TenantContext:
    """Resolved tenant boundary for the current caller.

    Attributes:
        tenant_id: The tenant the caller's token is bound to (parsed from its
            trusted `tenant:<id>` scope), or None if the token carries no
            tenant scope.
        is_global_admin: True if the caller holds admin scope and may
            legitimately cross tenant boundaries.
        auth_enabled: True if any auth method (token or OIDC) is active.
    """

    __slots__ = ("tenant_id", "is_global_admin", "auth_enabled")

    def __init__(
        self,
        tenant_id: Optional[int],
        is_global_admin: bool,
        auth_enabled: bool,
    ) -> None:
        self.tenant_id = tenant_id
        self.is_global_admin = is_global_admin
        self.auth_enabled = auth_enabled

    def enforce(self, target_tenant_id: int) -> None:
        """Raise 403 if the caller may not access the given tenant's resources.

        A global admin may access any tenant. When auth is disabled there is
        no caller to isolate, so access is allowed. Otherwise the caller's
        token-bound tenant must exactly match the target tenant.
        """
        if self.is_global_admin or not self.auth_enabled:
            return
        if self.tenant_id is None or self.tenant_id != target_tenant_id:
            raise HTTPException(
                status_code=403,
                detail="Cross-tenant access denied",
            )


def _tenant_id_from_token(token_info: Optional[dict]) -> Optional[int]:
    """Extract the caller's tenant id from a validated token's scopes.

    Looks for a single `tenant:<id>` scope in the (trusted) token scope list.
    Returns None if the token carries no such scope. If the token carries
    conflicting tenant scopes (more than one distinct tenant), access is
    denied (403) rather than silently picking one.
    """
    if not token_info:
        return None
    found: set[int] = set()
    for scope in token_info.get("scopes", []):
        if isinstance(scope, str) and scope.startswith(TENANT_SCOPE_PREFIX):
            raw = scope[len(TENANT_SCOPE_PREFIX):].strip()
            try:
                found.add(int(raw))
            except (TypeError, ValueError):
                # Malformed tenant scope -- ignore it (does not grant access).
                continue
    if not found:
        return None
    if len(found) > 1:
        raise HTTPException(
            status_code=403,
            detail="Token carries conflicting tenant scopes",
        )
    return next(iter(found))


def resolve_tenant_context(
    token_info: Optional[dict] = Depends(auth.get_current_token),
) -> TenantContext:
    """FastAPI dependency that resolves the caller's tenant boundary.

    The caller's tenant is derived solely from the trusted, server-validated
    token (its `tenant:<id>` scope); whether the caller is a global admin (and
    may cross tenants) is read from the same token's scopes. No client-supplied
    header is consulted, so a caller cannot impersonate another tenant.
    """
    auth_enabled = auth.is_enterprise_mode() or auth.is_oidc_mode()
    is_global_admin = bool(token_info) and auth.has_scope(token_info, "admin")
    tenant_id = _tenant_id_from_token(token_info)
    return TenantContext(
        tenant_id=tenant_id,
        is_global_admin=is_global_admin,
        auth_enabled=auth_enabled,
    )


def _require_global_admin(tenant_ctx: TenantContext) -> None:
    """Gate a tenant-lifecycle operation behind global-admin authority.

    Creating, updating, or deleting a tenant is a global-admin-only operation:
    it manages the isolation boundaries themselves, so a tenant-scoped caller
    (even one holding the `control` scope, which does NOT imply `admin`) must
    not perform it. A global admin is allowed. When auth is disabled there is
    no caller identity to isolate -- single-user local mode -- so the operation
    is permitted, mirroring TenantContext.enforce so legitimate single-tenant
    and local flows are not broken.
    """
    if tenant_ctx.is_global_admin or not tenant_ctx.auth_enabled:
        return
    raise HTTPException(
        status_code=403,
        detail="Tenant lifecycle operations require global admin",
    )


async def _enforce_project_tenant(
    db: AsyncSession, tenant_ctx: TenantContext, project_id: int
) -> None:
    """Enforce the tenant boundary for a project referenced by id.

    Loads the project's tenant_id and applies tenant_ctx.enforce. A missing
    project yields 404 (so existence is not leaked across tenants any more
    than the boundary already allows). For a global admin / auth-disabled
    caller this is a cheap pass-through that does not need the lookup.
    """
    if tenant_ctx.is_global_admin or not tenant_ctx.auth_enabled:
        return
    result = await db.execute(
        select(Project.tenant_id).where(Project.id == project_id)
    )
    owner_tenant_id = result.scalar_one_or_none()
    if owner_tenant_id is None:
        raise HTTPException(status_code=404, detail="Project not found")
    tenant_ctx.enforce(owner_tenant_id)


async def _enforce_run_tenant(
    db: AsyncSession, tenant_ctx: TenantContext, run_id: int
) -> None:
    """Enforce the tenant boundary for a run referenced by id.

    A run belongs to a project, which belongs to a tenant. We resolve the
    run -> project -> tenant chain and apply the boundary. A missing run
    yields 404.
    """
    if tenant_ctx.is_global_admin or not tenant_ctx.auth_enabled:
        return
    result = await db.execute(
        select(Project.tenant_id)
        .join(Run, Run.project_id == Project.id)
        .where(Run.id == run_id)
    )
    owner_tenant_id = result.scalar_one_or_none()
    if owner_tenant_id is None:
        raise HTTPException(status_code=404, detail="Run not found")
    tenant_ctx.enforce(owner_tenant_id)


# ===========================================================================
# TENANT ENDPOINTS
# ===========================================================================


@router.post("/tenants", status_code=201)
async def create_tenant(
    body: tenants_mod.TenantCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _auth: None = Depends(auth.require_scope("control")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """Create a new tenant (global-admin only)."""
    _require_global_admin(tenant_ctx)
    tenant = await tenants_mod.create_tenant(
        db, name=body.name, description=body.description, settings=body.settings,
    )
    resp = tenants_mod._tenant_to_response(tenant)
    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="create", resource_type="tenant", resource_id=str(tenant.id),
        details={"name": body.name}, **ctx,
    )
    return resp


@router.get("/tenants", dependencies=[Depends(auth.require_scope("read"))])
async def list_tenants(
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """List tenants visible to the caller.

    A global admin sees every tenant. A tenant-scoped caller sees only their
    own tenant (and an empty list if the token carries no `tenant:<id>`
    scope). When auth is disabled, all tenants are returned (single-user
    local mode).
    """
    items = await tenants_mod.list_tenants(db)
    if tenant_ctx.is_global_admin or not tenant_ctx.auth_enabled:
        return [tenants_mod._tenant_to_response(t) for t in items]
    return [
        tenants_mod._tenant_to_response(t)
        for t in items
        if t.id == tenant_ctx.tenant_id
    ]


@router.get("/tenants/{tenant_id}", dependencies=[Depends(auth.require_scope("read"))])
async def get_tenant(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """Get a tenant by ID, scoped to the caller's tenant boundary."""
    tenant_ctx.enforce(tenant_id)
    tenant = await tenants_mod.get_tenant(db, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return tenants_mod._tenant_to_response(tenant)


@router.put("/tenants/{tenant_id}")
async def update_tenant(
    tenant_id: int,
    body: tenants_mod.TenantUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _auth: None = Depends(auth.require_scope("control")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """Update an existing tenant (global-admin only)."""
    _require_global_admin(tenant_ctx)
    tenant = await tenants_mod.update_tenant(
        db, tenant_id,
        name=body.name, description=body.description, settings=body.settings,
    )
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    resp = tenants_mod._tenant_to_response(tenant)
    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="update", resource_type="tenant", resource_id=str(tenant_id),
        **ctx,
    )
    return resp


@router.delete("/tenants/{tenant_id}", status_code=204)
async def delete_tenant(
    tenant_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _auth: None = Depends(auth.require_scope("control")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """Delete a tenant (global-admin only)."""
    _require_global_admin(tenant_ctx)
    deleted = await tenants_mod.delete_tenant(db, tenant_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Tenant not found")
    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="delete", resource_type="tenant", resource_id=str(tenant_id),
        **ctx,
    )
    return None


@router.get("/tenants/{tenant_id}/projects", dependencies=[Depends(auth.require_scope("read"))])
async def get_tenant_projects(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """List all projects for a tenant, scoped to the caller's tenant boundary."""
    tenant_ctx.enforce(tenant_id)
    tenant = await tenants_mod.get_tenant(db, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    projects = await tenants_mod.get_tenant_projects(db, tenant_id)
    return [
        {
            "id": p.id,
            "name": p.name,
            "description": p.description,
            "status": p.status,
            "tenant_id": p.tenant_id,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        }
        for p in projects
    ]


# ===========================================================================
# RUN ENDPOINTS
# ===========================================================================


@router.post("/runs", status_code=201)
async def create_run(
    body: runs_mod.RunCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _auth: None = Depends(auth.require_scope("control")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """Create a new run, scoped to the caller's tenant boundary."""
    await _enforce_project_tenant(db, tenant_ctx, body.project_id)
    run_resp = await runs_mod.create_run(
        db, project_id=body.project_id, trigger=body.trigger, config=body.config,
    )
    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="create", resource_type="run", resource_id=str(run_resp.id),
        details={"project_id": body.project_id, "trigger": body.trigger}, **ctx,
    )
    return run_resp


@router.get("/runs", dependencies=[Depends(auth.require_scope("read"))])
async def list_runs(
    project_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """List runs with optional filters, scoped to the caller's tenant.

    A global admin / auth-disabled caller sees all runs. A tenant-scoped
    caller only ever sees runs whose project belongs to their tenant: an
    explicit project_id is enforced against the boundary, and an unscoped
    listing is narrowed to the caller's own projects.
    """
    if tenant_ctx.is_global_admin or not tenant_ctx.auth_enabled:
        return await runs_mod.list_runs(
            db, project_id=project_id, status=status, limit=limit, offset=offset,
        )

    if project_id is not None:
        # Targeting a specific project: enforce it belongs to the caller.
        await _enforce_project_tenant(db, tenant_ctx, project_id)
        return await runs_mod.list_runs(
            db, project_id=project_id, status=status, limit=limit, offset=offset,
        )

    # No project filter: restrict to the caller's own projects. A caller with
    # no tenant binding sees nothing (fail-closed).
    if tenant_ctx.tenant_id is None:
        return []
    proj_result = await db.execute(
        select(Project.id).where(Project.tenant_id == tenant_ctx.tenant_id)
    )
    owned_project_ids = [row[0] for row in proj_result]
    if not owned_project_ids:
        return []
    # Collect this tenant's runs across all its projects, then apply the
    # caller's limit/offset ONCE over the globally-sorted result so pagination
    # is correct (not per-project). We over-fetch up to limit+offset per
    # project to guarantee the merged top window is complete, then sort by
    # created_at desc and slice. Isolation is unconditional regardless.
    fetch_cap = limit + offset
    collected: list = []
    for pid in owned_project_ids:
        collected.extend(
            await runs_mod.list_runs(
                db, project_id=pid, status=status, limit=fetch_cap, offset=0,
            )
        )
    collected.sort(key=lambda r: r.created_at, reverse=True)
    return collected[offset:offset + limit]


@router.get("/runs/{run_id}", dependencies=[Depends(auth.require_scope("read"))])
async def get_run(
    run_id: int,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """Get run details by ID, scoped to the caller's tenant boundary."""
    await _enforce_run_tenant(db, tenant_ctx, run_id)
    run_resp = await runs_mod.get_run(db, run_id)
    if run_resp is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run_resp


@router.post("/runs/{run_id}/cancel")
async def cancel_run(
    run_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _auth: None = Depends(auth.require_scope("control")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """Cancel a running run, scoped to the caller's tenant boundary."""
    await _enforce_run_tenant(db, tenant_ctx, run_id)
    run_resp = await runs_mod.cancel_run(db, run_id)
    if run_resp is None:
        raise HTTPException(status_code=404, detail="Run not found")
    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="cancel", resource_type="run", resource_id=str(run_id), **ctx,
    )
    return run_resp


@router.post("/runs/{run_id}/replay")
async def replay_run(
    run_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _auth: None = Depends(auth.require_scope("control")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """Replay a run, scoped to the caller's tenant boundary."""
    await _enforce_run_tenant(db, tenant_ctx, run_id)
    run_resp = await runs_mod.replay_run(db, run_id)
    if run_resp is None:
        raise HTTPException(status_code=404, detail="Run not found")
    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="replay", resource_type="run", resource_id=str(run_id), **ctx,
    )
    return run_resp


@router.get("/runs/{run_id}/timeline", dependencies=[Depends(auth.require_scope("read"))])
async def get_run_timeline(
    run_id: int,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
):
    """Get the timeline of events for a run, scoped to the caller's tenant."""
    await _enforce_run_tenant(db, tenant_ctx, run_id)
    timeline = await runs_mod.get_run_timeline(db, run_id)
    if timeline is None:
        return {"run_id": run_id, "phases": [], "current_phase": None, "events": []}
    return timeline


# ===========================================================================
# API KEY ENDPOINTS
# ===========================================================================


@router.post("/api-keys", status_code=201)
async def create_api_key(
    body: api_keys.ApiKeyCreate,
    request: Request,
    _auth: None = Depends(auth.require_scope("admin")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
):
    """Create a new API key."""
    try:
        result = auth.generate_token(
            name=body.name,
            scopes=body.scopes,
            expires_days=body.expires_days,
            role=body.role,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Update extra metadata if provided
    if body.description or body.allowed_ips or body.rate_limit:
        try:
            api_keys.update_key_metadata(
                result["id"],
                description=body.description,
                allowed_ips=body.allowed_ips,
                rate_limit=body.rate_limit,
            )
        except ValueError:
            pass  # key was just created, so this should not fail

    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="create", resource_type="api_key", resource_id=result["id"],
        details={"name": body.name}, **ctx,
    )
    return result


@router.get("/api-keys", dependencies=[Depends(auth.require_scope("read"))])
async def list_api_keys():
    """List all API keys."""
    return api_keys.list_keys_with_details()


@router.get("/api-keys/{identifier}", dependencies=[Depends(auth.require_scope("read"))])
async def get_api_key(identifier: str):
    """Get API key details by ID or name."""
    details = api_keys.get_key_details(identifier)
    if details is None:
        raise HTTPException(status_code=404, detail="API key not found")
    return details


@router.put("/api-keys/{identifier}")
async def update_api_key(
    identifier: str,
    body: ApiKeyUpdateRequest,
    request: Request,
    _auth: None = Depends(auth.require_scope("admin")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
):
    """Update API key metadata."""
    try:
        result = api_keys.update_key_metadata(
            identifier,
            description=body.description,
            allowed_ips=body.allowed_ips,
            rate_limit=body.rate_limit,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="update", resource_type="api_key", resource_id=identifier, **ctx,
    )
    return result


@router.delete("/api-keys/{identifier}", status_code=204)
async def delete_api_key(
    identifier: str,
    request: Request,
    _auth: None = Depends(auth.require_scope("admin")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
):
    """Delete an API key."""
    deleted = auth.delete_token(identifier)
    if not deleted:
        raise HTTPException(status_code=404, detail="API key not found")
    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="delete", resource_type="api_key", resource_id=identifier, **ctx,
    )
    return None


@router.post("/api-keys/{identifier}/rotate")
async def rotate_api_key(
    identifier: str,
    body: api_keys.ApiKeyRotateRequest,
    request: Request,
    _auth: None = Depends(auth.require_scope("admin")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
):
    """Rotate an API key."""
    try:
        result = api_keys.rotate_key(identifier, grace_period_hours=body.grace_period_hours)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="rotate", resource_type="api_key", resource_id=identifier,
        details={"new_key_id": result.get("new_key", {}).get("id")}, **ctx,
    )
    return result


# ===========================================================================
# POLICY ENDPOINTS
# ===========================================================================


@router.get("/policies", dependencies=[Depends(auth.require_scope("read"))])
async def get_policies():
    """Get current policies."""
    return _load_policies()


@router.put("/policies")
async def update_policies(
    body: PolicyUpdate,
    request: Request,
    _auth: None = Depends(auth.require_scope("admin")),
    token_info: Optional[dict] = Depends(auth.get_current_token),
):
    """Update policies."""
    serialized = json.dumps(body.policies)
    if len(serialized.encode("utf-8")) > 1_000_000:
        raise HTTPException(status_code=413, detail="Policy payload exceeds 1MB limit")
    _save_policies(body.policies)
    ctx = _audit_context(request, token_info)
    audit.log_event(
        action="update", resource_type="policy", **ctx,
    )
    return body.policies


@router.post("/policies/evaluate")
async def evaluate_policy(
    body: PolicyEvaluateRequest,
    _auth: None = Depends(auth.require_scope("control")),
):
    """Evaluate a policy check against current policies."""
    policies = _load_policies()

    # Simple policy evaluation: check if the action is allowed for the resource type
    rules = policies.get("rules", [])
    result = {"allowed": True, "matched_rules": [], "action": body.action, "resource_type": body.resource_type}

    for rule in rules:
        rule_action = rule.get("action", "*")
        rule_resource = rule.get("resource_type", "*")

        if (rule_action == "*" or rule_action == body.action) and \
           (rule_resource == "*" or rule_resource == body.resource_type):
            result["matched_rules"].append(rule)
            if rule.get("effect") == "deny":
                result["allowed"] = False

    return result


# ===========================================================================
# AUDIT ENDPOINTS
# ===========================================================================


@router.get("/audit", dependencies=[Depends(auth.require_scope("audit"))])
async def query_audit_logs(
    start_date: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    action: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=10000),
    offset: int = Query(0, ge=0),
):
    """Query audit logs with filters."""
    return audit.query_logs(
        start_date=start_date,
        end_date=end_date,
        action=action,
        resource_type=resource_type,
        limit=limit,
        offset=offset,
    )


@router.get("/audit/verify", dependencies=[Depends(auth.require_scope("audit"))])
async def verify_audit_integrity():
    """Verify audit log integrity across all log files.

    v7.7.15 (council fix): delegates to `audit.verify_all_logs()` which
    threads the chain hash across rotated daily files. The previous
    per-file loop always started each file from genesis "0"*64, so any
    log file beyond the first ever rotated false-negatived. Per-file
    breakdown still returned alongside the aggregate verdict for
    operator visibility.
    """
    aggregate = audit.verify_all_logs()

    # Per-file breakdown for operator visibility (sorted by mtime
    # to match the aggregate chain-walk order)
    results = []
    if audit.AUDIT_DIR.exists():
        log_files = sorted(audit.AUDIT_DIR.glob("audit-*.jsonl"),
                          key=lambda p: p.stat().st_mtime)
        prev_hash = "0" * 64
        for log_file in log_files:
            if not audit._file_has_integrity(str(log_file)):
                results.append({
                    "file": log_file.name,
                    "valid": True,
                    "skipped_pre_integrity": True,
                    "entries_checked": 0,
                })
                continue
            r = audit.verify_log_integrity(str(log_file), start_hash=prev_hash)
            r["file"] = log_file.name
            results.append(r)
            if r.get("valid"):
                prev_hash = r.get("last_hash", prev_hash)

    return {
        "valid": aggregate["valid"],
        "files_checked": aggregate["files_checked"],
        "files_skipped": aggregate.get("files_skipped", 0),
        "entries_checked": aggregate.get("entries_checked", 0),
        "genesis_file": aggregate.get("genesis_file"),
        "first_tampered_file": aggregate.get("first_tampered_file"),
        "first_tampered_line": aggregate.get("first_tampered_line"),
        "results": results,
    }


@router.get("/audit/export", dependencies=[Depends(auth.require_scope("audit"))])
async def export_audit_logs(
    start_date: Optional[str] = Query(None, description="Start date (YYYY-MM-DD)"),
    end_date: Optional[str] = Query(None, description="End date (YYYY-MM-DD)"),
    format: str = Query("json", description="Export format: json or csv"),
):
    """Export audit logs in JSON or CSV format."""
    entries = audit.query_logs(
        start_date=start_date,
        end_date=end_date,
        limit=10000,
    )

    if format == "csv":
        output = io.StringIO()
        if entries:
            fieldnames = list(entries[0].keys())
            writer = csv.DictWriter(output, fieldnames=fieldnames)
            writer.writeheader()
            for entry in entries:
                # Flatten any dict values to JSON strings for CSV
                flat = {}
                for k, v in entry.items():
                    flat[k] = json.dumps(v) if isinstance(v, (dict, list)) else v
                writer.writerow(flat)

        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=audit-export.csv"},
        )

    return entries
