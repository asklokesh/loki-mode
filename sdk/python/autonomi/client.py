"""Main client for the Autonomi Control Plane API."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from .auth import TokenAuth
from .types import ApiKey, AuditEntry, Project, Run, RunEvent, Tenant


class AutonomiError(Exception):
    """Base exception for Autonomi API errors."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        response_body: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


class AuthenticationError(AutonomiError):
    """Raised on 401 Unauthorized responses."""

    pass


class ForbiddenError(AutonomiError):
    """Raised on 403 Forbidden responses."""

    pass


class NotFoundError(AutonomiError):
    """Raised on 404 Not Found responses."""

    pass


_STATUS_ERROR_MAP = {
    401: AuthenticationError,
    403: ForbiddenError,
    404: NotFoundError,
}


class AutonomiClient:
    """Synchronous client for the Autonomi Control Plane API.

    Uses only Python standard library (urllib) -- zero external dependencies.

    Usage::

        client = AutonomiClient(
            base_url="http://localhost:57374",
            token="loki_xxx",
        )
        projects = client.list_projects()
    """

    def __init__(
        self,
        base_url: str = "http://localhost:57374",
        token: Optional[str] = None,
        timeout: int = 30,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._auth: Optional[TokenAuth] = TokenAuth(token) if token else None

    # -- internal helpers ----------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Execute an HTTP request and return parsed JSON (or None for 204)."""
        url = f"{self.base_url}{path}"

        if params:
            filtered = {k: v for k, v in params.items() if v is not None}
            if filtered:
                url = f"{url}?{urllib.parse.urlencode(filtered)}"

        body_bytes: Optional[bytes] = None
        if data is not None:
            body_bytes = json.dumps(data).encode("utf-8")

        req = urllib.request.Request(url, data=body_bytes, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")

        if self._auth:
            for key, value in self._auth.headers().items():
                req.add_header(key, value)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                if resp.status == 204:
                    return None
                raw = resp.read().decode("utf-8")
                if not raw:
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            response_body = ""
            try:
                response_body = exc.read().decode("utf-8")
            except Exception:
                pass

            error_cls = _STATUS_ERROR_MAP.get(exc.code, AutonomiError)
            message = f"HTTP {exc.code}: {exc.reason}"

            # Try to extract a message from the JSON body
            try:
                err_data = json.loads(response_body)
                if "detail" in err_data:
                    message = f"HTTP {exc.code}: {err_data['detail']}"
                elif "message" in err_data:
                    message = f"HTTP {exc.code}: {err_data['message']}"
            except (json.JSONDecodeError, KeyError):
                pass

            raise error_cls(message, status_code=exc.code, response_body=response_body)

    def _get(
        self, path: str, params: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        return self._request("GET", path, params=params)

    def _post(
        self, path: str, data: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        return self._request("POST", path, data=data)

    def _put(
        self, path: str, data: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        return self._request("PUT", path, data=data)

    def _delete(self, path: str) -> None:
        self._request("DELETE", path)

    # -- status --------------------------------------------------------------

    def get_status(self) -> Dict[str, Any]:
        """Get the API server status."""
        result = self._get("/api/status")
        return result or {}

    # -- projects ------------------------------------------------------------

    def list_projects(self) -> List[Project]:
        """List all projects."""
        result = self._get("/api/projects")
        if not result:
            return []
        items = result if isinstance(result, list) else result.get("projects", [])
        return [Project.from_dict(p) for p in items]

    def get_project(self, project_id: str) -> Project:
        """Get a single project by ID."""
        result = self._get(f"/api/projects/{project_id}")
        return Project.from_dict(result)

    def create_project(
        self, name: str, description: Optional[str] = None
    ) -> Project:
        """Create a new project."""
        payload: Dict[str, Any] = {"name": name}
        if description is not None:
            payload["description"] = description
        result = self._post("/api/projects", data=payload)
        return Project.from_dict(result)

    # -- tenants -------------------------------------------------------------

    def list_tenants(self) -> List[Tenant]:
        """List all tenants."""
        result = self._get("/api/v2/tenants")
        if not result:
            return []
        items = result if isinstance(result, list) else result.get("tenants", [])
        return [Tenant.from_dict(t) for t in items]

    def create_tenant(
        self, name: str, description: Optional[str] = None
    ) -> Tenant:
        """Create a new tenant."""
        payload: Dict[str, Any] = {"name": name}
        if description is not None:
            payload["description"] = description
        result = self._post("/api/v2/tenants", data=payload)
        return Tenant.from_dict(result)

    # -- runs ----------------------------------------------------------------

    def list_runs(
        self,
        project_id: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[Run]:
        """List runs, optionally filtered by project and/or status."""
        params: Dict[str, Any] = {}
        if project_id is not None:
            params["project_id"] = project_id
        if status is not None:
            params["status"] = status
        result = self._get("/api/v2/runs", params=params or None)
        if not result:
            return []
        items = result if isinstance(result, list) else result.get("runs", [])
        return [Run.from_dict(r) for r in items]

    def get_run(self, run_id: str) -> Run:
        """Get a single run by ID."""
        result = self._get(f"/api/v2/runs/{run_id}")
        return Run.from_dict(result)

    def cancel_run(self, run_id: str) -> Run:
        """Cancel a running execution."""
        result = self._post(f"/api/v2/runs/{run_id}/cancel")
        return Run.from_dict(result)

    def replay_run(self, run_id: str) -> Run:
        """Replay a previous run."""
        result = self._post(f"/api/v2/runs/{run_id}/replay")
        return Run.from_dict(result)

    def get_run_timeline(self, run_id: str) -> List[RunEvent]:
        """Get the event timeline for a run."""
        result = self._get(f"/api/v2/runs/{run_id}/timeline")
        if not result:
            return []
        items = result if isinstance(result, list) else result.get("events", [])
        return [RunEvent.from_dict(e) for e in items]

    # -- API keys ------------------------------------------------------------

    def list_api_keys(self) -> List[ApiKey]:
        """List all API keys (tokens are redacted)."""
        result = self._get("/api/v2/api-keys")
        if not result:
            return []
        items = result if isinstance(result, list) else result.get("keys", [])
        return [ApiKey.from_dict(k) for k in items]

    def create_api_key(
        self, name: str, role: str = "viewer"
    ) -> Dict[str, Any]:
        """Create a new API key. Returns dict including the raw token."""
        result = self._post("/api/v2/api-keys", data={"name": name, "role": role})
        return result or {}

    def rotate_api_key(
        self, identifier: str, grace_period_hours: int = 24
    ) -> Dict[str, Any]:
        """Rotate an API key with an optional grace period."""
        result = self._post(
            f"/api/v2/api-keys/{identifier}/rotate",
            data={"grace_period_hours": grace_period_hours},
        )
        return result or {}

    # -- audit ---------------------------------------------------------------

    def query_audit(
        self,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        action: Optional[str] = None,
        limit: int = 100,
    ) -> List[AuditEntry]:
        """Query the audit log."""
        params: Dict[str, Any] = {"limit": limit}
        if start_date is not None:
            params["start_date"] = start_date
        if end_date is not None:
            params["end_date"] = end_date
        if action is not None:
            params["action"] = action
        result = self._get("/api/v2/audit", params=params)
        if not result:
            return []
        items = result if isinstance(result, list) else result.get("entries", [])
        return [AuditEntry.from_dict(e) for e in items]
