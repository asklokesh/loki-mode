"""
tests/dashboard/test_tenant_isolation.py

Regression + behavioural test for API-level tenant isolation (backlog P3-7).

Before the fix, project and tenant endpoints did not scope reads/writes to the
caller's tenant: any authenticated caller with the `read` scope could list
every tenant and read any tenant's projects, and the project endpoints in
server.py had no tenant boundary at all. A caller authenticated for tenant A
could therefore request tenant B's project and receive the data.

The caller's tenant is derived from the TRUSTED, server-validated token: a
token bound to tenant 5 carries a `tenant:5` scope (validate_token returns the
scope list from the server-side token store, so it cannot be forged by the
client). The fix never trusts a client-supplied header. These tests override
only auth.get_current_token (to honestly stand in for a validated token of a
given scope set) and get_db (to point at the seeded DB). The tenant-boundary
logic itself (resolve_tenant_context / enforce) is NOT mocked -- it is the
code under test.

Assertions:
    - tenant-A token requesting tenant-B's project           -> denied (403)
    - tenant-A token requesting its OWN tenant's project      -> allowed (200)
    - tenant-A token listing projects                         -> only sees A's
    - un-scoped token listing projects                        -> sees none
    - tenant-A token listing tenants (v2)                     -> only sees A
    - tenant-A token reading tenant B (v2)                    -> denied (403)
    - tenant-A token reading tenant B's projects (v2)         -> denied (403)
    - global admin crossing into tenant B                     -> allowed (200)
    - ATTACK: header cannot be used to impersonate a tenant   -> denied (403)
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


class TenantIsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Enterprise auth must be on for the tenant boundary to apply to
        # non-admin callers. Set it before importing dashboard.auth so the
        # module-level ENTERPRISE_AUTH_ENABLED flag reflects it; if auth was
        # already imported by another test, we patch the flag directly below.
        os.environ["LOKI_ENTERPRISE_AUTH"] = "true"

        from fastapi.testclient import TestClient
        from sqlalchemy.ext.asyncio import (
            AsyncSession,
            async_sessionmaker,
            create_async_engine,
        )

        from dashboard import auth
        from dashboard.models import Base, Project, Run, Task, Tenant
        from dashboard.server import app, get_db

        # Robust to import ordering: build a dedicated in-memory engine + session
        # factory for this test rather than relying on database.py's module-level
        # engine (which is bound once, at first import, to whatever LOKI_DATA_DIR
        # was then -- possibly a stale DB without the tenant_id column).
        cls._engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
        cls._session_factory = async_sessionmaker(
            cls._engine, class_=AsyncSession, expire_on_commit=False
        )

        cls.app = app
        cls.auth = auth
        cls.get_db = get_db

        # Force enterprise auth on even if auth.py was imported earlier with it
        # off, and remember the original value to restore in tearDownClass.
        cls._orig_enterprise = auth.ENTERPRISE_AUTH_ENABLED
        cls._orig_oidc = auth.OIDC_ENABLED
        auth.ENTERPRISE_AUTH_ENABLED = True
        auth.OIDC_ENABLED = False

        async def _setup_db():
            async with cls._engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            async with cls._session_factory() as session:
                tenant_a = Tenant(name="Tenant A", slug="tenant-a")
                tenant_b = Tenant(name="Tenant B", slug="tenant-b")
                session.add_all([tenant_a, tenant_b])
                await session.flush()
                proj_a = Project(name="Project A", tenant_id=tenant_a.id)
                proj_b = Project(name="Project B", tenant_id=tenant_b.id)
                session.add_all([proj_a, proj_b])
                await session.flush()
                run_a = Run(project_id=proj_a.id, status="running", trigger="manual")
                run_b = Run(project_id=proj_b.id, status="running", trigger="manual")
                task_a = Task(project_id=proj_a.id, title="Task A")
                task_b = Task(project_id=proj_b.id, title="Task B")
                session.add_all([run_a, run_b, task_a, task_b])
                await session.flush()
                await session.commit()
                cls.tenant_a_id = tenant_a.id
                cls.tenant_b_id = tenant_b.id
                cls.project_a_id = proj_a.id
                cls.project_b_id = proj_b.id
                cls.run_a_id = run_a.id
                cls.run_b_id = run_b.id
                cls.task_a_id = task_a.id
                cls.task_b_id = task_b.id

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

        This honestly stands in for a validated token: it returns exactly the
        shape validate_token() returns (id/name/scopes). The token's tenant
        binding lives in its (trusted) scope list, e.g. "tenant:3". The
        tenant-boundary logic remains real.
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

    # -- server.py project endpoints --------------------------------------

    def test_tenant_a_denied_other_tenant_project(self):
        """A tenant-A token requesting tenant-B's project is denied (403)."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get(f"/api/projects/{self.project_b_id}")
        self.assertEqual(resp.status_code, 403, resp.text)
        self.assertNotIn("Project B", resp.text)

    def test_tenant_a_allowed_own_project(self):
        """A tenant-A token requesting its own project succeeds (200)."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get(f"/api/projects/{self.project_a_id}")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["id"], self.project_a_id)
        self.assertEqual(body["tenant_id"], self.tenant_a_id)

    def test_list_projects_scoped_to_caller_tenant(self):
        """Listing projects returns only the caller's tenant's projects."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get("/api/projects")
        self.assertEqual(resp.status_code, 200, resp.text)
        ids = {p["id"] for p in resp.json()}
        self.assertIn(self.project_a_id, ids)
        self.assertNotIn(self.project_b_id, ids)

    def test_list_projects_unscoped_token_sees_none(self):
        """A token with no tenant scope sees no tenant-scoped projects."""
        self._override_token(["read"])
        resp = self._client().get("/api/projects")
        self.assertEqual(resp.status_code, 200, resp.text)
        ids = {p["id"] for p in resp.json()}
        self.assertNotIn(self.project_a_id, ids)
        self.assertNotIn(self.project_b_id, ids)

    def test_global_admin_can_cross_tenants(self):
        """A global admin may read any tenant's project."""
        self._override_token(["*"])
        resp = self._client().get(f"/api/projects/{self.project_b_id}")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["id"], self.project_b_id)

    def test_header_cannot_impersonate_tenant(self):
        """ATTACK: a tenant-A token cannot reach tenant B by setting any header.

        This is the discriminating test: the caller's tenant must come from the
        trusted token, never from a client-supplied value. We send a tenant-A
        token and try every plausible header an attacker might guess; the
        target (tenant B's project) must still be denied.
        """
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        attacker_headers = {
            "X-Loki-Tenant-ID": str(self.tenant_b_id),
            "X-Tenant-ID": str(self.tenant_b_id),
            "Tenant-ID": str(self.tenant_b_id),
        }
        resp = self._client().get(
            f"/api/projects/{self.project_b_id}", headers=attacker_headers
        )
        self.assertEqual(resp.status_code, 403, resp.text)
        self.assertNotIn("Project B", resp.text)

    def test_delete_other_tenant_project_denied(self):
        """WRITE PATH: a tenant-A token deleting tenant-B's project is denied."""
        self._override_token(
            ["control", "read", self._tenant_scope(self.tenant_a_id)]
        )
        resp = self._client().delete(f"/api/projects/{self.project_b_id}")
        self.assertEqual(resp.status_code, 403, resp.text)
        # And the project must still exist (admin can still read it).
        self._override_token(["*"])
        check = self._client().get(f"/api/projects/{self.project_b_id}")
        self.assertEqual(check.status_code, 200, check.text)

    # -- api_v2.py run endpoints ------------------------------------------

    def test_v2_create_run_other_tenant_project_denied(self):
        """A tenant-A token creating a run on tenant-B's project is denied."""
        self._override_token(
            ["control", "read", self._tenant_scope(self.tenant_a_id)]
        )
        resp = self._client().post(
            "/api/v2/runs", json={"project_id": self.project_b_id}
        )
        self.assertEqual(resp.status_code, 403, resp.text)

    def test_v2_get_other_tenant_run_denied(self):
        """A tenant-A token reading tenant-B's run is denied (403)."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get(f"/api/v2/runs/{self.run_b_id}")
        self.assertEqual(resp.status_code, 403, resp.text)

    def test_v2_get_own_run_allowed(self):
        """A tenant-A token reading its own run succeeds (200)."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get(f"/api/v2/runs/{self.run_a_id}")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["id"], self.run_a_id)

    def test_v2_list_runs_scoped_to_tenant(self):
        """Listing runs (no project filter) returns only the caller's runs."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get("/api/v2/runs")
        self.assertEqual(resp.status_code, 200, resp.text)
        ids = {r["id"] for r in resp.json()}
        self.assertIn(self.run_a_id, ids)
        self.assertNotIn(self.run_b_id, ids)

    # -- server.py task endpoints (DB-backed) -----------------------------

    def test_create_task_other_tenant_project_denied(self):
        """A tenant-A token creating a task on tenant-B's project is denied."""
        self._override_token(
            ["control", "read", self._tenant_scope(self.tenant_a_id)]
        )
        resp = self._client().post(
            "/api/tasks", json={"project_id": self.project_b_id, "title": "x"}
        )
        self.assertEqual(resp.status_code, 403, resp.text)

    def test_get_other_tenant_task_denied(self):
        """A tenant-A token reading tenant-B's task is denied (403)."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get(f"/api/tasks/{self.task_b_id}")
        self.assertEqual(resp.status_code, 403, resp.text)

    def test_get_own_task_allowed(self):
        """A tenant-A token reading its own task succeeds (200)."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get(f"/api/tasks/{self.task_a_id}")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["id"], self.task_a_id)

    def test_delete_other_tenant_task_denied(self):
        """WRITE PATH: a tenant-A token deleting tenant-B's task is denied."""
        self._override_token(
            ["control", "read", self._tenant_scope(self.tenant_a_id)]
        )
        resp = self._client().delete(f"/api/tasks/{self.task_b_id}")
        self.assertEqual(resp.status_code, 403, resp.text)

    # -- api_v2.py tenant endpoints ---------------------------------------

    def test_v2_get_other_tenant_denied(self):
        """A tenant-A token reading tenant B via v2 is denied (403)."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get(f"/api/v2/tenants/{self.tenant_b_id}")
        self.assertEqual(resp.status_code, 403, resp.text)

    def test_v2_get_own_tenant_allowed(self):
        """A tenant-A token reading tenant A via v2 succeeds (200)."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get(f"/api/v2/tenants/{self.tenant_a_id}")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["id"], self.tenant_a_id)

    def test_v2_get_other_tenant_projects_denied(self):
        """A tenant-A token reading tenant B's projects via v2 is denied."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get(f"/api/v2/tenants/{self.tenant_b_id}/projects")
        self.assertEqual(resp.status_code, 403, resp.text)

    def test_v2_list_tenants_scoped(self):
        """Listing tenants via v2 returns only the caller's tenant."""
        self._override_token(["read", self._tenant_scope(self.tenant_a_id)])
        resp = self._client().get("/api/v2/tenants")
        self.assertEqual(resp.status_code, 200, resp.text)
        ids = {t["id"] for t in resp.json()}
        self.assertEqual(ids, {self.tenant_a_id})

    def test_v2_admin_lists_all_tenants(self):
        """A global admin sees every tenant via v2."""
        self._override_token(["*"])
        resp = self._client().get("/api/v2/tenants")
        self.assertEqual(resp.status_code, 200, resp.text)
        ids = {t["id"] for t in resp.json()}
        self.assertIn(self.tenant_a_id, ids)
        self.assertIn(self.tenant_b_id, ids)


if __name__ == "__main__":
    unittest.main()
