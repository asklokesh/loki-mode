"""
Timeline Layer (Layer 2) - Progressive Disclosure

Provides recent actions and key decisions context.
Target: ~500 tokens for active timeline.

This layer is loaded when the index indicates relevant topics exist,
providing temporal context before loading full memories.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional


class TimelineLayer:
    """
    Layer 2: Timeline (~500 tokens)

    Tracks recent actions, key decisions, and active context
    to provide temporal awareness in memory retrieval.
    """

    VERSION = "1.0"
    MAX_RECENT_ACTIONS = 100
    MAX_KEY_DECISIONS = 50

    def __init__(self, base_path: str = ".loki/memory"):
        """
        Initialize the timeline layer.

        Args:
            base_path: Base directory for memory storage
        """
        self.base_path = Path(base_path)
        self.timeline_path = self.base_path / "timeline.json"
        self._cache: Optional[Dict[str, Any]] = None

    def load(self) -> Dict[str, Any]:
        """
        Load timeline.json from disk.

        Returns:
            Timeline dictionary with actions, decisions, and context
        """
        if not self.timeline_path.exists():
            return self._create_empty_timeline()

        try:
            with open(self.timeline_path, "r") as f:
                self._cache = json.load(f)
                return self._cache
        except (json.JSONDecodeError, IOError):
            return self._create_empty_timeline()

    def _create_empty_timeline(self) -> Dict[str, Any]:
        """Create an empty timeline structure."""
        return {
            "version": self.VERSION,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "recent_actions": [],
            "key_decisions": [],
            "active_context": {
                "current_focus": "",
                "blocked_by": [],
                "next_up": [],
            },
        }

    def _save(self, timeline: Dict[str, Any]) -> None:
        """
        Save timeline to disk.

        Args:
            timeline: Timeline dictionary to save
        """
        self.base_path.mkdir(parents=True, exist_ok=True)
        timeline["last_updated"] = datetime.now(timezone.utc).isoformat()

        with open(self.timeline_path, "w") as f:
            json.dump(timeline, f, indent=2)

        self._cache = timeline

    def add_action(
        self,
        action: str,
        outcome: str,
        topic_id: Optional[str] = None
    ) -> None:
        """
        Add an action to the recent actions list.

        Args:
            action: Description of the action taken
            outcome: Result of the action
            topic_id: Optional ID linking to a topic in the index
        """
        timeline = self.load()

        action_entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "action": action,
            "outcome": outcome,
        }
        if topic_id:
            action_entry["topic_id"] = topic_id

        # Insert at beginning (most recent first)
        timeline["recent_actions"].insert(0, action_entry)

        # Enforce limit
        timeline["recent_actions"] = timeline["recent_actions"][:self.MAX_RECENT_ACTIONS]

        self._save(timeline)

    def add_decision(
        self,
        decision: str,
        rationale: str,
        topic_id: Optional[str] = None
    ) -> None:
        """
        Add a key decision to the decisions list.

        Args:
            decision: The decision that was made
            rationale: Why this decision was made
            topic_id: Optional ID linking to a topic in the index
        """
        timeline = self.load()

        decision_entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "decision": decision,
            "rationale": rationale,
        }
        if topic_id:
            decision_entry["topic_id"] = topic_id

        # Insert at beginning (most recent first)
        timeline["key_decisions"].insert(0, decision_entry)

        # Enforce limit
        timeline["key_decisions"] = timeline["key_decisions"][:self.MAX_KEY_DECISIONS]

        self._save(timeline)

    def get_recent_for_topic(
        self,
        topic_id: str,
        limit: int = 5
    ) -> List[Dict[str, Any]]:
        """
        Get recent actions and decisions for a specific topic.

        Args:
            topic_id: The topic ID to filter by
            limit: Maximum number of entries to return

        Returns:
            List of action/decision entries for the topic
        """
        timeline = self.load()
        entries = []

        # Collect actions for this topic
        for action in timeline.get("recent_actions", []):
            if action.get("topic_id") == topic_id:
                entries.append({**action, "type": "action"})

        # Collect decisions for this topic
        for decision in timeline.get("key_decisions", []):
            if decision.get("topic_id") == topic_id:
                entries.append({**decision, "type": "decision"})

        # Sort by timestamp (newest first)
        entries.sort(
            key=lambda e: e.get("timestamp", ""),
            reverse=True
        )

        return entries[:limit]

    def compress_to_index_entry(
        self,
        topic_memories: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Compress a list of topic memories into an index entry.

        Creates a summary suitable for the index layer.

        Args:
            topic_memories: List of memories for a single topic

        Returns:
            Dictionary suitable for index layer
        """
        if not topic_memories:
            return {}

        # Calculate aggregate metrics
        total_tokens = sum(m.get("token_count", 100) for m in topic_memories)
        avg_relevance = sum(
            m.get("relevance_score", 0.5) for m in topic_memories
        ) / len(topic_memories)

        # Get most recent timestamp
        timestamps = [
            m.get("timestamp", m.get("last_accessed", ""))
            for m in topic_memories
        ]
        last_accessed = max(timestamps) if timestamps else ""

        # Create summary from first memory
        first_memory = topic_memories[0]
        summary = first_memory.get(
            "summary",
            first_memory.get("description", "")[:100]
        )

        return {
            "id": first_memory.get("id", ""),
            "summary": summary,
            "relevance_score": round(avg_relevance, 2),
            "token_count": total_tokens,
            "last_accessed": last_accessed,
            "memory_count": len(topic_memories),
        }

    def prune_old_entries(self, keep_last: int = 100) -> int:
        """
        Remove old entries from the timeline.

        Args:
            keep_last: Number of recent entries to keep

        Returns:
            Number of entries removed
        """
        timeline = self.load()

        original_action_count = len(timeline.get("recent_actions", []))
        original_decision_count = len(timeline.get("key_decisions", []))

        # Prune actions
        timeline["recent_actions"] = timeline.get(
            "recent_actions", []
        )[:keep_last]

        # Prune decisions (keep fewer)
        timeline["key_decisions"] = timeline.get(
            "key_decisions", []
        )[:keep_last // 2]

        self._save(timeline)

        removed_actions = original_action_count - len(timeline["recent_actions"])
        removed_decisions = original_decision_count - len(timeline["key_decisions"])

        return removed_actions + removed_decisions

    def set_active_context(
        self,
        current_focus: str = "",
        blocked_by: Optional[List[str]] = None,
        next_up: Optional[List[str]] = None
    ) -> None:
        """
        Update the active context.

        Args:
            current_focus: What is currently being worked on
            blocked_by: List of blockers
            next_up: List of upcoming tasks
        """
        timeline = self.load()

        timeline["active_context"] = {
            "current_focus": current_focus,
            "blocked_by": blocked_by or [],
            "next_up": next_up or [],
        }

        self._save(timeline)

    def get_active_context(self) -> Dict[str, Any]:
        """
        Get the current active context.

        Returns:
            Active context dictionary
        """
        timeline = self.load()
        return timeline.get("active_context", {
            "current_focus": "",
            "blocked_by": [],
            "next_up": [],
        })

    def get_token_count(self) -> int:
        """
        Get the token count for the current timeline.

        Returns:
            Estimated tokens for the timeline layer
        """
        timeline = self.load()
        content = json.dumps(timeline)
        return len(content) // 4

    def get_recent_actions(self, limit: int = 10) -> List[Dict[str, Any]]:
        """
        Get recent actions.

        Args:
            limit: Maximum number of actions to return

        Returns:
            List of recent action entries
        """
        timeline = self.load()
        return timeline.get("recent_actions", [])[:limit]

    def get_key_decisions(self, limit: int = 10) -> List[Dict[str, Any]]:
        """
        Get key decisions.

        Args:
            limit: Maximum number of decisions to return

        Returns:
            List of key decision entries
        """
        timeline = self.load()
        return timeline.get("key_decisions", [])[:limit]
