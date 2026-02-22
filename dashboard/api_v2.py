"""
V2 REST API Router for Loki Mode Dashboard.

Provides /api/v2/ endpoints for tenants, runs, API keys, policies, and audit.
Mount this router in server.py with:
    from .api_v2 import router as api_v2_router
    app.include_router(api_v2_router)
"""

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
from sqlalchemy.ext.asyncio import AsyncSession

from . import auth
from . import audit
from . import api_keys
from . import tenants as tenants_mod
from . import runs as runs_mod
from .database import get_db


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
):
    """Create a new tenant."""
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
):
    """List all tenants."""
    items = await tenants_mod.list_tenants(db)
    return [tenants_mod._tenant_to_response(t) for t in items]


@router.get("/tenants/{tenant_id}", dependencies=[Depends(auth.require_scope("read"))])
async def get_tenant(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Get a tenant by ID."""
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
):
    """Update an existing tenant."""
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
):
    """Delete a tenant."""
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
):
    """List all projects for a tenant."""
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
):
    """Create a new run."""
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
):
    """List runs with optional filters."""
    return await runs_mod.list_runs(
        db, project_id=project_id, status=status, limit=limit, offset=offset,
    )


@router.get("/runs/{run_id}", dependencies=[Depends(auth.require_scope("read"))])
async def get_run(
    run_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Get run details by ID."""
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
):
    """Cancel a running run."""
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
):
    """Replay a run."""
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
):
    """Get the timeline of events for a run."""
    timeline = await runs_mod.get_run_timeline(db, run_id)
    if timeline is None:
        raise HTTPException(status_code=404, detail="Run not found")
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
    """Verify audit log integrity across all log files."""
    if not audit.AUDIT_DIR.exists():
        return {"valid": True, "files_checked": 0, "results": []}

    log_files = sorted(audit.AUDIT_DIR.glob("audit-*.jsonl"))
    results = []
    all_valid = True

    for log_file in log_files:
        result = audit.verify_log_integrity(str(log_file))
        result["file"] = log_file.name
        results.append(result)
        if not result["valid"]:
            all_valid = False

    return {
        "valid": all_valid,
        "files_checked": len(log_files),
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
