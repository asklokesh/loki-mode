"""
tests/test_compose_primary_service_port.py

B2: docker-compose discovery must pick the PRIMARY web service and its HTTP port
correctly for multi-service / multi-port stacks (e.g. Spring Boot + Postgres),
and must NEVER fabricate a URL for a stopped (exited) container.

Covered behaviors (dashboard.server):
  - _pick_web_port: a service publishing several host ports surfaces the HTTP
    one (8080 over a non-common 8081 management port), and falls back to the
    first port only when none is a recognized web port.
  - _identify_compose_web_service: name-based selection still works when the web
    service is NOT the first service listed; the chosen service's HTTP-most port
    is returned (not its arbitrary first-listed port).
  - _discover_compose_app_runner_state_uncached: end-to-end with mocked
    `docker compose ps` / `docker compose config` JSON -> correct primary
    service + port for a Spring+db stack; and None (no URL) when the web
    container is exited, exercising the _container_health_state stopped guard.

All docker access is mocked via monkeypatching server._run_docker_json; no real
docker, process, or port is ever touched. The non-vacuity guard below proves the
selection helper actually changed behavior: a deliberately mis-ordered
multi-port service would return the wrong (management) port under the old
ports[0] logic, and these assertions fail if _pick_web_port is removed.
"""

import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from dashboard import server  # noqa: E402


# --------------------------------------------------------------------------- #
# _pick_web_port: HTTP port selection out of a multi-port service
# --------------------------------------------------------------------------- #

def test_pick_web_port_prefers_common_over_management():
    # Spring Boot: 8080 (HTTP) + 8081 (actuator/management). 8081 is listed
    # first to model an arbitrary Publishers order; 8080 must still win because
    # it is a recognized common web port.
    assert server._pick_web_port(["8081", "8080"]) == "8080"


def test_pick_web_port_falls_back_to_first_when_no_common():
    # No recognized web port -> keep prior behavior (first published port).
    assert server._pick_web_port(["9999", "7000"]) == "9999"


def test_pick_web_port_empty_is_none():
    assert server._pick_web_port([]) is None


def test_pick_web_port_respects_precedence_order():
    # 3000 precedes 8080 in _COMPOSE_COMMON_WEB_PORTS, so when both are present
    # the higher-precedence one is chosen regardless of list order.
    assert server._pick_web_port(["8080", "3000"]) == "3000"


# --------------------------------------------------------------------------- #
# _identify_compose_web_service: primary selection in a multi-service stack
# --------------------------------------------------------------------------- #

def test_identify_picks_named_web_not_first_listed_with_http_port():
    # db is listed first; the web service publishes BOTH 8080 and a non-common
    # 8081 (management). The name rule (2) must pick "web", and _pick_web_port
    # must surface 8080, not the first-listed 8081.
    config_services = {
        "db": {"image": "postgres:16"},
        "web": {"image": "spring-app"},
    }
    running_by_service = {
        "db": ["5432"],
        "web": ["8081", "8080"],
    }
    name, port = server._identify_compose_web_service(
        config_services, running_by_service
    )
    assert name == "web"
    assert port == "8080"


def test_identify_label_primary_picks_http_port():
    # loki.primary=true on a service that exposes management+http ports.
    config_services = {
        "api": {"labels": {"loki.primary": "true"}},
        "cache": {"image": "redis"},
    }
    running_by_service = {
        "api": ["8081", "8080"],
        "cache": ["6379"],
    }
    name, port = server._identify_compose_web_service(
        config_services, running_by_service
    )
    assert name == "api"
    assert port == "8080"


def test_identify_common_port_rule_when_unnamed():
    # No primary label, no web/app name: rule (3) picks the service publishing a
    # common web port (8000) over the db (5432), even though db is first.
    config_services = {
        "database": {"image": "postgres"},
        "backend": {"image": "uvicorn-app"},
    }
    running_by_service = {
        "database": ["5432"],
        "backend": ["8000"],
    }
    name, port = server._identify_compose_web_service(
        config_services, running_by_service
    )
    assert name == "backend"
    assert port == "8000"


# --------------------------------------------------------------------------- #
# End-to-end discovery with mocked docker, in a tmp project dir
# --------------------------------------------------------------------------- #

def _install_docker_mock(monkeypatch, ps_rows, config_rows):
    """Patch server._run_docker_json to return canned rows by subcommand."""
    def fake(args, cwd=None):
        if "ps" in args:
            return ps_rows
        if "config" in args:
            return config_rows
        return None
    monkeypatch.setattr(server, "_run_docker_json", fake)


def _write_compose(tmp_path):
    (tmp_path / "docker-compose.yml").write_text("services: {}\n")
    return tmp_path


def test_discover_spring_db_stack_surfaces_web_http_url(tmp_path, monkeypatch):
    project_dir = _write_compose(tmp_path)
    # db first, running but only DB port; web second, running, 8080(http)+8081.
    ps_rows = [
        {"Service": "db", "State": "running", "Health": "",
         "Project": "demo",
         "Publishers": [{"PublishedPort": 5432, "Protocol": "tcp"}]},
        {"Service": "web", "State": "running", "Health": "healthy",
         "Project": "demo",
         "Publishers": [
             {"PublishedPort": 8081, "Protocol": "tcp"},
             {"PublishedPort": 8080, "Protocol": "tcp"},
         ]},
    ]
    config_rows = [{"services": {"db": {}, "web": {}}}]
    _install_docker_mock(monkeypatch, ps_rows, config_rows)

    out = server._discover_compose_app_runner_state_uncached(project_dir)

    assert out is not None
    assert out["primary_service"] == "web"
    assert out["port"] == 8080
    assert out["url"] == "http://localhost:8080"
    assert out["status"] == "running"
    assert out["source"] == "discovered"


def test_discover_returns_none_for_stopped_web_service(tmp_path, monkeypatch):
    project_dir = _write_compose(tmp_path)
    # The web container is EXITED but still reports a Publisher port (compose ps
    # can list the mapping of a stopped container). _container_health_state must
    # gate this to None so NO URL is fabricated for a non-running container.
    ps_rows = [
        {"Service": "web", "State": "exited", "Health": "",
         "Project": "demo",
         "Publishers": [{"PublishedPort": 8080, "Protocol": "tcp"}]},
    ]
    config_rows = [{"services": {"web": {}}}]
    _install_docker_mock(monkeypatch, ps_rows, config_rows)

    out = server._discover_compose_app_runner_state_uncached(project_dir)

    assert out is None


def test_discover_no_compose_file_returns_none(tmp_path, monkeypatch):
    # Sanity: without a compose file, discovery does not apply (single-process).
    _install_docker_mock(monkeypatch, [], [])
    out = server._discover_compose_app_runner_state_uncached(tmp_path)
    assert out is None


if __name__ == "__main__":
    # Allow `python3 tests/test_compose_primary_service_port.py` without pytest
    # by running a minimal subset that needs no monkeypatch fixture.
    assert server._pick_web_port(["8081", "8080"]) == "8080"
    assert server._pick_web_port(["9999", "7000"]) == "9999"
    print(json.dumps({"smoke": "pass"}))
