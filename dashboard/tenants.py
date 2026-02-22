"""
Multi-Tenant Project Isolation Module for Loki Mode Dashboard.

Provides tenant-level namespacing for projects, sessions, and tasks.
Tenants are always available but optional -- projects can exist without
a tenant (tenant_id=None) for backward compatibility.

Each tenant gets a unique slug (URL-safe identifier) auto-generated
from the tenant name.
"""

import json
import re
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Project, Tenant


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class TenantCreate(BaseModel):
    """Schema for creating a new tenant."""

    name: str = Field(..., min_length=1, max_length=255, description="Tenant name")
    description: Optional[str] = Field(None, description="Tenant description")
    settings: Optional[dict] = Field(None, description="Tenant configuration (stored as JSON)")


class TenantUpdate(BaseModel):
    """Schema for updating an existing tenant."""

    name: Optional[str] = Field(None, min_length=1, max_length=255, description="Tenant name")
    description: Optional[str] = Field(None, description="Tenant description")
    settings: Optional[dict] = Field(None, description="Tenant configuration (stored as JSON)")


class TenantResponse(BaseModel):
    """Schema for tenant API responses."""

    id: int
    name: str
    slug: str
    description: Optional[str] = None
    settings: Optional[dict] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Slug generation
# ---------------------------------------------------------------------------


def generate_slug(name: str) -> str:
    """Generate a URL-safe slug from a tenant name.

    Rules:
    - Convert to lowercase
    - Replace spaces and underscores with hyphens
    - Strip all characters that are not alphanumeric or hyphens
    - Collapse consecutive hyphens into one
    - Strip leading/trailing hyphens

    Args:
        name: The tenant name to slugify.

    Returns:
        A URL-safe slug string.
    """
    slug = name.lower()
    slug = re.sub(r"[\s_]+", "-", slug)
    slug = re.sub(r"[^a-z0-9-]", "", slug)
    slug = re.sub(r"-{2,}", "-", slug)
    slug = slug.strip("-")
    return slug


# ---------------------------------------------------------------------------
# Helper: serialize/deserialize settings
# ---------------------------------------------------------------------------


def _serialize_settings(settings: Optional[dict]) -> Optional[str]:
    """Serialize a settings dict to a JSON string for storage."""
    if settings is None:
        return None
    return json.dumps(settings)


def _deserialize_settings(settings_str: Optional[str]) -> Optional[dict]:
    """Deserialize a JSON string back to a dict."""
    if settings_str is None:
        return None
    try:
        return json.loads(settings_str)
    except (json.JSONDecodeError, TypeError):
        return None


def _tenant_to_response(tenant: Tenant) -> TenantResponse:
    """Convert a Tenant ORM object to a TenantResponse, deserializing settings."""
    return TenantResponse(
        id=tenant.id,
        name=tenant.name,
        slug=tenant.slug,
        description=tenant.description,
        settings=_deserialize_settings(tenant.settings),
        created_at=tenant.created_at,
        updated_at=tenant.updated_at,
    )


# ---------------------------------------------------------------------------
# CRUD operations (all async)
# ---------------------------------------------------------------------------


async def create_tenant(
    db: AsyncSession,
    name: str,
    description: Optional[str] = None,
    settings: Optional[dict] = None,
) -> Tenant:
    """Create a new tenant with an auto-generated slug.

    Args:
        db: Async database session.
        name: Human-readable tenant name (must be unique).
        description: Optional description of the tenant.
        settings: Optional configuration dict (stored as JSON).

    Returns:
        The newly created Tenant object.
    """
    slug = generate_slug(name)
    # Handle slug collisions by appending a numeric suffix
    base_slug = slug
    suffix = 2
    while True:
        existing = await get_tenant_by_slug(db, slug)
        if existing is None:
            break
        slug = f"{base_slug}-{suffix}"
        suffix += 1
    tenant = Tenant(
        name=name,
        slug=slug,
        description=description,
        settings=_serialize_settings(settings),
    )
    db.add(tenant)
    await db.flush()
    await db.refresh(tenant)
    return tenant


async def get_tenant(db: AsyncSession, tenant_id: int) -> Optional[Tenant]:
    """Get a tenant by its primary key ID.

    Args:
        db: Async database session.
        tenant_id: The tenant's integer ID.

    Returns:
        The Tenant object if found, None otherwise.
    """
    result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    return result.scalar_one_or_none()


async def get_tenant_by_slug(db: AsyncSession, slug: str) -> Optional[Tenant]:
    """Get a tenant by its URL-safe slug.

    Args:
        db: Async database session.
        slug: The tenant's slug string.

    Returns:
        The Tenant object if found, None otherwise.
    """
    result = await db.execute(select(Tenant).where(Tenant.slug == slug))
    return result.scalar_one_or_none()


async def list_tenants(db: AsyncSession) -> list[Tenant]:
    """List all tenants ordered by name.

    Args:
        db: Async database session.

    Returns:
        List of all Tenant objects.
    """
    result = await db.execute(select(Tenant).order_by(Tenant.name))
    return list(result.scalars().all())


async def update_tenant(
    db: AsyncSession,
    tenant_id: int,
    name: Optional[str] = None,
    description: Optional[str] = None,
    settings: Optional[dict] = None,
) -> Optional[Tenant]:
    """Update an existing tenant's fields.

    Only non-None arguments are applied. If the name changes, the slug
    is regenerated automatically.

    Args:
        db: Async database session.
        tenant_id: The tenant's integer ID.
        name: New name (slug is regenerated if changed).
        description: New description.
        settings: New configuration dict.

    Returns:
        The updated Tenant object, or None if not found.
    """
    tenant = await get_tenant(db, tenant_id)
    if tenant is None:
        return None

    if name is not None:
        tenant.name = name
        tenant.slug = generate_slug(name)
    if description is not None:
        tenant.description = description
    if settings is not None:
        tenant.settings = _serialize_settings(settings)

    await db.flush()
    await db.refresh(tenant)
    return tenant


async def delete_tenant(db: AsyncSession, tenant_id: int) -> bool:
    """Delete a tenant and cascade-delete its projects.

    Args:
        db: Async database session.
        tenant_id: The tenant's integer ID.

    Returns:
        True if the tenant was found and deleted, False otherwise.
    """
    tenant = await get_tenant(db, tenant_id)
    if tenant is None:
        return False

    await db.delete(tenant)
    await db.flush()
    return True


async def get_tenant_projects(db: AsyncSession, tenant_id: int) -> list[Project]:
    """List all projects belonging to a specific tenant.

    Args:
        db: Async database session.
        tenant_id: The tenant's integer ID.

    Returns:
        List of Project objects scoped to the tenant.
    """
    result = await db.execute(
        select(Project)
        .where(Project.tenant_id == tenant_id)
        .order_by(Project.created_at)
    )
    return list(result.scalars().all())
