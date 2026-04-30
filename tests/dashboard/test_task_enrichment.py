"""
tests/dashboard/test_task_enrichment.py

v7.5.12 task enrichment fields -- HTTP round-trip tests.

The dashboard task model gained three additive fields so the UI can show
useful detail instead of a bare "Iteration 1 / Done" card:

    - acceptance_criteria : list[str]
    - notes               : list[{timestamp, author, body}]
    - logs                : list[{timestamp, iteration, level, phase, message}]

These tests assert that the fields:
    1. Round-trip through POST /api/tasks  -> GET /api/tasks/{id}
    2. Survive a PUT /api/tasks/{id} with appended notes + logs
    3. Default to [] for legacy tasks created without them (backward compat)

Pattern mirrors tests/test_api_v2.py (in-memory aiosqlite, ASGITransport).
"""

from __future__ import annotations

import os
import sys
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Ensure project root is on path when run from anywhere.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from dashboard.models import Base, Project, Tenant


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db_session_factory(engine):
    return async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def app(engine, db_session_factory):
    # Disable enterprise auth + OIDC + scoped auth so anonymous POST works.
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
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def project_id(db_session_factory) -> int:
    async with db_session_factory() as session:
        async with session.begin():
            tenant = Tenant(name="T", slug="t")
            session.add(tenant)
            await session.flush()
            proj = Project(name="Demo", status="active", tenant_id=tenant.id)
            session.add(proj)
            await session.flush()
            await session.refresh(proj)
            return proj.id


# ---------------------------------------------------------------------------
# TESTS
# ---------------------------------------------------------------------------

class TestTaskEnrichmentRoundTrip:
    """v7.5.12: acceptance_criteria, notes, logs round-trip through the API."""

    @pytest.mark.asyncio
    async def test_create_with_enrichment_then_get_returns_same_fields(
        self, client, project_id
    ):
        payload = {
            "project_id": project_id,
            "title": "Iteration 1",
            "description": "RARV iteration 1. Build the login flow.",
            "acceptance_criteria": [
                "Login form renders",
                "Valid credentials redirect to dashboard",
                "Invalid credentials show inline error",
            ],
            "notes": [
                {
                    "timestamp": "2026-04-29T10:00:00Z",
                    "author": "system",
                    "body": "Iteration auto-started by runner.",
                },
            ],
            "logs": [
                {
                    "timestamp": "2026-04-29T10:00:01Z",
                    "iteration": 1,
                    "level": "info",
                    "phase": "REASON",
                    "message": "Selected next pending task from queue.",
                },
                {
                    "timestamp": "2026-04-29T10:00:30Z",
                    "iteration": 1,
                    "level": "info",
                    "phase": "ACT",
                    "message": "Wrote LoginForm component.",
                },
            ],
        }

        # POST -- enriched create.
        post_resp = await client.post("/api/tasks", json=payload)
        assert post_resp.status_code == 201, post_resp.text
        created = post_resp.json()
        task_id = created["id"]

        # Sanity: response echoes the enriched fields.
        assert created["description"] == payload["description"]
        assert created["acceptance_criteria"] == payload["acceptance_criteria"]
        assert len(created["notes"]) == 1
        assert created["notes"][0]["body"] == "Iteration auto-started by runner."
        assert len(created["logs"]) == 2
        assert {l["phase"] for l in created["logs"]} == {"REASON", "ACT"}

        # GET -- fields persisted across the request boundary.
        get_resp = await client.get(f"/api/tasks/{task_id}")
        assert get_resp.status_code == 200, get_resp.text
        fetched = get_resp.json()
        assert fetched["acceptance_criteria"] == payload["acceptance_criteria"]
        assert fetched["notes"][0]["author"] == "system"
        assert [l["phase"] for l in fetched["logs"]] == ["REASON", "ACT"]
        # Each log entry preserves its iteration number for UI grouping.
        assert all(l["iteration"] == 1 for l in fetched["logs"])

    @pytest.mark.asyncio
    async def test_legacy_task_without_enrichment_returns_empty_lists(
        self, client, project_id
    ):
        # Create a task WITHOUT any enrichment fields -- represents legacy
        # task rows created before v7.5.12 (DB columns NULL).
        post_resp = await client.post(
            "/api/tasks",
            json={
                "project_id": project_id,
                "title": "Plain Task",
                "description": "No frills",
            },
        )
        assert post_resp.status_code == 201, post_resp.text
        created = post_resp.json()

        # New fields surface as empty lists, not omitted / None.
        # This is the backward-compat contract: the dashboard UI can
        # always iterate over these without a None-check.
        assert created["acceptance_criteria"] == []
        assert created["notes"] == []
        assert created["logs"] == []

        # Same on GET.
        get_resp = await client.get(f"/api/tasks/{created['id']}")
        assert get_resp.status_code == 200
        fetched = get_resp.json()
        assert fetched["acceptance_criteria"] == []
        assert fetched["notes"] == []
        assert fetched["logs"] == []

    @pytest.mark.asyncio
    async def test_put_appends_logs_and_notes(self, client, project_id):
        # Create plain task.
        post_resp = await client.post(
            "/api/tasks",
            json={"project_id": project_id, "title": "Iteration 2"},
        )
        assert post_resp.status_code == 201
        task_id = post_resp.json()["id"]

        # PUT with enriched fields (e.g. after REASON phase).
        put_resp = await client.put(
            f"/api/tasks/{task_id}",
            json={
                "acceptance_criteria": ["Pass quality gates"],
                "notes": [
                    {
                        "timestamp": "2026-04-29T11:00:00Z",
                        "author": "human",
                        "body": "Looks good so far.",
                    }
                ],
                "logs": [
                    {
                        "timestamp": "2026-04-29T11:00:00Z",
                        "iteration": 2,
                        "level": "info",
                        "phase": "REFLECT",
                        "message": "Updated CONTINUITY.md.",
                    },
                ],
            },
        )
        assert put_resp.status_code == 200, put_resp.text
        updated = put_resp.json()
        assert updated["acceptance_criteria"] == ["Pass quality gates"]
        assert updated["notes"][0]["body"] == "Looks good so far."
        assert updated["logs"][0]["phase"] == "REFLECT"

        # GET reflects the update.
        get_resp = await client.get(f"/api/tasks/{task_id}")
        assert get_resp.status_code == 200
        fetched = get_resp.json()
        assert fetched["logs"][0]["phase"] == "REFLECT"
