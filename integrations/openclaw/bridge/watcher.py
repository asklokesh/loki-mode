"""File watcher for Loki Mode event directories.

Polls .loki/events/pending/ for new JSON event files and monitors
.loki/dashboard-state.json for changes. Calls a user-supplied callback
with each new event dict.

Uses stdlib only -- no external dependencies, no threads.
"""

import json
import os
import time


class LokiFileWatcher:
    """Synchronous polling watcher for Loki Mode flat-file events.

    Args:
        loki_dir: Path to the .loki directory (e.g. ".loki" or "/tmp/project/.loki").
        on_event: Callback receiving a single dict (the parsed event).
        poll_interval: Seconds between directory polls (default 1.0).
    """

    def __init__(
        self,
        loki_dir: str,
        on_event,
        poll_interval: float = 1.0,
    ):
        self.loki_dir = os.path.abspath(loki_dir)
        self.pending_dir = os.path.join(self.loki_dir, "events", "pending")
        self.state_file = os.path.join(self.loki_dir, "dashboard-state.json")
        self.on_event = on_event
        self.poll_interval = poll_interval

        self._processed: set[str] = set()
        self._last_state_mtime: float = 0.0
        self._running = False

    def start(self) -> None:
        """Run the poll loop. Blocks until stop() is called or interrupted."""
        self._running = True
        self._ensure_dirs()

        while self._running:
            self._poll_pending()
            self._poll_state()
            time.sleep(self.poll_interval)

    def stop(self) -> None:
        """Signal the poll loop to exit after the current iteration."""
        self._running = False

    def _ensure_dirs(self) -> None:
        """Create watched directories if they do not exist."""
        os.makedirs(self.pending_dir, exist_ok=True)

    def _poll_pending(self) -> None:
        """Scan pending directory for new JSON event files."""
        try:
            entries = os.listdir(self.pending_dir)
        except OSError:
            return

        for name in sorted(entries):
            if not name.endswith(".json") or name in self._processed:
                continue
            filepath = os.path.join(self.pending_dir, name)
            event = self._read_json(filepath)
            if event is not None:
                self.on_event(event)
            self._processed.add(name)

    def _poll_state(self) -> None:
        """Check dashboard-state.json for modifications."""
        try:
            mtime = os.path.getmtime(self.state_file)
        except OSError:
            return

        if mtime <= self._last_state_mtime:
            return

        self._last_state_mtime = mtime
        state = self._read_json(self.state_file)
        if state is not None:
            self.on_event({
                "type": "dashboard_state",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "payload": state,
            })

    @staticmethod
    def _read_json(path: str):  # -> Optional[dict]
        """Read and parse a JSON file, returning None on any error."""
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError, ValueError):
            return None
