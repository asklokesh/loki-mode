"""
tests/test_dashboard_autostop_after_stop.py

M4 (v7.90.1): after the dashboard's own Stop button stops a run, the dashboard
server should not linger when no OTHER loki run is still active -- BUT only when
it is safe to shut down.

The reported bug: clicking Stop for a project stopped the RUN correctly, yet the
dashboard SERVER kept running even though no other run was active. The per-project
Stop endpoint stopped only the run; it never tore the dashboard down, relying on
the orchestrator's cleanup trap (which a SIGKILL of the orchestrator or a uvicorn
graceful-shutdown deadlock can bypass).

The fix adds a conservative decision in the endpoint
(server._dashboard_teardown_after_project_stop), backed by:
  - server._other_runs_alive(exclude_path): CLEAR/KEEP over the registry, pruned
    of dead pids (mirrors run.sh / cmd_stop).
  - server._DASHBOARD_AUTOSTARTED: true only when run.sh auto-started the
    dashboard (LOKI_DASHBOARD_AUTOSTARTED=1), false for `loki dashboard start`.

Decision matrix:
  - another run alive               -> KEEP   ("dashboard": "kept"), no self-kill
  - no other run + auto-started     -> STOP   ("dashboard": "stopping"), schedules
                                       a graceful self-shutdown
  - no other run + user-started     -> IDLE   ("dashboard": "idle") + honest notice,
                                       NEVER self-kills

All tests are hermetic: the registry listing, pid-liveness, and the self-shutdown
scheduler are monkeypatched. NO real process is started, signaled, or killed.
"""

import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import pytest  # noqa: E402

from dashboard import server  # noqa: E402
from dashboard import registry  # noqa: E402


@pytest.fixture
def no_real_shutdown(monkeypatch):
    """Replace the self-shutdown scheduler with a recorder so a passing test can
    never send SIGTERM to the pytest process itself."""
    calls = {"n": 0}

    def _record(*args, **kwargs):
        calls["n"] += 1

    monkeypatch.setattr(server, "_self_shutdown_after_response", _record)
    return calls


def _set_projects(monkeypatch, projects):
    monkeypatch.setattr(registry, "list_projects", lambda *a, **k: list(projects))


def _all_pids_alive(monkeypatch):
    # Treat every probed pid as alive (so a recorded pid > 0 counts as a live run).
    monkeypatch.setattr(server, "_pid_is_gone", lambda pid: False)


def _all_pids_dead(monkeypatch):
    monkeypatch.setattr(server, "_pid_is_gone", lambda pid: True)


# ---------------------------------------------------------------------------
# _other_runs_alive
# ---------------------------------------------------------------------------

def test_other_runs_alive_false_when_only_self(monkeypatch):
    # Only the just-stopped project remains, already marked stopped (pid None).
    _set_projects(monkeypatch, [{"path": "/p/anonima", "pid": None}])
    _all_pids_alive(monkeypatch)
    assert server._other_runs_alive(exclude_path="/p/anonima") is False


def test_other_runs_alive_true_when_another_running(monkeypatch):
    _set_projects(monkeypatch, [
        {"path": "/p/anonima", "pid": None},      # just stopped
        {"path": "/p/other", "pid": 4242},        # still running
    ])
    _all_pids_alive(monkeypatch)
    assert server._other_runs_alive(exclude_path="/p/anonima") is True


def test_other_runs_alive_ignores_dead_pids(monkeypatch):
    # Another project has a recorded pid, but it is actually dead -> CLEAR.
    _set_projects(monkeypatch, [
        {"path": "/p/anonima", "pid": None},
        {"path": "/p/other", "pid": 5555},
    ])
    _all_pids_dead(monkeypatch)
    assert server._other_runs_alive(exclude_path="/p/anonima") is False


def test_other_runs_alive_excludes_self_even_if_pid_lingers(monkeypatch):
    # Belt-and-suspenders: even if the just-stopped project still has a live pid
    # recorded (mark_project_stopped not yet flushed), exclude_path drops it.
    _set_projects(monkeypatch, [{"path": "/p/anonima", "pid": 9999}])
    _all_pids_alive(monkeypatch)
    assert server._other_runs_alive(exclude_path="/p/anonima") is False


def test_other_runs_alive_keeps_on_registry_error(monkeypatch):
    # Any registry failure must degrade to KEEP (True), never to a teardown.
    def boom(*a, **k):
        raise RuntimeError("registry exploded")
    monkeypatch.setattr(registry, "list_projects", boom)
    assert server._other_runs_alive(exclude_path="/p/anonima") is True


# ---------------------------------------------------------------------------
# _dashboard_teardown_after_project_stop decision matrix
# ---------------------------------------------------------------------------

def test_keep_when_another_run_alive_autostarted(monkeypatch, no_real_shutdown):
    # Even an auto-started dashboard must stay up while another run is active.
    monkeypatch.setattr(server, "_DASHBOARD_AUTOSTARTED", True)
    _set_projects(monkeypatch, [
        {"path": "/p/anonima", "pid": None},
        {"path": "/p/other", "pid": 4242},
    ])
    _all_pids_alive(monkeypatch)

    resp = server._dashboard_teardown_after_project_stop("/p/anonima")
    assert resp["dashboard"] == "kept"
    assert no_real_shutdown["n"] == 0  # no self-shutdown scheduled


def test_stopping_when_clear_and_autostarted(monkeypatch, no_real_shutdown):
    monkeypatch.setattr(server, "_DASHBOARD_AUTOSTARTED", True)
    _set_projects(monkeypatch, [{"path": "/p/anonima", "pid": None}])
    _all_pids_alive(monkeypatch)

    resp = server._dashboard_teardown_after_project_stop("/p/anonima")
    assert resp["dashboard"] == "stopping"
    assert resp["dashboard_autostarted"] is True
    assert no_real_shutdown["n"] == 1  # self-shutdown scheduled exactly once


def test_idle_notice_when_clear_but_user_started(monkeypatch, no_real_shutdown):
    # The decisive safety case: a user-started dashboard must NEVER self-kill,
    # even when no run is left -- it returns a non-destructive notice instead.
    monkeypatch.setattr(server, "_DASHBOARD_AUTOSTARTED", False)
    _set_projects(monkeypatch, [{"path": "/p/anonima", "pid": None}])
    _all_pids_alive(monkeypatch)

    resp = server._dashboard_teardown_after_project_stop("/p/anonima")
    assert resp["dashboard"] == "idle"
    assert resp["dashboard_autostarted"] is False
    assert "loki dashboard stop" in resp["notice"]
    assert no_real_shutdown["n"] == 0  # never self-kills a user-started dashboard


def test_keep_on_decision_error_never_kills(monkeypatch, no_real_shutdown):
    # If the CLEAR/KEEP probe raises, the decision degrades to KEEP and never
    # schedules a self-shutdown.
    monkeypatch.setattr(server, "_DASHBOARD_AUTOSTARTED", True)

    def boom(*a, **k):
        raise RuntimeError("probe failed")
    monkeypatch.setattr(server, "_other_runs_alive", boom)

    resp = server._dashboard_teardown_after_project_stop("/p/anonima")
    assert resp["dashboard"] == "kept"
    assert no_real_shutdown["n"] == 0


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
