# Loki Mode Memory Engine
# Core memory engine that orchestrates all memory operations.
# Provides unified interface for episodic, semantic, and procedural memory.

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

# Import schemas - these are expected to be created in parallel
from .schemas import (
    ActionEntry,
    ErrorEntry,
    EpisodeTrace,
    Link,
    ProceduralSkill,
    SemanticPattern,
)

# Import storage backend
from .storage import MemoryStorage


# Task-aware retrieval weight configurations
# Based on arXiv 2512.18746 - MemEvolve finding that task-aware adaptation
# improves performance by 17% over static weights.
TASK_STRATEGIES: Dict[str, Dict[str, float]] = {
    "exploration": {
        "episodic": 0.6,
        "semantic": 0.3,
        "skills": 0.1,
        "anti_patterns": 0.0,
    },
    "implementation": {
        "episodic": 0.15,
        "semantic": 0.5,
        "skills": 0.35,
        "anti_patterns": 0.0,
    },
    "debugging": {
        "episodic": 0.4,
        "semantic": 0.2,
        "skills": 0.0,
        "anti_patterns": 0.4,
    },
    "review": {
        "episodic": 0.3,
        "semantic": 0.5,
        "skills": 0.0,
        "anti_patterns": 0.2,
    },
    "refactoring": {
        "episodic": 0.25,
        "semantic": 0.45,
        "skills": 0.3,
        "anti_patterns": 0.0,
    },
}


class MemoryEngine:
    """
    Core memory engine that orchestrates all memory operations.

    Provides unified access to:
    - Episodic memory: Specific interaction traces
    - Semantic memory: Generalized patterns and facts
    - Procedural memory: Learned action sequences (skills)
    """

    def __init__(
        self,
        storage: Optional[MemoryStorage] = None,
        base_path: str = ".loki/memory",
    ):
        """
        Initialize the memory engine.

        Args:
            storage: MemoryStorage instance (created if not provided)
            base_path: Base path for memory files
        """
        self.base_path = base_path
        self.storage = storage or MemoryStorage(base_path)

        # Optional components - lazy loaded
        self._embeddings: Optional[Any] = None
        self._vector_index: Optional[Any] = None
        self._embedding_func: Optional[Callable[[str], List[float]]] = None

    # -------------------------------------------------------------------------
    # Lifecycle Operations
    # -------------------------------------------------------------------------

    def initialize(self) -> None:
        """
        Initialize the memory system.
        Ensures all required directories and files exist.
        """
        # Create directory structure
        directories = [
            "episodic",
            "semantic",
            "skills",
            "ledgers",
            "handoffs",
            "learnings",
        ]
        for directory in directories:
            self.storage.ensure_directory(directory)

        # Initialize index if not exists
        if not self.storage.read_json("index.json"):
            self.storage.write_json(
                "index.json",
                {
                    "version": "1.0",
                    "last_updated": datetime.now().isoformat(),
                    "topics": [],
                    "total_memories": 0,
                    "total_tokens_available": 0,
                },
            )

        # Initialize timeline if not exists
        if not self.storage.read_json("timeline.json"):
            self.storage.write_json(
                "timeline.json",
                {
                    "version": "1.0",
                    "last_updated": datetime.now().isoformat(),
                    "recent_actions": [],
                    "key_decisions": [],
                    "active_context": {
                        "current_focus": None,
                        "blocked_by": [],
                        "next_up": [],
                    },
                },
            )

        # Initialize semantic patterns if not exists
        if not self.storage.read_json("semantic/patterns.json"):
            self.storage.write_json("semantic/patterns.json", {"patterns": []})

        # Initialize anti-patterns if not exists
        if not self.storage.read_json("semantic/anti-patterns.json"):
            self.storage.write_json("semantic/anti-patterns.json", {"anti_patterns": []})

    def get_stats(self) -> Dict[str, Any]:
        """
        Return memory statistics.

        Returns:
            Dictionary with memory counts and metadata
        """
        index = self.storage.read_json("index.json") or {}

        # Count episodic memories
        episodic_files = self.storage.list_files("episodic", "**/*.json")
        episodic_count = len([f for f in episodic_files if f.name != "index.json"])

        # Count semantic patterns
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}
        pattern_count = len(patterns_data.get("patterns", []))

        # Count anti-patterns
        anti_patterns_data = self.storage.read_json("semantic/anti-patterns.json") or {}
        anti_pattern_count = len(anti_patterns_data.get("anti_patterns", []))

        # Count skills
        skill_files = self.storage.list_files("skills", "*.md")
        skill_count = len(skill_files)

        return {
            "episodic_count": episodic_count,
            "semantic_pattern_count": pattern_count,
            "anti_pattern_count": anti_pattern_count,
            "skill_count": skill_count,
            "total_memories": index.get("total_memories", 0),
            "total_tokens": index.get("total_tokens_available", 0),
            "last_updated": index.get("last_updated"),
        }

    def cleanup_old(self, days: int = 30) -> int:
        """
        Remove old episodic memories that are not referenced.

        Args:
            days: Number of days to retain memories

        Returns:
            Number of memories removed
        """
        cutoff = datetime.now() - timedelta(days=days)
        removed_count = 0

        # Get referenced episode IDs from semantic patterns
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}
        referenced_ids: set = set()
        for pattern in patterns_data.get("patterns", []):
            referenced_ids.update(pattern.get("source_episodes", []))

        # Scan episodic directories
        episodic_path = Path(self.base_path) / "episodic"
        if not episodic_path.exists():
            return 0

        for date_dir in episodic_path.iterdir():
            if not date_dir.is_dir():
                continue

            # Parse date from directory name (e.g., 2026-01-06)
            try:
                dir_date = datetime.strptime(date_dir.name, "%Y-%m-%d")
            except ValueError:
                continue

            if dir_date < cutoff:
                # Check each episode file
                for episode_file in date_dir.glob("*.json"):
                    episode_data = self.storage.read_json(
                        f"episodic/{date_dir.name}/{episode_file.name}"
                    )
                    if episode_data:
                        episode_id = episode_data.get("id", "")
                        if episode_id not in referenced_ids:
                            self.storage.delete_file(
                                f"episodic/{date_dir.name}/{episode_file.name}"
                            )
                            removed_count += 1

        return removed_count

    # -------------------------------------------------------------------------
    # Episode Operations
    # -------------------------------------------------------------------------

    def store_episode(self, trace: EpisodeTrace) -> str:
        """
        Store an episodic memory trace.

        Args:
            trace: EpisodeTrace instance to store

        Returns:
            Episode ID
        """
        # Determine storage path based on timestamp
        trace_dict = trace.to_dict() if hasattr(trace, "to_dict") else trace.__dict__.copy()
        timestamp = trace_dict.get("timestamp", datetime.now().isoformat())

        if isinstance(timestamp, str):
            date_str = timestamp[:10]  # Extract YYYY-MM-DD
        else:
            date_str = timestamp.strftime("%Y-%m-%d")

        episode_id = trace_dict.get("id", f"ep-{date_str}-{self._generate_id()}")
        trace_dict["id"] = episode_id

        # Store episode
        self.storage.ensure_directory(f"episodic/{date_str}")
        self.storage.write_json(f"episodic/{date_str}/{episode_id}.json", trace_dict)

        # Update timeline with action summary
        self._update_timeline_with_episode(trace_dict)

        # Queue for embedding if embeddings are enabled
        if self._embedding_func is not None:
            self._queue_for_embedding(episode_id, "episodic", trace_dict)

        return episode_id

    def get_episode(self, episode_id: str) -> Optional[EpisodeTrace]:
        """
        Retrieve an episode by ID.

        Args:
            episode_id: Episode identifier

        Returns:
            EpisodeTrace instance or None if not found
        """
        # Parse date from episode ID (format: ep-YYYY-MM-DD-XXX)
        parts = episode_id.split("-")
        if len(parts) >= 4:
            date_str = f"{parts[1]}-{parts[2]}-{parts[3]}"
        else:
            # Search all directories
            return self._search_episode(episode_id)

        data = self.storage.read_json(f"episodic/{date_str}/{episode_id}.json")
        if data:
            return self._dict_to_episode(data)
        return None

    def get_recent_episodes(self, limit: int = 10) -> List[EpisodeTrace]:
        """
        Get most recent episodes.

        Args:
            limit: Maximum number of episodes to return

        Returns:
            List of EpisodeTrace instances
        """
        episodes: List[Dict[str, Any]] = []
        episodic_path = Path(self.base_path) / "episodic"

        if not episodic_path.exists():
            return []

        # Get date directories sorted in reverse order
        date_dirs = sorted(
            [d for d in episodic_path.iterdir() if d.is_dir()],
            reverse=True,
        )

        for date_dir in date_dirs:
            if len(episodes) >= limit:
                break

            for episode_file in sorted(date_dir.glob("*.json"), reverse=True):
                if len(episodes) >= limit:
                    break
                if episode_file.name == "index.json":
                    continue

                data = self.storage.read_json(
                    f"episodic/{date_dir.name}/{episode_file.name}"
                )
                if data:
                    episodes.append(data)

        return [self._dict_to_episode(ep) for ep in episodes]

    # -------------------------------------------------------------------------
    # Pattern Operations
    # -------------------------------------------------------------------------

    def store_pattern(self, pattern: SemanticPattern) -> str:
        """
        Store a semantic pattern.

        Args:
            pattern: SemanticPattern instance to store

        Returns:
            Pattern ID
        """
        pattern_dict = pattern.to_dict() if hasattr(pattern, "to_dict") else pattern.__dict__.copy()
        pattern_id = pattern_dict.get("id", f"sem-{self._generate_id()}")
        pattern_dict["id"] = pattern_id

        # Load existing patterns
        patterns_data = self.storage.read_json("semantic/patterns.json") or {"patterns": []}

        # Check if pattern exists and update, otherwise append
        existing_idx = None
        for idx, p in enumerate(patterns_data["patterns"]):
            if p.get("id") == pattern_id:
                existing_idx = idx
                break

        if existing_idx is not None:
            patterns_data["patterns"][existing_idx] = pattern_dict
        else:
            patterns_data["patterns"].append(pattern_dict)

        self.storage.write_json("semantic/patterns.json", patterns_data)

        # Update index
        self._update_index_with_pattern(pattern_dict)

        return pattern_id

    def get_pattern(self, pattern_id: str) -> Optional[SemanticPattern]:
        """
        Retrieve a pattern by ID.

        Args:
            pattern_id: Pattern identifier

        Returns:
            SemanticPattern instance or None if not found
        """
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}
        for pattern in patterns_data.get("patterns", []):
            if pattern.get("id") == pattern_id:
                return self._dict_to_pattern(pattern)
        return None

    def find_patterns(
        self,
        category: Optional[str] = None,
        min_confidence: float = 0.5,
    ) -> List[SemanticPattern]:
        """
        Find patterns matching criteria.

        Args:
            category: Filter by category (optional)
            min_confidence: Minimum confidence threshold

        Returns:
            List of matching SemanticPattern instances
        """
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}
        results: List[SemanticPattern] = []

        for pattern in patterns_data.get("patterns", []):
            # Filter by confidence
            if pattern.get("confidence", 0) < min_confidence:
                continue

            # Filter by category if specified
            if category and pattern.get("category") != category:
                continue

            results.append(self._dict_to_pattern(pattern))

        return results

    def increment_pattern_usage(self, pattern_id: str) -> None:
        """
        Increment usage count for a pattern.

        Args:
            pattern_id: Pattern identifier
        """
        patterns_data = self.storage.read_json("semantic/patterns.json") or {"patterns": []}

        for pattern in patterns_data["patterns"]:
            if pattern.get("id") == pattern_id:
                pattern["usage_count"] = pattern.get("usage_count", 0) + 1
                pattern["last_used"] = datetime.now().isoformat()
                break

        self.storage.write_json("semantic/patterns.json", patterns_data)

    # -------------------------------------------------------------------------
    # Skill Operations
    # -------------------------------------------------------------------------

    def store_skill(self, skill: ProceduralSkill) -> str:
        """
        Store a procedural skill.

        Args:
            skill: ProceduralSkill instance to store

        Returns:
            Skill ID
        """
        skill_dict = skill.to_dict() if hasattr(skill, "to_dict") else skill.__dict__.copy()
        skill_id = skill_dict.get("id", f"skill-{self._generate_id()}")
        skill_dict["id"] = skill_id

        # Generate filename from skill name or ID
        skill_name = skill_dict.get("name", skill_id)
        filename = skill_name.lower().replace(" ", "-").replace("_", "-")

        # Store as markdown
        content = self._skill_to_markdown(skill_dict)
        skill_path = Path(self.base_path) / "skills" / f"{filename}.md"
        skill_path.parent.mkdir(parents=True, exist_ok=True)

        with open(skill_path, "w", encoding="utf-8") as f:
            f.write(content)

        # Also store metadata as JSON for querying
        self.storage.write_json(f"skills/{filename}.json", skill_dict)

        return skill_id

    def get_skill(self, skill_id: str) -> Optional[ProceduralSkill]:
        """
        Retrieve a skill by ID.

        Args:
            skill_id: Skill identifier

        Returns:
            ProceduralSkill instance or None if not found
        """
        # Search JSON metadata files
        skill_files = self.storage.list_files("skills", "*.json")

        for skill_file in skill_files:
            data = self.storage.read_json(f"skills/{skill_file.name}")
            if data and data.get("id") == skill_id:
                return self._dict_to_skill(data)

        return None

    def list_skills(self) -> List[ProceduralSkill]:
        """
        List all stored skills.

        Returns:
            List of ProceduralSkill instances
        """
        skills: List[ProceduralSkill] = []
        skill_files = self.storage.list_files("skills", "*.json")

        for skill_file in skill_files:
            data = self.storage.read_json(f"skills/{skill_file.name}")
            if data:
                skills.append(self._dict_to_skill(data))

        return skills

    # -------------------------------------------------------------------------
    # Unified Retrieval
    # -------------------------------------------------------------------------

    def retrieve_relevant(
        self,
        context: Dict[str, Any],
        top_k: int = 5,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve relevant memories across all memory types.
        Uses task-aware weighting if task_type is provided in context.

        Args:
            context: Dictionary with query context (goal, task_type, etc.)
            top_k: Number of results to return

        Returns:
            List of relevant memory items with source metadata
        """
        task_type = context.get("task_type")
        if task_type:
            task_type = self._detect_task_type(context) if task_type == "auto" else task_type

        weights = TASK_STRATEGIES.get(task_type, TASK_STRATEGIES["implementation"])

        results: List[Dict[str, Any]] = []

        # Retrieve from each memory type based on weights
        if weights.get("episodic", 0) > 0:
            episodic_k = max(1, int(top_k * weights["episodic"] * 2))
            episodes = self.get_recent_episodes(limit=episodic_k)
            for ep in episodes:
                ep_dict = ep.to_dict() if hasattr(ep, "to_dict") else ep.__dict__.copy()
                ep_dict["_source"] = "episodic"
                ep_dict["_weight"] = weights["episodic"]
                results.append(ep_dict)

        if weights.get("semantic", 0) > 0:
            patterns = self.find_patterns(min_confidence=0.5)
            for pattern in patterns[: max(1, int(top_k * weights["semantic"] * 2))]:
                p_dict = pattern.to_dict() if hasattr(pattern, "to_dict") else pattern.__dict__.copy()
                p_dict["_source"] = "semantic"
                p_dict["_weight"] = weights["semantic"]
                results.append(p_dict)

        if weights.get("skills", 0) > 0:
            skills = self.list_skills()
            for skill in skills[: max(1, int(top_k * weights["skills"] * 2))]:
                s_dict = skill.to_dict() if hasattr(skill, "to_dict") else skill.__dict__.copy()
                s_dict["_source"] = "procedural"
                s_dict["_weight"] = weights["skills"]
                results.append(s_dict)

        if weights.get("anti_patterns", 0) > 0:
            anti_patterns_data = self.storage.read_json("semantic/anti-patterns.json") or {}
            for ap in anti_patterns_data.get("anti_patterns", [])[: max(1, int(top_k * weights["anti_patterns"] * 2))]:
                ap["_source"] = "anti_pattern"
                ap["_weight"] = weights["anti_patterns"]
                results.append(ap)

        # Sort by weight and return top_k
        results.sort(key=lambda x: x.get("_weight", 0), reverse=True)
        return results[:top_k]

    def retrieve_by_similarity(
        self,
        query: str,
        collection: str,
        top_k: int = 5,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve memories by semantic similarity.

        Args:
            query: Search query text
            collection: Memory collection (episodic, semantic, procedural)
            top_k: Number of results to return

        Returns:
            List of similar memory items
        """
        if self._embedding_func is None:
            # Fall back to keyword matching if no embeddings
            return self._keyword_search(query, collection, top_k)

        # Use embeddings for similarity search
        query_embedding = self._embedding_func(query)
        return self._vector_search(query_embedding, collection, top_k)

    def retrieve_by_temporal(
        self,
        since: datetime,
        until: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve memories within a time range.

        Args:
            since: Start datetime
            until: End datetime (defaults to now)

        Returns:
            List of memories within the time range
        """
        until = until or datetime.now()
        results: List[Dict[str, Any]] = []

        episodic_path = Path(self.base_path) / "episodic"
        if not episodic_path.exists():
            return results

        for date_dir in episodic_path.iterdir():
            if not date_dir.is_dir():
                continue

            try:
                dir_date = datetime.strptime(date_dir.name, "%Y-%m-%d")
            except ValueError:
                continue

            # Check if date is within range
            if since.date() <= dir_date.date() <= until.date():
                for episode_file in date_dir.glob("*.json"):
                    if episode_file.name == "index.json":
                        continue

                    data = self.storage.read_json(
                        f"episodic/{date_dir.name}/{episode_file.name}"
                    )
                    if data:
                        data["_source"] = "episodic"
                        results.append(data)

        return results

    # -------------------------------------------------------------------------
    # Index Operations
    # -------------------------------------------------------------------------

    def get_index(self) -> Dict[str, Any]:
        """
        Get the memory index.

        Returns:
            Index dictionary
        """
        return self.storage.read_json("index.json") or {}

    def get_timeline(self) -> Dict[str, Any]:
        """
        Get the timeline.

        Returns:
            Timeline dictionary
        """
        return self.storage.read_json("timeline.json") or {}

    def rebuild_index(self) -> None:
        """
        Rebuild the memory index from scratch.
        Scans all memories and regenerates index and timeline.
        """
        topics: Dict[str, Dict[str, Any]] = {}
        total_memories = 0
        total_tokens = 0

        # Index episodic memories
        episodic_path = Path(self.base_path) / "episodic"
        if episodic_path.exists():
            for date_dir in episodic_path.iterdir():
                if not date_dir.is_dir():
                    continue

                for episode_file in date_dir.glob("*.json"):
                    if episode_file.name == "index.json":
                        continue

                    data = self.storage.read_json(
                        f"episodic/{date_dir.name}/{episode_file.name}"
                    )
                    if data:
                        total_memories += 1
                        context = data.get("context", {})
                        goal = context.get("goal", "Unknown task")

                        # Estimate tokens (rough approximation)
                        content_str = json.dumps(data)
                        tokens = len(content_str) // 4
                        total_tokens += tokens

                        # Group by phase/category
                        phase = context.get("phase", "general")
                        if phase not in topics:
                            topics[phase] = {
                                "id": phase,
                                "summary": f"Tasks in {phase} phase",
                                "relevance_score": 0.5,
                                "last_accessed": data.get("timestamp"),
                                "token_count": 0,
                            }

                        topics[phase]["token_count"] += tokens
                        if data.get("timestamp", "") > topics[phase].get("last_accessed", ""):
                            topics[phase]["last_accessed"] = data.get("timestamp")

        # Index semantic patterns
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}
        for pattern in patterns_data.get("patterns", []):
            total_memories += 1
            category = pattern.get("category", "general")

            content_str = json.dumps(pattern)
            tokens = len(content_str) // 4
            total_tokens += tokens

            if category not in topics:
                topics[category] = {
                    "id": category,
                    "summary": f"Patterns for {category}",
                    "relevance_score": pattern.get("confidence", 0.5),
                    "last_accessed": pattern.get("last_used"),
                    "token_count": 0,
                }

            topics[category]["token_count"] += tokens

        # Write updated index
        self.storage.write_json(
            "index.json",
            {
                "version": "1.0",
                "last_updated": datetime.now().isoformat(),
                "topics": list(topics.values()),
                "total_memories": total_memories,
                "total_tokens_available": total_tokens,
            },
        )

    # -------------------------------------------------------------------------
    # Private Helper Methods
    # -------------------------------------------------------------------------

    def _generate_id(self) -> str:
        """Generate a unique ID suffix."""
        import random
        import string
        return "".join(random.choices(string.ascii_lowercase + string.digits, k=6))

    def _update_timeline_with_episode(self, episode: Dict[str, Any]) -> None:
        """Update timeline with episode summary."""
        timeline = self.storage.read_json("timeline.json") or {
            "version": "1.0",
            "recent_actions": [],
            "key_decisions": [],
            "active_context": {},
        }

        # Create action summary
        context = episode.get("context", {})
        action_entry = {
            "timestamp": episode.get("timestamp", datetime.now().isoformat()),
            "action": context.get("goal", "Task completed")[:100],
            "outcome": episode.get("outcome", "unknown"),
            "topic_id": context.get("phase", "general"),
        }

        # Add to recent actions (keep last 50)
        timeline["recent_actions"].insert(0, action_entry)
        timeline["recent_actions"] = timeline["recent_actions"][:50]
        timeline["last_updated"] = datetime.now().isoformat()

        self.storage.write_json("timeline.json", timeline)

    def _update_index_with_pattern(self, pattern: Dict[str, Any]) -> None:
        """Update index with pattern topic."""
        index = self.storage.read_json("index.json") or {
            "version": "1.0",
            "topics": [],
            "total_memories": 0,
            "total_tokens_available": 0,
        }

        category = pattern.get("category", "general")

        # Find or create topic
        topic_found = False
        for topic in index["topics"]:
            if topic.get("id") == category:
                topic["last_accessed"] = datetime.now().isoformat()
                topic["relevance_score"] = max(
                    topic.get("relevance_score", 0.5),
                    pattern.get("confidence", 0.5),
                )
                topic_found = True
                break

        if not topic_found:
            index["topics"].append({
                "id": category,
                "summary": f"Patterns for {category}",
                "relevance_score": pattern.get("confidence", 0.5),
                "last_accessed": datetime.now().isoformat(),
                "token_count": len(json.dumps(pattern)) // 4,
            })

        index["last_updated"] = datetime.now().isoformat()
        index["total_memories"] = index.get("total_memories", 0) + 1

        self.storage.write_json("index.json", index)

    def _search_episode(self, episode_id: str) -> Optional[EpisodeTrace]:
        """Search for episode across all date directories."""
        episodic_path = Path(self.base_path) / "episodic"
        if not episodic_path.exists():
            return None

        for date_dir in episodic_path.iterdir():
            if not date_dir.is_dir():
                continue

            episode_path = date_dir / f"{episode_id}.json"
            if episode_path.exists():
                data = self.storage.read_json(f"episodic/{date_dir.name}/{episode_id}.json")
                if data:
                    return self._dict_to_episode(data)

        return None

    def _dict_to_episode(self, data: Dict[str, Any]) -> EpisodeTrace:
        """Convert dictionary to EpisodeTrace."""
        # Parse timestamp string to datetime
        timestamp_str = data.get("timestamp", "")
        if isinstance(timestamp_str, str) and timestamp_str:
            # Handle ISO format with Z suffix
            if timestamp_str.endswith("Z"):
                timestamp_str = timestamp_str[:-1]
            timestamp = datetime.fromisoformat(timestamp_str)
        elif isinstance(timestamp_str, datetime):
            timestamp = timestamp_str
        else:
            timestamp = datetime.now()

        # Extract phase and goal from context dict
        context = data.get("context", {})
        phase = context.get("phase", data.get("phase", ""))
        goal = context.get("goal", data.get("goal", ""))

        # Convert action_log dicts to ActionEntry objects
        action_log_raw = data.get("action_log", [])
        action_log = [
            ActionEntry.from_dict(a) if isinstance(a, dict) else a
            for a in action_log_raw
        ]

        # Convert errors_encountered dicts to ErrorEntry objects
        errors_raw = data.get("errors_encountered", [])
        errors_encountered = [
            ErrorEntry.from_dict(e) if isinstance(e, dict) else e
            for e in errors_raw
        ]

        return EpisodeTrace(
            id=data.get("id", ""),
            task_id=data.get("task_id", ""),
            timestamp=timestamp,
            duration_seconds=data.get("duration_seconds", 0),
            agent=data.get("agent", ""),
            phase=phase,
            goal=goal,
            action_log=action_log,
            outcome=data.get("outcome", "success"),
            errors_encountered=errors_encountered,
            artifacts_produced=data.get("artifacts_produced", []),
            git_commit=data.get("git_commit"),
            tokens_used=data.get("tokens_used", 0),
            files_read=data.get("files_read", context.get("files_involved", [])),
            files_modified=data.get("files_modified", []),
        )

    def _dict_to_pattern(self, data: Dict[str, Any]) -> SemanticPattern:
        """Convert dictionary to SemanticPattern."""
        # Parse last_used string to datetime or None
        last_used = None
        last_used_raw = data.get("last_used")
        if last_used_raw:
            if isinstance(last_used_raw, str):
                # Handle ISO format with Z suffix
                if last_used_raw.endswith("Z"):
                    last_used_raw = last_used_raw[:-1]
                last_used = datetime.fromisoformat(last_used_raw)
            elif isinstance(last_used_raw, datetime):
                last_used = last_used_raw

        # Convert links dicts to Link objects
        links_raw = data.get("links", [])
        links = [
            Link.from_dict(link) if isinstance(link, dict) else link
            for link in links_raw
        ]

        return SemanticPattern(
            id=data.get("id", ""),
            pattern=data.get("pattern", ""),
            category=data.get("category", ""),
            conditions=data.get("conditions", []),
            correct_approach=data.get("correct_approach", ""),
            incorrect_approach=data.get("incorrect_approach", ""),
            confidence=data.get("confidence", 0.8),
            source_episodes=data.get("source_episodes", []),
            usage_count=data.get("usage_count", 0),
            last_used=last_used,
            links=links,
        )

    def _dict_to_skill(self, data: Dict[str, Any]) -> ProceduralSkill:
        """Convert dictionary to ProceduralSkill."""
        return ProceduralSkill(
            id=data.get("id", ""),
            name=data.get("name", ""),
            description=data.get("description", ""),
            prerequisites=data.get("prerequisites", []),
            steps=data.get("steps", []),
            common_errors=data.get("common_errors", []),
            exit_criteria=data.get("exit_criteria", []),
        )

    def _skill_to_markdown(self, skill: Dict[str, Any]) -> str:
        """Convert skill dictionary to markdown format."""
        lines = [
            f"# Skill: {skill.get('name', 'Unknown')}",
            "",
        ]

        if skill.get("description"):
            lines.extend([skill["description"], ""])

        if skill.get("prerequisites"):
            lines.append("## Prerequisites")
            for prereq in skill["prerequisites"]:
                lines.append(f"- {prereq}")
            lines.append("")

        if skill.get("steps"):
            lines.append("## Steps")
            for i, step in enumerate(skill["steps"], 1):
                lines.append(f"{i}. {step}")
            lines.append("")

        if skill.get("common_errors"):
            lines.append("## Common Errors and Fixes")
            for error in skill["common_errors"]:
                if isinstance(error, dict):
                    lines.append(f"- {error.get('error', 'Unknown')}: {error.get('fix', '')}")
                else:
                    lines.append(f"- {error}")
            lines.append("")

        if skill.get("exit_criteria"):
            lines.append("## Exit Criteria")
            for criterion in skill["exit_criteria"]:
                lines.append(f"- {criterion}")
            lines.append("")

        return "\n".join(lines)

    def _detect_task_type(self, context: Dict[str, Any]) -> str:
        """
        Detect task type from context.
        Uses keyword matching based on goal, action, and phase.
        """
        goal = context.get("goal", "").lower()
        action = context.get("action_type", "").lower()
        phase = context.get("phase", "").lower()

        signals = {
            "exploration": {
                "keywords": [
                    "explore", "understand", "research", "investigate",
                    "analyze", "discover", "find", "what is", "how does",
                    "architecture", "structure", "overview",
                ],
                "actions": ["read_file", "search", "list_files"],
                "phases": ["planning", "discovery", "research"],
            },
            "implementation": {
                "keywords": [
                    "implement", "create", "build", "add", "write",
                    "develop", "make", "construct", "new feature",
                ],
                "actions": ["write_file", "create_file", "edit_file"],
                "phases": ["development", "implementation", "coding"],
            },
            "debugging": {
                "keywords": [
                    "fix", "debug", "error", "bug", "issue", "broken",
                    "failing", "crash", "exception", "investigate error",
                ],
                "actions": ["run_test", "check_logs", "trace"],
                "phases": ["debugging", "troubleshooting", "fixing"],
            },
            "review": {
                "keywords": [
                    "review", "check", "validate", "verify", "audit",
                    "inspect", "quality", "standards", "lint",
                ],
                "actions": ["diff", "review_pr", "check_style"],
                "phases": ["review", "qa", "validation"],
            },
            "refactoring": {
                "keywords": [
                    "refactor", "restructure", "reorganize", "clean up",
                    "improve structure", "extract", "rename", "move",
                ],
                "actions": ["rename", "move_file", "extract_function"],
                "phases": ["refactoring", "cleanup", "optimization"],
            },
        }

        scores: Dict[str, int] = {}
        for task_type, type_signals in signals.items():
            score = 0

            for keyword in type_signals["keywords"]:
                if keyword in goal:
                    score += 2

            for action_signal in type_signals["actions"]:
                if action_signal in action:
                    score += 3

            for phase_signal in type_signals["phases"]:
                if phase_signal in phase:
                    score += 4

            scores[task_type] = score

        best_type = max(scores, key=lambda k: scores[k])
        if scores[best_type] == 0:
            return "implementation"

        return best_type

    def _keyword_search(
        self,
        query: str,
        collection: str,
        top_k: int,
    ) -> List[Dict[str, Any]]:
        """Simple keyword-based search fallback."""
        results: List[Dict[str, Any]] = []
        query_lower = query.lower()
        keywords = query_lower.split()

        if collection == "episodic":
            episodes = self.get_recent_episodes(limit=50)
            for ep in episodes:
                ep_dict = ep.to_dict() if hasattr(ep, "to_dict") else ep.__dict__.copy()
                goal = ep_dict.get("context", {}).get("goal", "").lower()
                score = sum(1 for kw in keywords if kw in goal)
                if score > 0:
                    ep_dict["_score"] = score
                    ep_dict["_source"] = "episodic"
                    results.append(ep_dict)

        elif collection == "semantic":
            patterns = self.find_patterns(min_confidence=0.3)
            for pattern in patterns:
                p_dict = pattern.to_dict() if hasattr(pattern, "to_dict") else pattern.__dict__.copy()
                pattern_text = p_dict.get("pattern", "").lower()
                score = sum(1 for kw in keywords if kw in pattern_text)
                if score > 0:
                    p_dict["_score"] = score
                    p_dict["_source"] = "semantic"
                    results.append(p_dict)

        elif collection == "procedural":
            skills = self.list_skills()
            for skill in skills:
                s_dict = skill.to_dict() if hasattr(skill, "to_dict") else skill.__dict__.copy()
                name = s_dict.get("name", "").lower()
                desc = s_dict.get("description", "").lower()
                score = sum(1 for kw in keywords if kw in name or kw in desc)
                if score > 0:
                    s_dict["_score"] = score
                    s_dict["_source"] = "procedural"
                    results.append(s_dict)

        results.sort(key=lambda x: x.get("_score", 0), reverse=True)
        return results[:top_k]

    def _vector_search(
        self,
        embedding: List[float],
        collection: str,
        top_k: int,
    ) -> List[Dict[str, Any]]:
        """Vector similarity search. Requires embeddings to be configured."""
        # This is a placeholder for vector search implementation
        # In production, this would use a vector database or local index
        return self._keyword_search("", collection, top_k)

    def _queue_for_embedding(
        self,
        item_id: str,
        collection: str,
        data: Dict[str, Any],
    ) -> None:
        """Queue an item for embedding generation."""
        # Placeholder for embedding queue
        # In production, this would add to an async processing queue
        pass


# -----------------------------------------------------------------------------
# Wrapper Classes
# -----------------------------------------------------------------------------


class EpisodicMemory:
    """
    Wrapper for episodic memory operations.
    Provides a focused interface for working with episode traces.
    """

    def __init__(self, engine: MemoryEngine):
        self._engine = engine

    def store(self, trace: EpisodeTrace) -> str:
        """Store an episode trace."""
        return self._engine.store_episode(trace)

    def get(self, episode_id: str) -> Optional[EpisodeTrace]:
        """Get an episode by ID."""
        return self._engine.get_episode(episode_id)

    def get_recent(self, limit: int = 10) -> List[EpisodeTrace]:
        """Get recent episodes."""
        return self._engine.get_recent_episodes(limit)

    def search(self, query: str, top_k: int = 5) -> List[Dict[str, Any]]:
        """Search episodes by similarity."""
        return self._engine.retrieve_by_similarity(query, "episodic", top_k)

    def get_by_date_range(
        self,
        since: datetime,
        until: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """Get episodes within a date range."""
        return self._engine.retrieve_by_temporal(since, until)


class SemanticMemory:
    """
    Wrapper for semantic memory operations.
    Provides a focused interface for working with patterns.
    """

    def __init__(self, engine: MemoryEngine):
        self._engine = engine

    def store(self, pattern: SemanticPattern) -> str:
        """Store a semantic pattern."""
        return self._engine.store_pattern(pattern)

    def get(self, pattern_id: str) -> Optional[SemanticPattern]:
        """Get a pattern by ID."""
        return self._engine.get_pattern(pattern_id)

    def find(
        self,
        category: Optional[str] = None,
        min_confidence: float = 0.5,
    ) -> List[SemanticPattern]:
        """Find patterns matching criteria."""
        return self._engine.find_patterns(category, min_confidence)

    def search(self, query: str, top_k: int = 5) -> List[Dict[str, Any]]:
        """Search patterns by similarity."""
        return self._engine.retrieve_by_similarity(query, "semantic", top_k)

    def increment_usage(self, pattern_id: str) -> None:
        """Increment pattern usage count."""
        self._engine.increment_pattern_usage(pattern_id)


class ProceduralMemory:
    """
    Wrapper for procedural memory operations.
    Provides a focused interface for working with skills.
    """

    def __init__(self, engine: MemoryEngine):
        self._engine = engine

    def store(self, skill: ProceduralSkill) -> str:
        """Store a procedural skill."""
        return self._engine.store_skill(skill)

    def get(self, skill_id: str) -> Optional[ProceduralSkill]:
        """Get a skill by ID."""
        return self._engine.get_skill(skill_id)

    def list_all(self) -> List[ProceduralSkill]:
        """List all skills."""
        return self._engine.list_skills()

    def search(self, query: str, top_k: int = 5) -> List[Dict[str, Any]]:
        """Search skills by similarity."""
        return self._engine.retrieve_by_similarity(query, "procedural", top_k)
