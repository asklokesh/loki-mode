"""A CLI-started build must not display as STOPPED while it is running.

Observed on a real user's build: `loki start <issue-url>` was actively working
-- STATUS.txt said BUILDING, iterations were advancing, the process was alive --
while the dashboard showed STOPPED, iteration --, 0 agents.

Cause: the liveness check had two sources, and a background CLI run writes
neither. There is no .loki/loki.pid for that path, and run.sh only UPDATES
.loki/session.json when it already exists (run.sh:23574) rather than creating
it. Both checks failed, so every such run fell through to "stopped".

The run does register itself in .loki/pids/<pid>.json. That is the third
source.

The property that must not regress while fixing it: a STALE registry entry from
a crashed run must still read as stopped. Liveness comes from os.kill(pid, 0),
never from the file existing -- that is the same anti-stale rule the existing
loki.pid check was written for.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path


def _registry_says_alive(loki_dir: Path) -> bool:
    """Mirror of the server's registry liveness probe."""
    try:
        for entry in (loki_dir / "pids").glob("*.json"):
            try:
                record = json.loads(entry.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if record.get("kind") not in ("wrapper", "runner"):
                continue
            try:
                os.kill(int(record.get("pid", 0)), 0)
            except (ValueError, OSError, ProcessLookupError):
                continue
            return True
    except OSError:
        pass
    return False


class CliRunLivenessTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.loki = Path(self._tmp.name)
        (self.loki / "pids").mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def _write(self, pid, kind="wrapper", label="loki-wrapper"):
        (self.loki / "pids" / f"{pid}.json").write_text(
            json.dumps({"pid": pid, "label": label, "kind": kind}),
            encoding="utf-8")

    def test_live_registered_process_reads_as_alive(self):
        """The bug: a running CLI build displayed as STOPPED."""
        self._write(os.getpid())
        self.assertTrue(
            _registry_says_alive(self.loki),
            "a live registered process must read as running; without this a "
            "healthy CLI build shows STOPPED on the dashboard")

    def test_stale_entry_does_not_read_as_alive(self):
        """The property. A crashed run must not look alive forever."""
        # A PID that cannot exist: max_pid is well below this on Linux/macOS.
        self._write(4_000_000)
        self.assertFalse(
            _registry_says_alive(self.loki),
            "a stale registry entry must not read as running")

    def test_empty_registry_reads_as_stopped(self):
        self.assertFalse(_registry_says_alive(self.loki))

    def test_unrelated_kinds_are_ignored(self):
        """Only the build process counts, not the dashboard or app-runner.

        .loki/pids/ registers several long-lived helpers. Counting those as
        build liveness would invert the bug: the dashboard would report a
        build as running because the dashboard itself is running.
        """
        self._write(os.getpid(), kind="dashboard", label="loki-dashboard")
        self.assertFalse(
            _registry_says_alive(self.loki),
            "a dashboard/app-runner PID must not count as build liveness")

    def test_malformed_entry_is_skipped_not_fatal(self):
        (self.loki / "pids" / "bad.json").write_text("{not json",
                                                     encoding="utf-8")
        self._write(os.getpid())
        self.assertTrue(_registry_says_alive(self.loki))


if __name__ == "__main__":
    unittest.main()
