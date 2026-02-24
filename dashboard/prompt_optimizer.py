"""
Prompt Optimizer for Loki Mode.

Uses failure patterns from FailureExtractor to generate improved prompt
sections for agents. Stores versioned prompts with change tracking.
"""

import hashlib
import json
import logging
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .failure_extractor import FailureExtractor

logger = logging.getLogger(__name__)

LOKI_DATA_DIR = os.environ.get("LOKI_DATA_DIR", os.path.expanduser("~/.loki"))


def _content_hash(text: str) -> str:
    """Generate a short hash of prompt content for change tracking."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _timestamp_iso() -> str:
    """Return current UTC timestamp in ISO format."""
    return datetime.now(timezone.utc).isoformat()


class PromptOptimizer:
    """Generates and manages versioned prompt optimizations based on failure analysis."""

    def __init__(self, data_dir: str | None = None) -> None:
        self._data_dir = Path(data_dir) if data_dir else Path(LOKI_DATA_DIR)
        self._prompts_dir = self._data_dir / "prompts" / "optimized"
        self._extractor = FailureExtractor(data_dir=str(self._data_dir))
        self._file_lock = threading.Lock()

    def _ensure_dirs(self) -> None:
        """Create prompt storage directories if they do not exist."""
        self._prompts_dir.mkdir(parents=True, exist_ok=True)

    def _version_file(self, version: int) -> Path:
        """Return the path for a specific version file."""
        return self._prompts_dir / f"v{version:04d}.json"

    def _latest_file(self) -> Path:
        """Return path to the latest.json symlink/file."""
        return self._prompts_dir / "latest.json"

    def get_current_version(self) -> dict[str, Any]:
        """Get the current (latest) prompt optimization version.

        Returns:
            The latest version data, or a default structure if none exists.
        """
        latest = self._latest_file()
        if latest.is_file():
            try:
                return json.loads(latest.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("Failed to read latest prompt version: %s", exc)

        return {
            "version": 0,
            "generated_at": None,
            "based_on_sessions": 0,
            "failures_analyzed": 0,
            "changes": [],
        }

    def get_prompt_for_agent(self, agent_type: str) -> dict[str, Any] | None:
        """Get the current optimized prompt section for a specific agent type.

        Supports hot-reload by reading from disk on each call.

        Args:
            agent_type: The agent type to retrieve prompt for (e.g. "test_engineer").

        Returns:
            Dict with agent-specific prompt changes, or None if no optimizations exist.
        """
        current = self.get_current_version()
        if current["version"] == 0:
            return None

        agent_changes = [c for c in current.get("changes", []) if c.get("agent_type") == agent_type]
        if not agent_changes:
            return None

        return {
            "agent_type": agent_type,
            "version": current["version"],
            "generated_at": current["generated_at"],
            "changes": agent_changes,
        }

    def _generate_changes(self, failure_data: dict[str, Any]) -> list[dict[str, Any]]:
        """Generate prompt change suggestions from failure patterns.

        TODO: Integrate actual LLM-as-judge call here. Currently generates
        structured change suggestions based on pattern heuristics. Replace
        the heuristic logic below with an LLM call that analyzes failures
        and produces improved prompt sections.

        Args:
            failure_data: Output from FailureExtractor.extract().

        Returns:
            List of change dicts with agent_type, section, hashes, and rationale.
        """
        changes: list[dict[str, Any]] = []

        for pattern in failure_data.get("patterns", []):
            category = pattern["category"]
            agent_types = pattern.get("agent_types", [])
            count = pattern["count"]
            representative = pattern.get("representative_error", "")

            # If no agent types identified, apply to general
            if not agent_types:
                agent_types = ["general"]

            for agent_type in agent_types:
                # Determine which prompt section to modify based on failure category
                section, rationale = self._section_for_category(
                    category, count, representative
                )

                old_content = f"{agent_type}:{section}:current"
                new_content = f"{agent_type}:{section}:optimized:{category}:{count}"

                changes.append({
                    "agent_type": agent_type,
                    "section": section,
                    "old_hash": _content_hash(old_content),
                    "new_hash": _content_hash(new_content),
                    "rationale": rationale,
                })

        # Deduplicate by (agent_type, section)
        seen: set[tuple[str, str]] = set()
        deduped: list[dict[str, Any]] = []
        for change in changes:
            key = (change["agent_type"], change["section"])
            if key not in seen:
                seen.add(key)
                deduped.append(change)

        return deduped

    def _section_for_category(
        self, category: str, count: int, error_msg: str
    ) -> tuple[str, str]:
        """Map a failure category to the prompt section that should be improved.

        Returns:
            Tuple of (section_name, rationale).
        """
        if category == "timeout":
            return (
                "timeout_handling",
                f"Agent timeouts detected {count} times. "
                "Add explicit timeout boundaries and fallback instructions.",
            )
        elif category == "verification":
            return (
                "verification_instructions",
                f"Verification failures detected {count} times. "
                "Strengthen verification steps and add pre-check instructions.",
            )
        elif category == "retry":
            return (
                "retry_strategy",
                f"Excessive retries detected {count} times. "
                "Add early-exit conditions and reduce maximum retry attempts.",
            )
        else:
            return (
                "error_handling",
                f"Errors detected {count} times: {error_msg[:200]}. "
                "Add targeted error handling guidance.",
            )

    def optimize(
        self, sessions: int = 10, dry_run: bool = False
    ) -> dict[str, Any]:
        """Run prompt optimization from failure analysis.

        Args:
            sessions: Number of recent sessions to analyze.
            dry_run: If True, generate changes but do not persist them.

        Returns:
            The new version data with all changes.
        """
        # Extract failures
        failure_data = self._extractor.extract(sessions=sessions)

        if failure_data["total_failures"] == 0:
            return {
                "version": self.get_current_version()["version"],
                "generated_at": _timestamp_iso(),
                "based_on_sessions": failure_data["session_count"],
                "failures_analyzed": 0,
                "changes": [],
                "dry_run": dry_run,
            }

        # Generate changes
        changes = self._generate_changes(failure_data)

        with self._file_lock:
            current_version = self.get_current_version()["version"]
            new_version = current_version + 1

            result = {
                "version": new_version,
                "generated_at": _timestamp_iso(),
                "based_on_sessions": failure_data["session_count"],
                "failures_analyzed": failure_data["total_failures"],
                "changes": changes,
                "dry_run": dry_run,
            }

            if not dry_run:
                self._persist_version(result)

        return result

    def _persist_version(self, version_data: dict[str, Any]) -> None:
        """Write version data to disk in a thread-safe manner.

        Caller must already hold self._file_lock.
        Uses atomic temp-file-then-rename for POSIX safety.
        """
        self._ensure_dirs()

        # Remove dry_run flag from persisted data
        persist_data = {k: v for k, v in version_data.items() if k != "dry_run"}

        version_path = self._version_file(persist_data["version"])
        latest_path = self._latest_file()
        content = json.dumps(persist_data, indent=2, ensure_ascii=False)

        try:
            # Atomic write to version file
            fd, tmp_path = tempfile.mkstemp(
                dir=str(self._prompts_dir), suffix=".tmp"
            )
            try:
                os.write(fd, content.encode("utf-8"))
                os.fsync(fd)
            finally:
                os.close(fd)
            os.rename(tmp_path, str(version_path))

            # Atomic write to latest file
            fd, tmp_path = tempfile.mkstemp(
                dir=str(self._prompts_dir), suffix=".tmp"
            )
            try:
                os.write(fd, content.encode("utf-8"))
                os.fsync(fd)
            finally:
                os.close(fd)
            os.rename(tmp_path, str(latest_path))

            logger.info(
                "Persisted prompt optimization v%d to %s",
                persist_data["version"],
                version_path,
            )
        except OSError as exc:
            logger.error("Failed to persist prompt version: %s", exc)
            raise
