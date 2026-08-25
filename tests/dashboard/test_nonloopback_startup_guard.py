"""Characterization tests for the dashboard bind-time trust boundary."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from dashboard.bind_policy import (
    has_remote_authentication,
    is_loopback_bind,
    require_safe_dashboard_bind,
)


REPO_ROOT = Path(__file__).resolve().parents[2]


def _uvicorn_sentinel():
    calls = []

    def run(*args, **kwargs):
        calls.append((args, kwargs))

    return SimpleNamespace(run=run), calls


def _runtime_enterprise_auth_enabled(value):
    env = dict(os.environ)
    env.pop("LOKI_OIDC_ISSUER", None)
    env.pop("LOKI_OIDC_CLIENT_ID", None)
    if value is None:
        env.pop("LOKI_ENTERPRISE_AUTH", None)
    else:
        env["LOKI_ENTERPRISE_AUTH"] = value
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "from dashboard import auth; "
            "print('1' if auth.ENTERPRISE_AUTH_ENABLED else '0')",
        ],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout.strip() == "1"


@pytest.mark.parametrize(
    "host",
    ("127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "localhost"),
)
def test_loopback_bind_table_allows_anonymous_first_run(host):
    assert is_loopback_bind(host)
    require_safe_dashboard_bind(host, {})


@pytest.mark.parametrize(
    "host",
    (None, "", "0.0.0.0", "::", "192.0.2.10", "2001:db8::1", "dashboard.internal"),
)
def test_nonloopback_unknown_and_empty_bind_table_fails_closed(host):
    assert not is_loopback_bind(host)
    with pytest.raises(RuntimeError, match="non-loopback"):
        require_safe_dashboard_bind(host, {})


@pytest.mark.parametrize("value", ("true", "TRUE", "1", "yes"))
def test_enterprise_token_auth_permits_nonloopback(value):
    require_safe_dashboard_bind("0.0.0.0", {"LOKI_ENTERPRISE_AUTH": value})


@pytest.mark.parametrize(
    "value",
    (
        None,
        "",
        "true",
        "TRUE",
        "TrUe",
        "1",
        "yes",
        "YES",
        " true ",
        "1 ",
        " yes",
        "on",
        "false",
    ),
)
def test_enterprise_flag_matches_runtime_auth_semantics(value):
    env = {} if value is None else {"LOKI_ENTERPRISE_AUTH": value}
    policy_enabled = has_remote_authentication(
        env,
        oidc_verifier_available=False,
    )
    assert policy_enabled is _runtime_enterprise_auth_enabled(value)


def test_padded_true_refuses_before_uvicorn_when_runtime_auth_is_false():
    body = """
import sys
from types import SimpleNamespace
from dashboard import auth, run
assert auth.ENTERPRISE_AUTH_ENABLED is False
calls = []
sys.modules["uvicorn"] = SimpleNamespace(
    run=lambda *args, **kwargs: calls.append((args, kwargs)))
sys.argv = ["dashboard.run", "--host", "0.0.0.0"]
try:
    run.main()
except RuntimeError as exc:
    assert "non-loopback" in str(exc)
else:
    raise AssertionError("padded true allowed a non-loopback listener")
assert calls == [], "uvicorn was called before padded true was refused"
print("OK")
"""
    env = dict(os.environ)
    env["LOKI_ENTERPRISE_AUTH"] = " true "
    env.pop("LOKI_OIDC_ISSUER", None)
    env.pop("LOKI_OIDC_CLIENT_ID", None)
    proc = subprocess.run(
        [sys.executable, "-c", body],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout.strip() == "OK"


def test_fully_configured_verified_oidc_permits_nonloopback():
    env = {
        "LOKI_OIDC_ISSUER": "https://identity.example",
        "LOKI_OIDC_CLIENT_ID": "dashboard",
    }
    assert has_remote_authentication(env, oidc_verifier_available=True)
    require_safe_dashboard_bind(
        "dashboard.internal",
        env,
        oidc_verifier_available=True,
    )


@pytest.mark.parametrize(
    "env,verifier_available",
    (
        ({"LOKI_OIDC_ISSUER": "https://identity.example"}, True),
        ({"LOKI_OIDC_CLIENT_ID": "dashboard"}, True),
        (
            {
                "LOKI_OIDC_ISSUER": "https://identity.example",
                "LOKI_OIDC_CLIENT_ID": "dashboard",
            },
            False,
        ),
        (
            {
                "LOKI_OIDC_ISSUER": "https://identity.example",
                "LOKI_OIDC_CLIENT_ID": "dashboard",
                "LOKI_OIDC_SKIP_SIGNATURE_VERIFY": "true",
            },
            True,
        ),
    ),
)
def test_incomplete_unavailable_or_insecure_oidc_fails_closed(
    env, verifier_available
):
    assert not has_remote_authentication(
        env,
        oidc_verifier_available=verifier_available,
    )
    with pytest.raises(RuntimeError, match="signature-verifying OIDC"):
        require_safe_dashboard_bind(
            "0.0.0.0",
            env,
            oidc_verifier_available=verifier_available,
        )


def test_run_launcher_refuses_anonymous_wildcard_before_uvicorn(monkeypatch):
    from dashboard import run

    uvicorn, calls = _uvicorn_sentinel()
    monkeypatch.setitem(sys.modules, "uvicorn", uvicorn)
    monkeypatch.setattr(sys, "argv", ["dashboard.run", "--host", "0.0.0.0"])
    monkeypatch.delenv("LOKI_ENTERPRISE_AUTH", raising=False)
    monkeypatch.delenv("LOKI_OIDC_ISSUER", raising=False)
    monkeypatch.delenv("LOKI_OIDC_CLIENT_ID", raising=False)

    with pytest.raises(RuntimeError, match="non-loopback"):
        run.main()

    assert calls == []


def test_run_server_refuses_anonymous_routable_host_before_uvicorn(monkeypatch):
    from dashboard import server

    uvicorn, calls = _uvicorn_sentinel()
    monkeypatch.setitem(sys.modules, "uvicorn", uvicorn)
    monkeypatch.delenv("LOKI_ENTERPRISE_AUTH", raising=False)
    monkeypatch.delenv("LOKI_OIDC_ISSUER", raising=False)
    monkeypatch.delenv("LOKI_OIDC_CLIENT_ID", raising=False)

    with pytest.raises(RuntimeError, match="non-loopback"):
        server.run_server(host="192.0.2.10", port=57374)

    assert calls == []


def test_run_server_keeps_anonymous_loopback_first_run(monkeypatch):
    from dashboard import server

    uvicorn, calls = _uvicorn_sentinel()
    monkeypatch.setitem(sys.modules, "uvicorn", uvicorn)
    monkeypatch.delenv("LOKI_ENTERPRISE_AUTH", raising=False)
    monkeypatch.delenv("LOKI_OIDC_ISSUER", raising=False)
    monkeypatch.delenv("LOKI_OIDC_CLIENT_ID", raising=False)

    server.run_server(host="127.0.0.2", port=57374)

    assert len(calls) == 1
    assert calls[0][1]["host"] == "127.0.0.2"


def test_run_server_allows_nonloopback_with_enterprise_auth(monkeypatch):
    from dashboard import server

    uvicorn, calls = _uvicorn_sentinel()
    monkeypatch.setitem(sys.modules, "uvicorn", uvicorn)
    monkeypatch.setenv("LOKI_ENTERPRISE_AUTH", "true")

    server.run_server(host="0.0.0.0", port=57374)

    assert len(calls) == 1
    assert calls[0][1]["host"] == "0.0.0.0"


def test_server_lifespan_guards_raw_uvicorn_env_before_initialization(monkeypatch):
    from dashboard import server

    initialized = []

    async def init_db():
        initialized.append(True)

    async def enter_lifespan():
        async with server.lifespan(server.app):
            pass

    monkeypatch.setattr(server, "init_db", init_db)
    monkeypatch.setenv("LOKI_DASHBOARD_HOST", "0.0.0.0")
    monkeypatch.delenv("LOKI_ENTERPRISE_AUTH", raising=False)
    monkeypatch.delenv("LOKI_OIDC_ISSUER", raising=False)
    monkeypatch.delenv("LOKI_OIDC_CLIENT_ID", raising=False)

    with pytest.raises(RuntimeError, match="non-loopback"):
        asyncio.run(enter_lifespan())

    assert initialized == []


def test_control_startup_guards_raw_uvicorn_env(monkeypatch):
    from dashboard import control

    monkeypatch.setenv("LOKI_DASHBOARD_HOST", "dashboard.internal")
    monkeypatch.delenv("LOKI_ENTERPRISE_AUTH", raising=False)
    monkeypatch.delenv("LOKI_OIDC_ISSUER", raising=False)
    monkeypatch.delenv("LOKI_OIDC_CLIENT_ID", raising=False)

    with pytest.raises(RuntimeError, match="non-loopback"):
        asyncio.run(control._enforce_safe_bind_at_startup())


def test_container_and_helm_raw_uvicorn_paths_carry_bind_env_and_policy():
    dockerfile = (REPO_ROOT / "dashboard" / "Dockerfile").read_text()
    compose = (
        REPO_ROOT / "deploy" / "docker-compose" / "docker-compose.yml"
    ).read_text()
    helm_values = (
        REPO_ROOT / "deploy" / "helm" / "autonomi" / "values.yaml"
    ).read_text()
    helm_config = (
        REPO_ROOT
        / "deploy"
        / "helm"
        / "autonomi"
        / "templates"
        / "configmap.yaml"
    ).read_text()
    helm_deployment = (
        REPO_ROOT
        / "deploy"
        / "helm"
        / "autonomi"
        / "templates"
        / "deployment-controlplane.yaml"
    ).read_text()

    assert "bind_policy.py" in dockerfile
    assert "ENV LOKI_DASHBOARD_HOST=0.0.0.0" in dockerfile
    assert 'LOKI_DASHBOARD_HOST=0.0.0.0' in compose
    assert 'LOKI_ENTERPRISE_AUTH=${LOKI_ENTERPRISE_AUTH:-false}' in compose
    assert 'dashboardHost: "0.0.0.0"' in helm_values
    assert "LOKI_DASHBOARD_HOST:" in helm_config
    assert '"dashboard.server:app"' in helm_deployment

    with pytest.raises(RuntimeError, match="non-loopback"):
        require_safe_dashboard_bind("0.0.0.0", {})
