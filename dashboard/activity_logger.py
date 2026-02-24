"""
Activity Logger for Loki Mode Dashboard.

Appends structured JSONL entries to ~/.loki/activity.jsonl with automatic
rotation at 10MB. Provides query and session-diff capabilities.
"""

import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("loki-activity")

LOKI_DATA_DIR = os.environ.get("LOKI_DATA_DIR", os.path.expanduser("~/.loki"))

# Valid entity types and actions for validation
VALID_ENTITY_TYPES = {"task", "agent", "phase", "checkpoint"}
VALID_ACTIONS = {"created", "status_changed", "completed", "failed", "blocked"}

# Rotation threshold in bytes (10MB)
MAX_FILE_SIZE = 10 * 1024 * 1024


class ActivityLogger:
    """Thread-safe activity logger that writes JSONL to ~/.loki/activity.jsonl."""

    def __init__(self, data_dir: Optional[str] = None) -> None:
        self._data_dir = Path(data_dir or LOKI_DATA_DIR)
        self._log_file = self._data_dir / "activity.jsonl"
        self._lock = threading.Lock()
        self._data_dir.mkdir(parents=True, exist_ok=True)

    @property
    def log_file(self) -> Path:
        """Return the path to the current activity log file."""
        return self._log_file

    def _rotate_if_needed(self) -> None:
        """Rotate the log file if it exceeds MAX_FILE_SIZE."""
        try:
            if self._log_file.exists() and self._log_file.stat().st_size >= MAX_FILE_SIZE:
                timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                rotated = self._data_dir / f"activity-{timestamp}.jsonl"
                self._log_file.rename(rotated)
                logger.info("Rotated activity log to %s", rotated)
        except OSError as e:
            logger.warning("Failed to rotate activity log: %s", e)

    def log(
        self,
        entity_type: str,
        entity_id: str,
        action: str,
        old_value: Optional[str] = None,
        new_value: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Log an activity entry. Returns the entry dict."""
        if entity_type not in VALID_ENTITY_TYPES:
            logger.warning("Invalid entity_type %r (valid: %s)", entity_type, VALID_ENTITY_TYPES)
        if action not in VALID_ACTIONS:
            logger.warning("Invalid action %r (valid: %s)", action, VALID_ACTIONS)

        entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "entity_type": entity_type,
            "entity_id": entity_id,
            "action": action,
            "old_value": old_value,
            "new_value": new_value,
            "session_id": session_id,
        }

        with self._lock:
            self._rotate_if_needed()
            try:
                with open(self._log_file, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, separators=(",", ":")) + "\n")
            except OSError as e:
                logger.error("Failed to write activity entry: %s", e)

        return entry

    def query_since(self, timestamp: str) -> list[dict[str, Any]]:
        """Return activity entries after the given ISO timestamp."""
        # Normalize Z-suffix so comparisons work consistently
        timestamp = timestamp.replace("Z", "+00:00")
        results: list[dict[str, Any]] = []

        if not self._log_file.exists():
            return results

        with self._lock:
            try:
                with open(self._log_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                            entry_ts = entry.get("timestamp", "").replace("Z", "+00:00")
                            if entry_ts > timestamp:
                                results.append(entry)
                        except json.JSONDecodeError:
                            continue
            except OSError as e:
                logger.error("Failed to read activity log: %s", e)

        return results

    def get_session_diff(self, since_timestamp: Optional[str] = None) -> dict[str, Any]:
        """Return a structured summary of activity since the given timestamp.

        If no timestamp is provided, defaults to the last 24 hours.
        """
        if since_timestamp is None:
            since_dt = datetime.now(timezone.utc) - timedelta(hours=24)
            since_timestamp = since_dt.isoformat()

        # Normalize Z-suffix before passing to query_since
        since_timestamp = since_timestamp.replace("Z", "+00:00")

        entries = self.query_since(since_timestamp)

        now = datetime.now(timezone.utc)
        try:
            since_dt = datetime.fromisoformat(since_timestamp.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            since_dt = now

        period_hours = max(0.0, (now - since_dt).total_seconds() / 3600)

        # Build summary counts
        summary = {
            "total_changes": len(entries),
            "tasks_created": 0,
            "tasks_completed": 0,
            "tasks_blocked": 0,
            "phases_transitioned": 0,
            "checkpoints_created": 0,
            "errors": 0,
        }

        highlights: list[str] = []
        decisions: list[dict[str, str]] = []

        for entry in entries:
            entity_type = entry.get("entity_type", "")
            action = entry.get("action", "")
            entity_id = entry.get("entity_id", "")

            if entity_type == "task":
                if action == "created":
                    summary["tasks_created"] += 1
                    highlights.append(f"Task {entity_id} created")
                elif action == "completed":
                    summary["tasks_completed"] += 1
                    highlights.append(f"Task {entity_id} completed")
                elif action == "blocked":
                    summary["tasks_blocked"] += 1
                    highlights.append(f"Task {entity_id} blocked")
                elif action == "failed":
                    summary["errors"] += 1
                    highlights.append(f"Task {entity_id} failed")
                elif action == "status_changed":
                    old_val = entry.get("old_value", "")
                    new_val = entry.get("new_value", "")
                    highlights.append(f"Task {entity_id}: {old_val} -> {new_val}")

            elif entity_type == "agent":
                if action == "failed":
                    summary["errors"] += 1
                    highlights.append(f"Agent {entity_id} failed")
                elif action == "created":
                    highlights.append(f"Agent {entity_id} created")
                elif action == "status_changed":
                    old_val = entry.get("old_value", "")
                    new_val = entry.get("new_value", "")
                    highlights.append(f"Agent {entity_id}: {old_val} -> {new_val}")
                    # Agent status changes may represent decisions
                    if new_val:
                        decisions.append({
                            "timestamp": entry.get("timestamp", ""),
                            "decision": f"Agent {entity_id} transitioned to {new_val}",
                            "reasoning": f"Status changed from {old_val} to {new_val}",
                        })

            elif entity_type == "phase":
                if action == "status_changed":
                    summary["phases_transitioned"] += 1
                    old_val = entry.get("old_value", "")
                    new_val = entry.get("new_value", "")
                    highlights.append(f"Phase transition: {old_val} -> {new_val}")
                    decisions.append({
                        "timestamp": entry.get("timestamp", ""),
                        "decision": f"Phase transitioned to {new_val}",
                        "reasoning": f"Moved from {old_val} to {new_val}",
                    })

            elif entity_type == "checkpoint":
                if action == "created":
                    summary["checkpoints_created"] += 1
                    highlights.append(f"Checkpoint {entity_id} created")

        return {
            "since": since_timestamp,
            "period_hours": round(period_hours, 2),
            "summary": summary,
            "highlights": highlights,
            "decisions": decisions,
        }


# Singleton instance
_instance: Optional[ActivityLogger] = None
_instance_lock = threading.Lock()


def get_activity_logger(data_dir: Optional[str] = None) -> ActivityLogger:
    """Get or create the singleton ActivityLogger instance."""
    global _instance
    if _instance is None:
        with _instance_lock:
            if _instance is None:
                _instance = ActivityLogger(data_dir=data_dir)
    return _instance
