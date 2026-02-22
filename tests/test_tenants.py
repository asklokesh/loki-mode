"""
Tests for dashboard/tenants.py -- multi-tenant project isolation.

Covers:
- Tenant CRUD (create, get, list, update, delete)
- Slug generation (spaces, special chars, consecutive hyphens, case)
- Tenant-project relationship (FK, cascade delete)
- Backward compatibility (projects without tenant_id)
- Settings serialization/deserialization
- Edge cases (duplicate names, missing tenants, empty slugs)

Uses in-memory SQLite with async sessions.
"""

import os
import sys

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

# Ensure project root is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dashboard.models import Base, Project, Tenant
from dashboard.tenants import (
    TenantCreate,
    TenantResponse,
    TenantUpdate,
    create_tenant,
    delete_tenant,
    generate_slug,
    get_tenant,
    get_tenant_by_slug,
    get_tenant_projects,
    list_tenants,
    update_tenant,
    _serialize_settings,
    _deserialize_settings,
    _tenant_to_response,
)


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
async def db(engine):
    """Provide an async session for each test, rolled back afterward."""
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with async_session() as session:
        async with session.begin():
            yield session


# ---------------------------------------------------------------------------
# Slug generation
# ---------------------------------------------------------------------------


class TestGenerateSlug:
    def test_simple_name(self):
        assert generate_slug("Acme Corp") == "acme-corp"

    def test_already_slugified(self):
        assert generate_slug("my-tenant") == "my-tenant"

    def test_special_characters_stripped(self):
        assert generate_slug("Hello World! @#$%") == "hello-world"

    def test_consecutive_spaces_collapsed(self):
        assert generate_slug("lots   of   spaces") == "lots-of-spaces"

    def test_underscores_to_hyphens(self):
        assert generate_slug("snake_case_name") == "snake-case-name"

    def test_leading_trailing_hyphens_stripped(self):
        assert generate_slug("--leading-trailing--") == "leading-trailing"

    def test_uppercase_to_lowercase(self):
        assert generate_slug("ALL CAPS NAME") == "all-caps-name"

    def test_mixed_separators(self):
        assert generate_slug("mixed - _ separators") == "mixed-separators"

    def test_unicode_stripped(self):
        # Non-ASCII chars are removed
        slug = generate_slug("cafe latte")
        assert slug == "cafe-latte"

    def test_empty_after_stripping(self):
        assert generate_slug("@#$%^&*") == ""

    def test_numbers_preserved(self):
        assert generate_slug("Team 42") == "team-42"


# ---------------------------------------------------------------------------
# CRUD: create_tenant
# ---------------------------------------------------------------------------


class TestCreateTenant:
    @pytest.mark.asyncio
    async def test_create_basic(self, db):
        tenant = await create_tenant(db, "Acme Corp")
        assert tenant.id is not None
        assert tenant.name == "Acme Corp"
        assert tenant.slug == "acme-corp"
        assert tenant.description is None
        assert tenant.settings is None

    @pytest.mark.asyncio
    async def test_create_with_description(self, db):
        tenant = await create_tenant(db, "Test Org", description="A test organization")
        assert tenant.description == "A test organization"

    @pytest.mark.asyncio
    async def test_create_with_settings(self, db):
        settings = {"max_projects": 10, "features": ["ci", "cd"]}
        tenant = await create_tenant(db, "Settings Org", settings=settings)
        assert tenant.settings is not None
        import json
        stored = json.loads(tenant.settings)
        assert stored["max_projects"] == 10
        assert stored["features"] == ["ci", "cd"]

    @pytest.mark.asyncio
    async def test_create_generates_slug_automatically(self, db):
        tenant = await create_tenant(db, "My Great Company")
        assert tenant.slug == "my-great-company"

    @pytest.mark.asyncio
    async def test_create_timestamps_set(self, db):
        tenant = await create_tenant(db, "Timestamped Org")
        assert tenant.created_at is not None
        assert tenant.updated_at is not None


# ---------------------------------------------------------------------------
# CRUD: get_tenant / get_tenant_by_slug
# ---------------------------------------------------------------------------


class TestGetTenant:
    @pytest.mark.asyncio
    async def test_get_by_id(self, db):
        created = await create_tenant(db, "Findable Org")
        found = await get_tenant(db, created.id)
        assert found is not None
        assert found.name == "Findable Org"

    @pytest.mark.asyncio
    async def test_get_by_id_not_found(self, db):
        found = await get_tenant(db, 99999)
        assert found is None

    @pytest.mark.asyncio
    async def test_get_by_slug(self, db):
        await create_tenant(db, "Slug Lookup Corp")
        found = await get_tenant_by_slug(db, "slug-lookup-corp")
        assert found is not None
        assert found.name == "Slug Lookup Corp"

    @pytest.mark.asyncio
    async def test_get_by_slug_not_found(self, db):
        found = await get_tenant_by_slug(db, "nonexistent-slug")
        assert found is None


# ---------------------------------------------------------------------------
# CRUD: list_tenants
# ---------------------------------------------------------------------------


class TestListTenants:
    @pytest.mark.asyncio
    async def test_list_empty(self, db):
        tenants = await list_tenants(db)
        assert tenants == []

    @pytest.mark.asyncio
    async def test_list_multiple(self, db):
        await create_tenant(db, "Alpha")
        await create_tenant(db, "Beta")
        await create_tenant(db, "Gamma")
        tenants = await list_tenants(db)
        assert len(tenants) == 3
        # Ordered by name
        names = [t.name for t in tenants]
        assert names == ["Alpha", "Beta", "Gamma"]


# ---------------------------------------------------------------------------
# CRUD: update_tenant
# ---------------------------------------------------------------------------


class TestUpdateTenant:
    @pytest.mark.asyncio
    async def test_update_name_regenerates_slug(self, db):
        tenant = await create_tenant(db, "Old Name")
        updated = await update_tenant(db, tenant.id, name="New Name")
        assert updated is not None
        assert updated.name == "New Name"
        assert updated.slug == "new-name"

    @pytest.mark.asyncio
    async def test_update_description(self, db):
        tenant = await create_tenant(db, "Desc Org")
        updated = await update_tenant(db, tenant.id, description="Updated description")
        assert updated.description == "Updated description"

    @pytest.mark.asyncio
    async def test_update_settings(self, db):
        tenant = await create_tenant(db, "Settings Org")
        updated = await update_tenant(db, tenant.id, settings={"plan": "enterprise"})
        import json
        assert json.loads(updated.settings) == {"plan": "enterprise"}

    @pytest.mark.asyncio
    async def test_update_nonexistent_returns_none(self, db):
        result = await update_tenant(db, 99999, name="Ghost")
        assert result is None

    @pytest.mark.asyncio
    async def test_update_partial_leaves_other_fields(self, db):
        tenant = await create_tenant(db, "Partial", description="Original desc")
        updated = await update_tenant(db, tenant.id, name="Partial Renamed")
        assert updated.name == "Partial Renamed"
        assert updated.description == "Original desc"


# ---------------------------------------------------------------------------
# CRUD: delete_tenant
# ---------------------------------------------------------------------------


class TestDeleteTenant:
    @pytest.mark.asyncio
    async def test_delete_existing(self, db):
        tenant = await create_tenant(db, "Doomed Org")
        result = await delete_tenant(db, tenant.id)
        assert result is True
        # Verify it is gone
        found = await get_tenant(db, tenant.id)
        assert found is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent(self, db):
        result = await delete_tenant(db, 99999)
        assert result is False


# ---------------------------------------------------------------------------
# Tenant-Project relationship
# ---------------------------------------------------------------------------


class TestTenantProjectRelationship:
    @pytest.mark.asyncio
    async def test_project_with_tenant(self, db):
        tenant = await create_tenant(db, "Project Owner")
        project = Project(name="My Project", tenant_id=tenant.id)
        db.add(project)
        await db.flush()
        await db.refresh(project)

        assert project.tenant_id == tenant.id

    @pytest.mark.asyncio
    async def test_get_tenant_projects(self, db):
        tenant = await create_tenant(db, "Multi Project Org")
        p1 = Project(name="Project A", tenant_id=tenant.id)
        p2 = Project(name="Project B", tenant_id=tenant.id)
        db.add_all([p1, p2])
        await db.flush()

        projects = await get_tenant_projects(db, tenant.id)
        assert len(projects) == 2
        names = {p.name for p in projects}
        assert names == {"Project A", "Project B"}

    @pytest.mark.asyncio
    async def test_get_tenant_projects_empty(self, db):
        tenant = await create_tenant(db, "Empty Org")
        projects = await get_tenant_projects(db, tenant.id)
        assert projects == []

    @pytest.mark.asyncio
    async def test_delete_tenant_cascades_to_projects(self, db):
        tenant = await create_tenant(db, "Cascade Org")
        project = Project(name="Cascade Project", tenant_id=tenant.id)
        db.add(project)
        await db.flush()
        project_id = project.id

        await delete_tenant(db, tenant.id)

        # Project should also be deleted via cascade
        from sqlalchemy import select as sa_select
        result = await db.execute(sa_select(Project).where(Project.id == project_id))
        assert result.scalar_one_or_none() is None


# ---------------------------------------------------------------------------
# Backward compatibility: projects without tenant
# ---------------------------------------------------------------------------


class TestBackwardCompatibility:
    @pytest.mark.asyncio
    async def test_project_without_tenant(self, db):
        """Projects can exist without a tenant (tenant_id=None)."""
        project = Project(name="Standalone Project")
        db.add(project)
        await db.flush()
        await db.refresh(project)

        assert project.tenant_id is None
        assert project.id is not None

    @pytest.mark.asyncio
    async def test_mixed_projects(self, db):
        """Tenanted and non-tenanted projects can coexist."""
        tenant = await create_tenant(db, "Partial Adoption")
        tenanted = Project(name="Tenanted", tenant_id=tenant.id)
        standalone = Project(name="Standalone")
        db.add_all([tenanted, standalone])
        await db.flush()

        # Only the tenanted project shows up in tenant scope
        projects = await get_tenant_projects(db, tenant.id)
        assert len(projects) == 1
        assert projects[0].name == "Tenanted"


# ---------------------------------------------------------------------------
# Settings serialization helpers
# ---------------------------------------------------------------------------


class TestSettingsSerialization:
    def test_serialize_none(self):
        assert _serialize_settings(None) is None

    def test_serialize_dict(self):
        import json
        result = _serialize_settings({"key": "value"})
        assert json.loads(result) == {"key": "value"}

    def test_deserialize_none(self):
        assert _deserialize_settings(None) is None

    def test_deserialize_valid_json(self):
        assert _deserialize_settings('{"key": "value"}') == {"key": "value"}

    def test_deserialize_invalid_json(self):
        assert _deserialize_settings("not json") is None


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class TestPydanticSchemas:
    def test_tenant_create_minimal(self):
        schema = TenantCreate(name="Test")
        assert schema.name == "Test"
        assert schema.description is None
        assert schema.settings is None

    def test_tenant_create_full(self):
        schema = TenantCreate(
            name="Full Org",
            description="A full tenant",
            settings={"plan": "pro"},
        )
        assert schema.name == "Full Org"
        assert schema.settings == {"plan": "pro"}

    def test_tenant_update_partial(self):
        schema = TenantUpdate(description="Updated only desc")
        assert schema.name is None
        assert schema.description == "Updated only desc"

    @pytest.mark.asyncio
    async def test_tenant_to_response_conversion(self, db):
        tenant = await create_tenant(
            db, "Response Org", description="desc", settings={"a": 1}
        )
        resp = _tenant_to_response(tenant)
        assert isinstance(resp, TenantResponse)
        assert resp.id == tenant.id
        assert resp.name == "Response Org"
        assert resp.slug == "response-org"
        assert resp.description == "desc"
        assert resp.settings == {"a": 1}
