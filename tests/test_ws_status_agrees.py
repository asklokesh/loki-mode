"""tests/test_ws_status_agrees.py -- the live status surfaces must not contradict.

THE DEFECT (measured on a preserved real run, 2026-07-29)
    The WebSocket status_update stream derived its status from
    dashboard-state.json's "mode" field. That value is written by the engine and
    goes STALE the moment a run pauses: on a genuinely paused run it still read
    "autonomous", so the stream reported "running" while /api/status -- which
    reads .loki/PAUSE -- reported "paused" for the SAME run.

    Two live surfaces disagreeing about whether a build is running is worse than
    either being wrong on its own, because the user cannot tell which to believe.

THE RULE
    Control files (.loki/STOP, .loki/PAUSE) are the AUTHORITY and are consulted
    FIRST. The engine-written "mode" field is a fallback for the case where no
    control file exists.

These tests exercise the derivation directly rather than standing up a server:
the defect is in the precedence order, and that is what is asserted.
"""

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


def ws_status(loki_dir: Path, pid_alive: bool) -> str:
    """Mirror of the WebSocket derivation in dashboard/server.py.

    Kept in lockstep with the source block; test_source_precedence below asserts
    the real file still checks control files before the stale mode field, so a
    regression in server.py cannot pass merely because this mirror is correct.
    """
    raw = {}
    sf = loki_dir / "dashboard-state.json"
    if sf.exists():
        try:
            raw = json.loads(sf.read_text())
        except (json.JSONDecodeError, OSError):
            raw = {}
    status = raw.get("mode", "autonomous")
    if (loki_dir / "STOP").exists():
        return "stopped"
    if (loki_dir / "PAUSE").exists():
        return "paused"
    if not pid_alive:
        return "stopped"
    if status == "paused":
        return "paused"
    if status in ("stopped", ""):
        return "stopped"
    return "running"


def api_status(loki_dir: Path) -> str:
    """What /api/status reports: it reads the control files."""
    if (loki_dir / "STOP").exists():
        return "stopped"
    if (loki_dir / "PAUSE").exists():
        return "paused"
    return "running"


class WsStatusAgreesTests(unittest.TestCase):
    def _mk(self, mode="autonomous", pause=False, stop=False):
        self._tmp = TemporaryDirectory()
        d = Path(self._tmp.name) / ".loki"
        d.mkdir(parents=True)
        (d / "dashboard-state.json").write_text(json.dumps({"mode": mode}))
        if pause:
            (d / "PAUSE").touch()
        if stop:
            (d / "STOP").touch()
        return d

    def test_paused_run_with_stale_mode_reports_paused(self):
        """The exact defect: mode says 'autonomous', PAUSE exists."""
        d = self._mk(mode="autonomous", pause=True)
        self.assertEqual(ws_status(d, pid_alive=True), "paused")
        self.assertEqual(ws_status(d, pid_alive=True), api_status(d),
                         "WebSocket and /api/status disagree on a paused run")

    def test_stop_file_wins_over_everything(self):
        d = self._mk(mode="autonomous", stop=True)
        self.assertEqual(ws_status(d, pid_alive=True), "stopped")
        self.assertEqual(ws_status(d, pid_alive=True), api_status(d))

    def test_running_run_still_reports_running(self):
        """No control file: a live run must not be reported as stopped."""
        d = self._mk(mode="autonomous")
        self.assertEqual(ws_status(d, pid_alive=True), "running")
        self.assertEqual(ws_status(d, pid_alive=True), api_status(d))

    def test_dead_pid_with_no_control_file_is_stopped(self):
        """The pre-existing liveness check must survive the precedence change."""
        d = self._mk(mode="autonomous")
        self.assertEqual(ws_status(d, pid_alive=False), "stopped")

    def test_missing_state_file_does_not_crash(self):
        self._tmp = TemporaryDirectory()
        d = Path(self._tmp.name) / ".loki"
        d.mkdir(parents=True)
        self.assertEqual(ws_status(d, pid_alive=True), "running")

    def test_corrupt_state_file_does_not_crash(self):
        d = self._mk()
        (d / "dashboard-state.json").write_text("{not json")
        self.assertEqual(ws_status(d, pid_alive=True), "running")
        (d / "PAUSE").touch()
        self.assertEqual(ws_status(d, pid_alive=True), "paused")

    def test_source_precedence(self):
        """server.py must check control files BEFORE the stale mode field.

        Guards against the mirror above drifting from the real implementation:
        a fix reverted in server.py would otherwise leave these tests green.
        """
        src = (Path(__file__).parent.parent / "dashboard" / "server.py").read_text()
        marker = 'status_str = raw.get("mode", "autonomous")'
        self.assertIn(marker, src, "WebSocket status derivation moved or renamed")
        after = src.split(marker, 1)[1][:1600]
        self.assertIn('"PAUSE"', after,
                      "WebSocket derivation no longer consults .loki/PAUSE")
        pause_at = after.index('"PAUSE"')
        alive_at = after.find("_pid_alive")
        self.assertTrue(0 <= pause_at < alive_at or alive_at == -1,
                        "PAUSE must be checked before falling back to liveness/mode")


if __name__ == "__main__":
    unittest.main()
