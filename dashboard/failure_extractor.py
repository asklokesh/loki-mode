"""
Failure Extractor for Loki Mode.

Parses session JSONL log files to identify failure patterns such as
repeated task failures, excessive RARV cycles, verification failures,
agent timeouts, and user corrections.
"""

import hashlib
import json
import logging
import os
from collections import defaultdict
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

LOKI_DATA_DIR = os.environ.get("LOKI_DATA_DIR", os.path.expanduser("~/.loki"))

# Keywords/fields used to classify failure categories
_TIMEOUT_KEYWORDS = ("timeout", "timed out", "deadline exceeded", "killed")
_VERIFICATION_KEYWORDS = ("verification failed", "verify failed", "assertion", "expect")
_RETRY_KEYWORDS = ("retry", "retrying", "attempt ", "reattempt")


def _hash_pattern(text: str) -> str:
    """Generate a short deterministic hash for grouping similar errors."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _normalize_error(message: str) -> str:
    """Strip variable parts (timestamps, IDs) to group similar errors."""
    import re
    # Remove hex IDs, UUIDs, timestamps, line numbers
    normalized = re.sub(r"[0-9a-f]{8,}", "<ID>", message)
    normalized = re.sub(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*", "<TS>", normalized)
    normalized = re.sub(r":\d+:\d+", ":<LINE>", normalized)
    normalized = re.sub(r"\d+", "<N>", normalized)
    return normalized.strip()


def _classify_failure(entry: dict[str, Any]) -> str | None:
    """Classify a log entry into a failure category, or None if not a failure."""
    message = str(entry.get("message", "") or entry.get("error", "")).lower()
    event_type = str(entry.get("type", "") or entry.get("event", "")).lower()
    status = str(entry.get("status", "")).lower()

    # Agent timeout
    if any(kw in message for kw in _TIMEOUT_KEYWORDS) or event_type == "timeout":
        return "timeout"

    # Verification failure
    if any(kw in message for kw in _VERIFICATION_KEYWORDS) or event_type == "verification_failed":
        return "verification"

    # Retry / repeated failure
    if any(kw in message for kw in _RETRY_KEYWORDS) or event_type in ("retry", "task_retry"):
        return "retry"

    # RARV cycle excess (iteration count > 2)
    iteration = entry.get("iteration") or entry.get("rarv_iteration")
    if iteration is not None:
        try:
            if int(iteration) > 2:
                return "retry"
        except (ValueError, TypeError):
            pass

    # Generic error
    if status in ("failed", "error") or event_type in ("error", "failure", "task_failed"):
        return "error"

    # User correction
    if event_type in ("user_correction", "correction", "override"):
        return "error"

    return None


class FailureExtractor:
    """Extracts and groups failure patterns from Loki session logs."""

    def __init__(self, data_dir: str | None = None) -> None:
        self._data_dir = Path(data_dir) if data_dir else Path(LOKI_DATA_DIR)

    def _log_paths(self) -> list[Path]:
        """Return all candidate JSONL log files, newest first."""
        paths: list[Path] = []

        # Activity log
        activity = self._data_dir / "activity.jsonl"
        if activity.is_file():
            paths.append(activity)

        # Session logs directory
        logs_dir = self._data_dir / "logs"
        if logs_dir.is_dir():
            session_files = sorted(logs_dir.glob("*.jsonl"), reverse=True)
            paths.extend(session_files)

        return paths

    def _parse_jsonl(self, path: Path, max_lines: int = 50000) -> list[dict[str, Any]]:
        """Parse a JSONL file, returning list of dicts. Skips malformed lines."""
        entries: list[dict[str, Any]] = []
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if i >= max_lines:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except OSError as exc:
            logger.warning("Failed to read log file %s: %s", path, exc)
        return entries

    def _extract_session_id(self, entry: dict[str, Any], fallback: str) -> str:
        """Get session ID from a log entry."""
        return str(entry.get("session_id") or entry.get("session") or fallback)

    def extract(self, sessions: int = 10) -> dict[str, Any]:
        """Extract failure patterns from the most recent N sessions.

        Args:
            sessions: Number of recent sessions to analyze.

        Returns:
            Structured failure data with patterns grouped by similarity.
        """
        log_paths = self._log_paths()
        if not log_paths:
            return {
                "session_count": 0,
                "total_failures": 0,
                "patterns": [],
            }

        # Collect all failure entries across log files
        # Track sessions seen to respect the session limit
        failures: list[dict[str, Any]] = []
        seen_sessions: set[str] = set()
        session_order: list[str] = []

        for path in log_paths:
            entries = self._parse_jsonl(path)
            file_session = path.stem  # use filename as fallback session ID

            for entry in entries:
                sid = self._extract_session_id(entry, file_session)

                # Track session ordering
                if sid not in seen_sessions:
                    seen_sessions.add(sid)
                    session_order.append(sid)

                category = _classify_failure(entry)
                if category is not None:
                    failures.append({
                        "entry": entry,
                        "category": category,
                        "session_id": sid,
                    })

        # Limit to the most recent N sessions
        recent_sessions = set(session_order[:sessions])
        failures = [f for f in failures if f["session_id"] in recent_sessions]

        # Group failures by normalized error message + category
        groups: dict[str, dict[str, Any]] = defaultdict(lambda: {
            "category": "",
            "count": 0,
            "agent_types": set(),
            "phases": set(),
            "representative_error": "",
            "sessions": set(),
        })

        for failure in failures:
            entry = failure["entry"]
            category = failure["category"]
            session_id = failure["session_id"]

            raw_message = str(
                entry.get("message") or entry.get("error") or entry.get("detail") or ""
            )
            normalized = _normalize_error(raw_message)
            group_key = f"{category}:{_hash_pattern(normalized)}"

            group = groups[group_key]
            group["category"] = category
            group["count"] += 1
            group["sessions"].add(session_id)

            if not group["representative_error"]:
                group["representative_error"] = raw_message[:500]

            agent_type = entry.get("agent_type") or entry.get("agent") or ""
            if agent_type:
                group["agent_types"].add(str(agent_type))

            phase = entry.get("phase") or entry.get("stage") or ""
            if phase:
                group["phases"].add(str(phase))

        # Build structured output
        patterns = []
        for group_key, group in sorted(groups.items(), key=lambda x: x[1]["count"], reverse=True):
            patterns.append({
                "pattern_id": _hash_pattern(group_key),
                "category": group["category"],
                "count": group["count"],
                "agent_types": sorted(group["agent_types"]),
                "phases": sorted(group["phases"]),
                "representative_error": group["representative_error"],
                "sessions": sorted(group["sessions"]),
            })

        return {
            "session_count": len(recent_sessions),
            "total_failures": sum(p["count"] for p in patterns),
            "patterns": patterns,
        }
