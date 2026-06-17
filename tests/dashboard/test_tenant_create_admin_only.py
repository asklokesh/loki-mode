"""
tests/dashboard/test_tenant_create_admin_only.py

Security regression test: tenant LIFECYCLE operations (create/update/delete)
are global-admin-only.

Before the fix, create_tenant required only require_scope("control") and did
NOT resolve the tenant context or gate on global-admin authority. A non-admin
caller holding the `control` scope (tenant-scoped, e.g. ["control", "tenant:5"])
could therefore create arbitrary new tenants outside any isolation boundary.
The `control` scope does not imply `admin` (see _SCOPE_HIERARCHY in auth.py:
control -> {write, read} only; admin is granted exclusively by `*`), so the
fix is to gate creation behind global-admin. update/delete are made consistent.

The caller's authority is derived from the TRUSTED, server-validated token: a
global admin carries the `*` (admin) scope. These tests override only
auth.get_current_token (to honestly stand in for a validated token of a given
scope set) and get_db (to point at a seeded in-memory DB). The gate logic
itself (_require_global_admin / resolve_tenant_context) is NOT mocked -- it is
the code under test.

This test mirrors test_tenant_isolation.py: it mutates and restores the
auth module-level flags directly and NEVER reloads dashboard.auth (an
importlib.reload of that module previously broke a release by polluting global
auth state for sibling tests). The auth flag mutation is restored in
tearDownClass so module state is left exactly as found.

Assertions:
    - tenant-scoped control token -> create_tenant denied (403)
    - global admin (`*`) token     -> create_tenant allowed (201, created)
    - tenant-scoped control token -> update_tenant denied (403)
    - tenant-scoped control token -> delete_tenant denied (403)
    - global admin (`*`) token     -> delete_tenant allowed (204)
"""

from __future__ import annotations

import asyncio
import os
import sys
import unittest

# Ensure the repo root is importable so `from dashboard import ...` resolves
# regardless of the directory pytest/unittest is invoked from.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


class TenantCreateAdminOnlyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Enterprise auth must be on for the global-admin gate to apply to
        # non-admin callers. Set it before importing dashboard.auth so the
        # module-level ENTERPRISE_AUTH_ENABLED flag reflects it; we also force
        # the flag directly below to be robust to import ordering.
        os.environ["LOKI_ENTERPRISE_AUTH"] = "true"

        from fastapi.testclient import TestClient
        from sqlalchemy.ext.asyncio import (
            AsyncSession,
            async_sessionmaker,
            create_async_engine,
        )

        from dashboard import auth
        from dashboard.models import Base, Tenant
        from dashboard.server import app, get_db

        # Dedicated in-memory engine so we do not depend on database.py's
        # module-level engine (bound once, at first import, to whatever
        # LOKI_DATA_DIR was then).
        cls._engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
        cls._session_factory = async_sessionmaker(
            cls._engine, class_=AsyncSession, expire_on_commit=False
        )

        cls.app = app
        cls.auth = auth
        cls.get_db = get_db

        # Force enterprise auth on even if auth.py was imported earlier with it
        # off, and remember the original values to restore in tearDownClass.
        # NOTE: we deliberately do NOT importlib.reload(auth) -- mutate + restore
        # only, to avoid polluting global auth module state for sibling tests.
        cls._orig_enterprise = auth.ENTERPRISE_AUTH_ENABLED
        cls._orig_oidc = auth.OIDC_ENABLED
        auth.ENTERPRISE_AUTH_ENABLED = True
        auth.OIDC_ENABLED = False

        async def _setup_db():
            async with cls._engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            async with cls._session_factory() as session:
                # A single existing tenant for the update/delete cases.
                tenant = Tenant(name="Existing Tenant", slug="existing-tenant")
                session.add(tenant)
                await session.flush()
                await session.commit()
                cls.tenant_id = tenant.id

        asyncio.run(_setup_db())

        async def _override_get_db():
            async with cls._session_factory() as session:
                try:
                    yield session
                    await session.commit()
                except Exception:
                    await session.rollback()
                    raise

        cls.app.dependency_overrides[get_db] = _override_get_db
        cls.TestClient = TestClient

    @classmethod
    def tearDownClass(cls):
        cls.app.dependency_overrides.clear()
        cls.auth.ENTERPRISE_AUTH_ENABLED = cls._orig_enterprise
        cls.auth.OIDC_ENABLED = cls._orig_oidc
        asyncio.run(cls._engine.dispose())

    # -- helpers -----------------------------------------------------------

    def _override_token(self, scopes):
        """Override auth.get_current_token to return a token with given scopes.

        Honestly stands in for a validated token: it returns exactly the shape
        validate_token() returns (id/name/scopes). The caller's authority lives
        in its (trusted) scope list; the gate logic remains real.
        """
        async def _fake_token():
            return {"id": "tok", "name": "tester", "scopes": list(scopes)}

        self.app.dependency_overrides[self.auth.get_current_token] = _fake_token

    def _tenant_scope(self, tenant_id):
        return f"tenant:{tenant_id}"

    def _clear_token(self):
        self.app.dependency_overrides.pop(self.auth.get_current_token, None)

    def _client(self):
        return self.TestClient(self.app, raise_server_exceptions=False)

    def tearDown(self):
        self._clear_token()

    # -- create ------------------------------------------------------------

    def test_tenant_scoped_control_token_cannot_create_tenant(self):
        """A tenant-scoped (non-admin) control token is denied (403).

        This is the discriminating, non-vacuous case: the token holds `control`
        (which would satisfy require_scope("control")) but is bound to a single
        tenant and is NOT a global admin. Against unfixed code this returns 201.
        """
        self._override_token(["control", self._tenant_scope(self.tenant_id)])
        resp = self._client().post(
            "/api/v2/tenants", json={"name": "Rogue Tenant"}
        )
        self.assertEqual(resp.status_code, 403, resp.text)

    def test_global_admin_can_create_tenant(self):
        """A global admin (`*`) may create a tenant (201)."""
        self._override_token(["*"])
        resp = self._client().post(
            "/api/v2/tenants", json={"name": "Admin Created Tenant"}
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        body = resp.json()
        self.assertEqual(body["name"], "Admin Created Tenant")
        self.assertIn("id", body)

    # -- update / delete consistency --------------------------------------

    def test_tenant_scoped_control_token_cannot_update_tenant(self):
        """A tenant-scoped control token cannot update a tenant (403)."""
        self._override_token(["control", self._tenant_scope(self.tenant_id)])
        resp = self._client().put(
            f"/api/v2/tenants/{self.tenant_id}", json={"name": "Renamed"}
        )
        self.assertEqual(resp.status_code, 403, resp.text)

    def test_tenant_scoped_control_token_cannot_delete_tenant(self):
        """A tenant-scoped control token cannot delete a tenant (403)."""
        self._override_token(["control", self._tenant_scope(self.tenant_id)])
        resp = self._client().delete(f"/api/v2/tenants/{self.tenant_id}")
        self.assertEqual(resp.status_code, 403, resp.text)
        # The tenant must still exist (admin can still read it).
        self._override_token(["*"])
        check = self._client().get(f"/api/v2/tenants/{self.tenant_id}")
        self.assertEqual(check.status_code, 200, check.text)

    def test_global_admin_can_delete_tenant(self):
        """A global admin may delete a tenant (204)."""
        # Create a throwaway tenant as admin, then delete it as admin.
        self._override_token(["*"])
        created = self._client().post(
            "/api/v2/tenants", json={"name": "Disposable Tenant"}
        )
        self.assertEqual(created.status_code, 201, created.text)
        new_id = created.json()["id"]
        resp = self._client().delete(f"/api/v2/tenants/{new_id}")
        self.assertEqual(resp.status_code, 204, resp.text)


if __name__ == "__main__":
    unittest.main()
