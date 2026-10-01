import pytest


@pytest.fixture(autouse=True)
def _allow_testclient_host(monkeypatch):
    # Starlette TestClient sends Host: testserver; the Host allowlist is explicit opt-in.
    monkeypatch.setenv("LOKI_DASHBOARD_ALLOWED_HOSTS", "testserver,test,dashboard.example")
