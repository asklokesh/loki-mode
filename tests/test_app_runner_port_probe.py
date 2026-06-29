"""
tests/test_app_runner_port_probe.py

Single-process app-runner port probe (BUG 2 fix). A SKILL/CLI-built project
(e.g. one started with `npm run dev` outside app-runner.sh, whose orchestrator
has since exited) leaves a state.json with status "stopped" and main_pid 0 even
while the app itself is still serving. The dashboard then reports "not running"
for a live app.

dashboard.server._discover_single_process_app_runner_state probes the RECORDED
port (state.json.port, falling back to a non-docker detection.json) and only
reports "running" when the port genuinely answers, never fabricating a result.

These tests stub the actual TCP probe (_port_is_serving) and the recorded-port
lookup so they never touch a real socket. They guard:
  - true positive: recorded port + genuinely serving -> running with that url
  - true negative: recorded port + not serving -> None (honest stopped kept)
  - honesty guard: the dashboard's own port is never treated as the app's port
  - honesty guard: a docker-compose detection.json never feeds this probe
  - no recorded port -> an honest "unknown", never a false "running"/"stopped"
"""

import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from dashboard import server  # noqa: E402


def test_recorded_port_serving_reports_running(monkeypatch):
    monkeypatch.setattr(server, "_port_is_serving", lambda port: port == 3000)
    state = {"status": "stopped", "port": 3000, "url": "http://localhost:3000",
             "method": "npm run dev"}
    out = server._discover_single_process_app_runner_state(state)
    assert out is not None
    assert out["status"] == "running"
    assert out["port"] == 3000
    assert out["url"] == "http://localhost:3000"
    assert out["source"] == "probe"
    assert out["externally_managed"] is True


def test_recorded_port_not_serving_returns_none(monkeypatch):
    # Nothing answers on the recorded port -> do not claim running; caller keeps
    # the honest reconciled (stopped/stale) state.
    monkeypatch.setattr(server, "_port_is_serving", lambda port: False)
    state = {"status": "stopped", "port": 3000, "url": "http://localhost:3000"}
    out = server._discover_single_process_app_runner_state(state)
    assert out is None


def test_url_synthesized_when_missing(monkeypatch):
    monkeypatch.setattr(server, "_port_is_serving", lambda port: True)
    state = {"status": "stopped", "port": 8080}
    out = server._discover_single_process_app_runner_state(state)
    assert out is not None
    assert out["url"] == "http://localhost:8080"


def test_no_recorded_port_returns_none(monkeypatch):
    # state has port 0 and no detection.json port -> we cannot probe, so we
    # return None and the caller keeps the honest reconciled (stopped) state.
    # We never fabricate a status, and never probe when no port is recorded.
    monkeypatch.setattr(server, "_recorded_app_port", lambda state: None)
    def _boom(_p):
        raise AssertionError("must not probe when no port is recorded")
    monkeypatch.setattr(server, "_port_is_serving", _boom)
    out = server._discover_single_process_app_runner_state({"status": "stopped"})
    assert out is None


def test_dashboard_self_port_is_never_the_app_port(monkeypatch):
    # A stale recorded port equal to the dashboard's own port must be rejected,
    # otherwise the probe self-hits the dashboard and misreports it as the app.
    monkeypatch.setattr(server, "_dashboard_self_port", lambda: 57374)
    assert server._recorded_app_port({"port": 57374}) is None


def test_docker_detection_port_is_ignored(monkeypatch, tmp_path):
    # A docker-compose detection.json belongs to the compose-discovery path, not
    # the single-process probe; its port must not be used here.
    monkeypatch.setattr(server, "_dashboard_self_port", lambda: 57374)
    loki_dir = tmp_path / ".loki"
    (loki_dir / "app-runner").mkdir(parents=True)
    (loki_dir / "app-runner" / "detection.json").write_text(
        '{"port": 3000, "is_docker": true, "type": "docker-compose"}'
    )
    monkeypatch.setattr(server, "_get_loki_dir", lambda: loki_dir)
    # state has no usable port -> would fall back to detection.json, which is
    # docker and must therefore be skipped, yielding None.
    assert server._recorded_app_port({"status": "stopped", "port": 0}) is None


def test_non_docker_detection_port_is_used(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "_dashboard_self_port", lambda: 57374)
    loki_dir = tmp_path / ".loki"
    (loki_dir / "app-runner").mkdir(parents=True)
    (loki_dir / "app-runner" / "detection.json").write_text(
        '{"port": 3000, "is_docker": false, "type": "npm-dev"}'
    )
    monkeypatch.setattr(server, "_get_loki_dir", lambda: loki_dir)
    assert server._recorded_app_port({"status": "stopped", "port": 0}) == 3000
