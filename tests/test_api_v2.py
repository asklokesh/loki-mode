"""
Tests for dashboard/api_v2.py -- V2 REST API endpoints.

Covers:
- Tenant CRUD (create, list, get, update, delete, projects)
- Run CRUD (create, list, get, cancel, replay, timeline)
- API key endpoints (create, list, get, rotate, delete)
- Audit endpoints (query, verify)
- Policy endpoints (get, put)
- Auth enforcement (unauthenticated access returns 401 when auth enabled)

Uses httpx.AsyncClient with ASGITransport against the FastAPI app,
with an in-memory SQLite database override.
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dashboard.models import Base, Project


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def engine():
    """Create an in-memory async SQLite engine."""
    eng = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db_session_factory(engine):
    """Create a session factory bound to the in-memory engine."""
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def app(engine, db_session_factory, tmp_path):
    """Create a test FastAPI app with overridden DB dependency and auth disabled."""
    # Disable enterprise auth for tests (allow anonymous access)
    with patch.object(
        __import__("dashboard.auth", fromlist=["auth"]),
        "ENTERPRISE_AUTH_ENABLED",
        False,
    ), patch.object(
        __import__("dashboard.auth", fromlist=["auth"]),
        "OIDC_ENABLED",
        False,
    ):
        from dashboard.server import app as _app
        from dashboard.database import get_db

        async def _override_get_db():
            async with db_session_factory() as session:
                try:
                    yield session
                    await session.commit()
                except Exception:
                    await session.rollback()
                    raise

        _app.dependency_overrides[get_db] = _override_get_db
        yield _app
        _app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client(app):
    """Create an httpx AsyncClient for testing."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def seed_project(db_session_factory):
    """Seed a project into the DB for run tests."""
    async with db_session_factory() as session:
        async with session.begin():
            proj = Project(name="Test Project", status="active")
            session.add(proj)
            await session.flush()
            await session.refresh(proj)
            pid = proj.id
    return pid


# ---------------------------------------------------------------------------
# TENANT TESTS
# ---------------------------------------------------------------------------


class TestTenantEndpoints:
    """Tenant CRUD via /api/v2/tenants."""

    @pytest.mark.asyncio
    async def test_create_tenant(self, client):
        resp = await client.post("/api/v2/tenants", json={
            "name": "Acme Corp",
            "description": "Test tenant",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "Acme Corp"
        assert data["slug"] == "acme-corp"
        assert data["description"] == "Test tenant"
        assert "id" in data

    @pytest.mark.asyncio
    async def test_list_tenants(self, client):
        await client.post("/api/v2/tenants", json={"name": "Tenant A"})
        await client.post("/api/v2/tenants", json={"name": "Tenant B"})
        resp = await client.get("/api/v2/tenants")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 2
        names = [t["name"] for t in data]
        assert "Tenant A" in names
        assert "Tenant B" in names

    @pytest.mark.asyncio
    async def test_get_tenant(self, client):
        create_resp = await client.post("/api/v2/tenants", json={"name": "Get Me"})
        tenant_id = create_resp.json()["id"]
        resp = await client.get(f"/api/v2/tenants/{tenant_id}")
        assert resp.status_code == 200
        assert resp.json()["name"] == "Get Me"

    @pytest.mark.asyncio
    async def test_get_tenant_not_found(self, client):
        resp = await client.get("/api/v2/tenants/99999")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_update_tenant(self, client):
        create_resp = await client.post("/api/v2/tenants", json={"name": "Old Name"})
        tenant_id = create_resp.json()["id"]
        resp = await client.put(f"/api/v2/tenants/{tenant_id}", json={
            "name": "New Name",
            "description": "Updated",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "New Name"
        assert data["slug"] == "new-name"
        assert data["description"] == "Updated"

    @pytest.mark.asyncio
    async def test_delete_tenant(self, client):
        create_resp = await client.post("/api/v2/tenants", json={"name": "Delete Me"})
        tenant_id = create_resp.json()["id"]
        resp = await client.delete(f"/api/v2/tenants/{tenant_id}")
        assert resp.status_code == 204
        # Verify it's gone
        get_resp = await client.get(f"/api/v2/tenants/{tenant_id}")
        assert get_resp.status_code == 404

    @pytest.mark.asyncio
    async def test_tenant_projects(self, client):
        create_resp = await client.post("/api/v2/tenants", json={"name": "ProjectOwner"})
        tenant_id = create_resp.json()["id"]
        resp = await client.get(f"/api/v2/tenants/{tenant_id}/projects")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)


# ---------------------------------------------------------------------------
# RUN TESTS
# ---------------------------------------------------------------------------


class TestRunEndpoints:
    """Run CRUD via /api/v2/runs."""

    @pytest.mark.asyncio
    async def test_create_run(self, client, seed_project):
        resp = await client.post("/api/v2/runs", json={
            "project_id": seed_project,
            "trigger": "api-test",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["project_id"] == seed_project
        assert data["status"] == "running"
        assert data["trigger"] == "api-test"

    @pytest.mark.asyncio
    async def test_list_runs(self, client, seed_project):
        await client.post("/api/v2/runs", json={"project_id": seed_project})
        await client.post("/api/v2/runs", json={"project_id": seed_project})
        resp = await client.get("/api/v2/runs")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 2

    @pytest.mark.asyncio
    async def test_get_run(self, client, seed_project):
        create_resp = await client.post("/api/v2/runs", json={
            "project_id": seed_project,
        })
        run_id = create_resp.json()["id"]
        resp = await client.get(f"/api/v2/runs/{run_id}")
        assert resp.status_code == 200
        assert resp.json()["id"] == run_id

    @pytest.mark.asyncio
    async def test_get_run_not_found(self, client):
        resp = await client.get("/api/v2/runs/99999")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_cancel_run(self, client, seed_project):
        create_resp = await client.post("/api/v2/runs", json={
            "project_id": seed_project,
        })
        run_id = create_resp.json()["id"]
        resp = await client.post(f"/api/v2/runs/{run_id}/cancel")
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"

    @pytest.mark.asyncio
    async def test_replay_run(self, client, seed_project):
        create_resp = await client.post("/api/v2/runs", json={
            "project_id": seed_project,
        })
        run_id = create_resp.json()["id"]
        # Cancel the run first (only terminal runs can be replayed)
        await client.post(f"/api/v2/runs/{run_id}/cancel")
        resp = await client.post(f"/api/v2/runs/{run_id}/replay")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "replaying"
        assert data["parent_run_id"] == run_id

    @pytest.mark.asyncio
    async def test_run_timeline(self, client, seed_project):
        create_resp = await client.post("/api/v2/runs", json={
            "project_id": seed_project,
        })
        run_id = create_resp.json()["id"]
        resp = await client.get(f"/api/v2/runs/{run_id}/timeline")
        assert resp.status_code == 200
        data = resp.json()
        assert data["run_id"] == run_id
        assert "events" in data


# ---------------------------------------------------------------------------
# API KEY TESTS
# ---------------------------------------------------------------------------


class TestApiKeyEndpoints:
    """API key management via /api/v2/api-keys."""

    @pytest.fixture(autouse=True)
    def _setup_token_dir(self, tmp_path):
        """Use a temp directory for token storage."""
        token_dir = tmp_path / "tokens"
        token_dir.mkdir()
        token_file = token_dir / "tokens.json"
        token_file.write_text('{"version": "1.0", "tokens": {}}')

        with patch("dashboard.auth.TOKEN_DIR", token_dir), \
             patch("dashboard.auth.TOKEN_FILE", token_file):
            yield

    @pytest.mark.asyncio
    async def test_create_api_key(self, client):
        resp = await client.post("/api/v2/api-keys", json={
            "name": "test-key-create",
            "scopes": ["read"],
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "test-key-create"
        assert "token" in data  # raw token shown once

    @pytest.mark.asyncio
    async def test_list_api_keys(self, client):
        await client.post("/api/v2/api-keys", json={"name": "list-key-1"})
        await client.post("/api/v2/api-keys", json={"name": "list-key-2"})
        resp = await client.get("/api/v2/api-keys")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 2

    @pytest.mark.asyncio
    async def test_get_api_key(self, client):
        create_resp = await client.post("/api/v2/api-keys", json={
            "name": "get-key-detail",
        })
        key_id = create_resp.json()["id"]
        resp = await client.get(f"/api/v2/api-keys/{key_id}")
        assert resp.status_code == 200
        assert resp.json()["name"] == "get-key-detail"

    @pytest.mark.asyncio
    async def test_rotate_api_key(self, client):
        create_resp = await client.post("/api/v2/api-keys", json={
            "name": "rotate-me",
        })
        key_id = create_resp.json()["id"]
        resp = await client.post(f"/api/v2/api-keys/{key_id}/rotate", json={
            "grace_period_hours": 1,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "new_key" in data
        assert data["old_key_id"] == key_id

    @pytest.mark.asyncio
    async def test_delete_api_key(self, client):
        create_resp = await client.post("/api/v2/api-keys", json={
            "name": "delete-me-key",
        })
        key_id = create_resp.json()["id"]
        resp = await client.delete(f"/api/v2/api-keys/{key_id}")
        assert resp.status_code == 204
        # Verify it's gone
        get_resp = await client.get(f"/api/v2/api-keys/{key_id}")
        assert get_resp.status_code == 404


# ---------------------------------------------------------------------------
# AUDIT TESTS
# ---------------------------------------------------------------------------


class TestAuditEndpoints:
    """Audit log endpoints via /api/v2/audit."""

    @pytest.mark.asyncio
    async def test_query_audit_logs(self, client):
        resp = await client.get("/api/v2/audit")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    @pytest.mark.asyncio
    async def test_verify_audit_integrity(self, client):
        resp = await client.get("/api/v2/audit/verify")
        assert resp.status_code == 200
        data = resp.json()
        assert "valid" in data
        assert "files_checked" in data


# ---------------------------------------------------------------------------
# POLICY TESTS
# ---------------------------------------------------------------------------


class TestPolicyEndpoints:
    """Policy endpoints via /api/v2/policies."""

    @pytest.fixture(autouse=True)
    def _setup_policies_dir(self, tmp_path):
        """Use a temp directory for policy storage."""
        with patch("dashboard.api_v2._LOKI_DIR", tmp_path):
            yield

    @pytest.mark.asyncio
    async def test_get_policies_empty(self, client):
        resp = await client.get("/api/v2/policies")
        assert resp.status_code == 200
        assert resp.json() == {}

    @pytest.mark.asyncio
    async def test_put_policies(self, client):
        policies = {
            "rules": [
                {"action": "delete", "resource_type": "project", "effect": "deny"},
            ]
        }
        resp = await client.put("/api/v2/policies", json={"policies": policies})
        assert resp.status_code == 200
        assert resp.json() == policies
        # Verify persistence
        get_resp = await client.get("/api/v2/policies")
        assert get_resp.status_code == 200
        assert get_resp.json() == policies


# ---------------------------------------------------------------------------
# AUTH ENFORCEMENT TEST
# ---------------------------------------------------------------------------


class TestAuthEnforcement:
    """Verify that auth-protected endpoints reject unauthenticated requests
    when enterprise auth is enabled."""

    @pytest.mark.asyncio
    async def test_unauthenticated_rejected_when_auth_enabled(self, app):
        """With ENTERPRISE_AUTH_ENABLED=True, control endpoints should return 401."""
        import dashboard.auth as auth_mod

        original_enterprise = auth_mod.ENTERPRISE_AUTH_ENABLED
        original_oidc = auth_mod.OIDC_ENABLED
        try:
            auth_mod.ENTERPRISE_AUTH_ENABLED = True
            auth_mod.OIDC_ENABLED = False

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                # POST /api/v2/tenants requires "control" scope
                resp = await c.post("/api/v2/tenants", json={"name": "Should Fail"})
                assert resp.status_code == 401
        finally:
            auth_mod.ENTERPRISE_AUTH_ENABLED = original_enterprise
            auth_mod.OIDC_ENABLED = original_oidc
