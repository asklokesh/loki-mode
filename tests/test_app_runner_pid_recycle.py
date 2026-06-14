"""
tests/test_app_runner_pid_recycle.py

PID-reuse false positive (bug-hunter LOW-MED). dashboard.server._pid_is_alive
probes only os.kill(pid, 0), so after an app dies and the OS recycles its
numeric pid for an unrelated process, a dead run reports "running" forever and
the v7.41.1 liveness reconcile never fires.

The fix compares the live pid's real process start time against the recorded
reference time (state.json `started_at`). A genuine process started at or
before the reference; a live pid whose start time is comfortably AFTER the
reference cannot be the original, so it is treated as a recycled (dead) pid.

These tests mock the start-time lookup (_pid_start_time) and force the pid to
appear alive (_pid_is_alive -> True). They never touch a real process or port.
The key regression guarded here is the FALSE POSITIVE: a live app must never be
downgraded just because its pid is alive.
"""

import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from dashboard import server  # noqa: E402


# A reference time well in the past so margin arithmetic is unambiguous.
# started_at is UTC (Z-suffixed), matching what app-runner.sh writes.
_REFERENCE = "2026-06-14T12:00:00Z"
# Epoch of _REFERENCE, used to build start times relative to it.
_REFERENCE_EPOCH = server._state_reference_epoch({"started_at": _REFERENCE})


def _base_state():
    return {
        "status": "running",
        "main_pid": 4242,
        "started_at": _REFERENCE,
    }


def _patch_start_time(monkeypatch, epoch):
    monkeypatch.setattr(server, "_pid_is_alive", lambda pid: True)
    monkeypatch.setattr(server, "_pid_start_time", lambda pid: epoch)


def test_recycled_pid_started_after_reference_is_treated_as_dead(monkeypatch):
    # Live pid started well AFTER the recorded reference -> recycled -> stopped.
    started_after = _REFERENCE_EPOCH + server._APP_RUNNER_PID_RECYCLE_MARGIN_SECONDS + 60
    _patch_start_time(monkeypatch, started_after)

    out = server._reconcile_app_runner_liveness(_base_state())

    assert out["status"] == "stopped"
    assert out["liveness"] == "pid_recycled"


def test_genuine_pid_started_before_reference_stays_running(monkeypatch):
    # The regression guard: a live pid that started BEFORE the recorded
    # reference is the real app and must NOT be downgraded.
    started_before = _REFERENCE_EPOCH - 30
    _patch_start_time(monkeypatch, started_before)

    out = server._reconcile_app_runner_liveness(_base_state())

    assert out["status"] == "running"
    assert "liveness" not in out


def test_within_margin_is_not_downgraded(monkeypatch):
    # A small positive gap (clock skew / launch-to-write lag) is inside the
    # safety margin and must NOT trip the recycle downgrade.
    started_within_margin = _REFERENCE_EPOCH + (server._APP_RUNNER_PID_RECYCLE_MARGIN_SECONDS - 10)
    _patch_start_time(monkeypatch, started_within_margin)

    out = server._reconcile_app_runner_liveness(_base_state())

    assert out["status"] == "running"
    assert "liveness" not in out


def test_unavailable_start_time_falls_back_to_running(monkeypatch):
    # If the start time cannot be read, degrade gracefully: keep prior behavior
    # (a live pid stays running) rather than guessing.
    _patch_start_time(monkeypatch, None)

    out = server._reconcile_app_runner_liveness(_base_state())

    assert out["status"] == "running"
    assert "liveness" not in out


def test_missing_started_at_falls_back_to_running(monkeypatch):
    # No recorded reference -> cannot judge identity -> keep prior behavior.
    monkeypatch.setattr(server, "_pid_is_alive", lambda pid: True)
    # Even if a start time were available, absence of the reference must win.
    monkeypatch.setattr(server, "_pid_start_time", lambda pid: _REFERENCE_EPOCH + 100000)

    state = {"status": "running", "main_pid": 4242}
    out = server._reconcile_app_runner_liveness(state)

    assert out["status"] == "running"
    assert "liveness" not in out


def test_pid_genuinely_gone_still_reports_stopped(monkeypatch):
    # Existing behavior must be preserved: a pid that os.kill says is gone is
    # reported stopped via pid_gone, independent of the new recycle path.
    monkeypatch.setattr(server, "_pid_is_alive", lambda pid: False)
    out = server._reconcile_app_runner_liveness(_base_state())

    assert out["status"] == "stopped"
    assert out["liveness"] == "pid_gone"


def test_pid_is_recycled_helper_directly(monkeypatch):
    # Unit-level check of the identity comparison helper.
    monkeypatch.setattr(server, "_pid_start_time", lambda pid: _REFERENCE_EPOCH + 10000)
    assert server._pid_is_recycled(_base_state()) is True

    monkeypatch.setattr(server, "_pid_start_time", lambda pid: _REFERENCE_EPOCH - 10)
    assert server._pid_is_recycled(_base_state()) is False

    monkeypatch.setattr(server, "_pid_start_time", lambda pid: None)
    assert server._pid_is_recycled(_base_state()) is False


def test_pid_start_time_parses_real_self(monkeypatch):
    # End-to-end sanity: the real lstart parser returns a plausible epoch for
    # the current process (started in the past, within the last day).
    import time

    epoch = server._pid_start_time(os.getpid())
    assert epoch is not None
    now = time.time()
    assert epoch <= now + 5  # not in the future (allow small skew)
    assert epoch > now - 86400  # started within the last day (test process)
