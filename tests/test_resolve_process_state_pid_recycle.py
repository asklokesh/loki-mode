"""
tests/test_resolve_process_state_pid_recycle.py

PID-reuse false positive in dashboard.server._resolve_process_state (bug B7).

_resolve_process_state backs /api/health/processes for agents.json entries and
the central pid registry. It probed liveness with a bare os.kill(pid, 0), which
only proves *some* process owns the numeric pid -- not that it is OUR process.
After our agent/run exits the OS can recycle its pid for an unrelated program,
and the bare probe would then report that stranger as our live run (RUNNING)
forever.

The fix cross-checks the live pid's real OS start time against the recorded
`started` reference: a genuine process was launched at or before we recorded
it, so a live pid whose start time is comfortably AFTER the reference is a
recycled pid belonging to an unrelated process and must be reported NOT alive
(CRASHED for a last_status of "running"). The downgrade fires only on positive
evidence; missing reference or unreadable start time preserves prior behavior.

These tests mock the start-time lookup and force os.kill to "succeed" so no real
process or port is touched, plus one end-to-end case that uses a genuinely live
unrelated pid (pid 1 / launchd|init) to prove a recycled-style pid is not
mistaken for our short-lived run.
"""

import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from dashboard import server  # noqa: E402


# A reference time well in the past so margin arithmetic is unambiguous. This is
# what agents.json / the pid registry record as the run's "started" time (UTC).
_REFERENCE = "2026-06-14T12:00:00Z"
_REFERENCE_EPOCH = server._state_reference_epoch({"started_at": _REFERENCE})
_MARGIN = server._APP_RUNNER_PID_RECYCLE_MARGIN_SECONDS


def _force_alive(monkeypatch):
    # Make the bare existence probe (os.kill(pid, 0)) succeed unconditionally so
    # the test exercises only the recycle/identity logic, not real processes.
    monkeypatch.setattr(server.os, "kill", lambda pid, sig: None)


def test_recycled_pid_started_after_reference_is_not_alive(monkeypatch):
    # The core regression: a live pid whose real start time is well AFTER the
    # recorded reference is a recycled pid for an unrelated process. It must be
    # reported NOT alive, and a last_status of "running" then resolves to
    # CRASHED rather than masquerading as RUNNING forever.
    _force_alive(monkeypatch)
    started_after = _REFERENCE_EPOCH + _MARGIN + 60
    monkeypatch.setattr(server, "_pid_start_time", lambda pid: started_after)

    out = server._resolve_process_state(
        4242, last_status="running", started=_REFERENCE)

    assert out["pid_alive"] is False
    assert out["state"] == "CRASHED"


def test_genuine_pid_started_before_reference_stays_running(monkeypatch):
    # Guard against false downgrades: a live pid that started AT OR BEFORE the
    # recorded reference is the real run and must stay RUNNING.
    _force_alive(monkeypatch)
    started_before = _REFERENCE_EPOCH - 30
    monkeypatch.setattr(server, "_pid_start_time", lambda pid: started_before)

    out = server._resolve_process_state(
        4242, last_status="running", started=_REFERENCE)

    assert out["pid_alive"] is True
    assert out["state"] == "RUNNING"


def test_within_margin_is_not_downgraded(monkeypatch):
    # A small positive gap (clock skew / launch-to-record lag) is inside the
    # safety margin and must NOT trip the recycle downgrade.
    _force_alive(monkeypatch)
    started_within = _REFERENCE_EPOCH + (_MARGIN - 10)
    monkeypatch.setattr(server, "_pid_start_time", lambda pid: started_within)

    out = server._resolve_process_state(
        4242, last_status="running", started=_REFERENCE)

    assert out["pid_alive"] is True
    assert out["state"] == "RUNNING"


def test_unavailable_start_time_keeps_prior_behavior(monkeypatch):
    # If the OS start time cannot be read, degrade gracefully: keep the prior
    # best-effort behavior (a live pid stays RUNNING) rather than guessing.
    _force_alive(monkeypatch)
    monkeypatch.setattr(server, "_pid_start_time", lambda pid: None)

    out = server._resolve_process_state(
        4242, last_status="running", started=_REFERENCE)

    assert out["pid_alive"] is True
    assert out["state"] == "RUNNING"


def test_no_started_reference_keeps_prior_behavior(monkeypatch):
    # Without a recorded reference we cannot judge identity, so the recycle
    # guard must not fire even when a (late) start time is available.
    _force_alive(monkeypatch)
    monkeypatch.setattr(
        server, "_pid_start_time", lambda pid: _REFERENCE_EPOCH + 100000)

    out = server._resolve_process_state(4242, last_status="running")

    assert out["pid_alive"] is True
    assert out["state"] == "RUNNING"


def test_genuinely_dead_pid_still_crashed(monkeypatch):
    # Existing behavior preserved: a pid os.kill says is gone resolves to
    # CRASHED (last_status running), independent of the recycle path.
    def _raise(pid, sig):
        raise ProcessLookupError()
    monkeypatch.setattr(server.os, "kill", _raise)

    out = server._resolve_process_state(
        4242, last_status="running", started=_REFERENCE)

    assert out["pid_alive"] is False
    assert out["state"] == "CRASHED"


def test_real_live_unrelated_pid_with_old_reference_is_not_our_run():
    # End-to-end, no mocks: pid 1 (launchd on macOS / init on Linux) is a real
    # live process that booted long before our fake reference. It stands in for
    # a recycled pid that now belongs to an unrelated long-lived process. With a
    # reference of "yesterday" the guard must report it NOT our live run.
    #
    # Skipped only if the platform's ps cannot report pid 1's start time; the
    # logic still degrades safely there, but this case asserts the positive
    # detection path on real OS data.
    from datetime import datetime, timedelta, timezone

    pid1_start = server._pid_start_time(1)
    if pid1_start is None:
        import pytest
        pytest.skip("ps lstart unavailable for pid 1 on this platform")

    # Reference = one minute ago, well after pid 1 (and well past the margin).
    recent = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
    out = server._resolve_process_state(1, last_status="running", started=recent)

    assert out["pid_alive"] is False
    assert out["state"] == "CRASHED"
