"""Host allowlist: probe exemption, non-loopback bind with auth, local default."""
import pytest
from fastapi.testclient import TestClient

from dashboard import server


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("LOKI_DASHBOARD_ALLOWED_HOSTS", raising=False)
    monkeypatch.delenv("LOKI_DASHBOARD_HOST", raising=False)
    monkeypatch.setattr(server, "_bind_host_override", None)
    monkeypatch.setattr(server.auth, "ENTERPRISE_AUTH_ENABLED", False)
    monkeypatch.setattr(server.auth, "OIDC_ENABLED", False)
    return TestClient(server.app)


def get(c, path, host):
    return c.get(path, headers={"Host": host}).status_code


def test_rebinding_host_refused_by_default(client):
    assert get(client, "/api/status", "evil.example") == 403


def test_probe_paths_exempt(client):
    assert get(client, "/health", "10.1.2.3:57374") != 403
    assert get(client, "/metrics", "10.1.2.3:57374") != 403


def test_non_loopback_bind_without_auth_needs_allowlist(client, monkeypatch):
    monkeypatch.setenv("LOKI_DASHBOARD_HOST", "0.0.0.0")
    assert get(client, "/api/status", "evil.example") == 403
    monkeypatch.setenv("LOKI_DASHBOARD_ALLOWED_HOSTS", "evil.example")
    assert get(client, "/api/status", "evil.example") != 403


def test_non_loopback_bind_with_auth_allows_any_host(client, monkeypatch):
    monkeypatch.setenv("LOKI_DASHBOARD_HOST", "0.0.0.0")
    monkeypatch.setattr(server.auth, "ENTERPRISE_AUTH_ENABLED", True)
    assert get(client, "/api/status", "anything.example") != 403


def test_loopback_bind_with_auth_still_refuses_foreign_host(client, monkeypatch):
    monkeypatch.setattr(server.auth, "ENTERPRISE_AUTH_ENABLED", True)
    assert get(client, "/api/status", "evil.example") == 403
