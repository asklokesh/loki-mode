"""
Memory Storage Backend for Loki Mode

JSON-based storage with progressive disclosure layers.
Handles episodic, semantic, and procedural memory persistence.
Includes importance scoring with decay and retrieval boost.
Supports namespace-based project isolation (v5.19.0).
"""

import json
import math
import os
import tempfile
import shutil
import fcntl
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any, Union
from contextlib import contextmanager

# Import schemas (will be created in parallel)
try:
    from .schemas import EpisodeTrace, SemanticPattern, ProceduralSkill
except ImportError:
    # Allow module to load even if schemas not yet available
    EpisodeTrace = Any
    SemanticPattern = Any
    ProceduralSkill = Any


# Default namespace constant
DEFAULT_NAMESPACE = "default"


class MemoryStorage:
    """
    Storage backend for Loki Mode's memory system.

    Provides JSON-based storage with progressive disclosure layers:
    - Episodic: Specific interaction traces
    - Semantic: Generalized patterns
    - Skills: Learned procedures
    - Vectors: Embedding storage (future)

    All operations are atomic and support concurrent access via file locking.
    Supports namespace-based project isolation for memory separation.
    """

    VERSION = "1.1.0"

    def __init__(
        self,
        base_path: str = ".loki/memory",
        namespace: Optional[str] = None,
    ):
        """
        Initialize the memory storage backend.

        Args:
            base_path: Base directory for all memory storage.
                       Defaults to .loki/memory in current working directory.
            namespace: Optional namespace for project isolation.
                       If provided, memories are stored in base_path/{namespace}/
                       Defaults to None (uses base_path directly for backward compat).
        """
        self._root_path = Path(base_path)
        self._namespace = namespace

        # Calculate effective base path (with namespace if specified)
        if namespace and namespace != DEFAULT_NAMESPACE:
            self.base_path = self._root_path / namespace
        else:
            self.base_path = self._root_path

        self._ensure_directories()
        self._ensure_index()
        self._ensure_timeline()

    @property
    def namespace(self) -> Optional[str]:
        """Get the current namespace."""
        return self._namespace

    @property
    def root_path(self) -> Path:
        """Get the root memory path (before namespace)."""
        return self._root_path

    def with_namespace(self, namespace: str) -> "MemoryStorage":
        """
        Create a new MemoryStorage instance with a different namespace.

        This allows switching namespaces while maintaining the same root path.

        Args:
            namespace: The namespace to switch to

        Returns:
            New MemoryStorage instance for the specified namespace
        """
        return MemoryStorage(
            base_path=str(self._root_path),
            namespace=namespace,
        )

    # -------------------------------------------------------------------------
    # Directory and File Management
    # -------------------------------------------------------------------------

    def _ensure_directories(self) -> None:
        """Create all required directories if they don't exist."""
        directories = [
            self.base_path / "episodic",
            self.base_path / "semantic",
            self.base_path / "skills",
            self.base_path / "vectors",
        ]
        for directory in directories:
            directory.mkdir(parents=True, exist_ok=True)

        # Clean up stale lock files from previous crashed processes
        self._cleanup_stale_locks()

    def _cleanup_stale_locks(self) -> None:
        """Remove stale .lock files older than 5 minutes (safe with concurrent processes)."""
        try:
            stale_cutoff = datetime.now(timezone.utc) - timedelta(minutes=5)
            for lock_file in self.base_path.rglob("*.lock"):
                try:
                    mtime = datetime.fromtimestamp(lock_file.stat().st_mtime, tz=timezone.utc)
                    if mtime < stale_cutoff:
                        lock_file.unlink()
                except OSError:
                    pass
        except OSError:
            pass

    def _ensure_index(self) -> None:
        """Initialize index.json if it doesn't exist."""
        index_path = self.base_path / "index.json"
        if not index_path.exists():
            initial_index = {
                "version": self.VERSION,
                "last_updated": datetime.now(timezone.utc).isoformat(),
                "topics": []
            }
            self._atomic_write(index_path, initial_index)

    def _ensure_timeline(self) -> None:
        """Initialize timeline.json if it doesn't exist."""
        timeline_path = self.base_path / "timeline.json"
        if not timeline_path.exists():
            initial_timeline = {
                "version": self.VERSION,
                "last_updated": datetime.now(timezone.utc).isoformat(),
                "recent_actions": [],
                "key_decisions": [],
                "active_context": {}
            }
            self._atomic_write(timeline_path, initial_timeline)

    # -------------------------------------------------------------------------
    # File I/O Utilities
    # -------------------------------------------------------------------------

    @contextmanager
    def _file_lock(self, path: Path, exclusive: bool = True):
        """
        Context manager for file locking.

        Args:
            path: Path to the file to lock
            exclusive: If True, acquire exclusive lock. Otherwise shared lock.

        Yields:
            File handle with lock held
        """
        lock_path = path.with_suffix(path.suffix + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)

        lock_file = None
        try:
            # Create lock file if it doesn't exist
            lock_file = open(lock_path, "w")
            lock_type = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            fcntl.flock(lock_file.fileno(), lock_type)
            yield
        finally:
            if lock_file is not None:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                lock_file.close()
                try:
                    os.remove(lock_path)
                except OSError:
                    pass

    def _atomic_write(self, path: Path, data: dict) -> None:
        """
        Atomically write JSON data to a file.

        Uses a temporary file and atomic rename to prevent corruption.

        Args:
            path: Target file path
            data: Dictionary to serialize as JSON
        """
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with self._file_lock(path, exclusive=True):
            # Write to temp file in same directory for atomic rename
            fd, temp_path = tempfile.mkstemp(
                dir=path.parent,
                prefix=".tmp_",
                suffix=".json"
            )
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(data, f, indent=2, default=str)
                # Atomic rename
                shutil.move(temp_path, path)
            except Exception:
                # Clean up temp file on error
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
                raise

    def _load_json(self, path: Path) -> Optional[dict]:
        """
        Load JSON data from a file.

        Args:
            path: Path to JSON file

        Returns:
            Parsed JSON as dictionary, or None if file doesn't exist
        """
        path = Path(path)
        if not path.exists():
            return None

        with self._file_lock(path, exclusive=False):
            with open(path, "r") as f:
                return json.load(f)

    def _generate_id(self, prefix: str) -> str:
        """
        Generate a unique ID with the given prefix.

        Format: {prefix}-{timestamp}-{random}

        Args:
            prefix: Prefix for the ID (e.g., "episode", "pattern", "skill")

        Returns:
            Unique identifier string
        """
        import uuid
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        random_suffix = uuid.uuid4().hex[:8]
        return f"{prefix}-{timestamp}-{random_suffix}"

    # -------------------------------------------------------------------------
    # Episode Storage
    # -------------------------------------------------------------------------

    def save_episode(self, episode: EpisodeTrace) -> str:
        """
        Save an episode trace to storage.

        Episodes are stored in: episodic/{date}/task-{id}.json

        Args:
            episode: EpisodeTrace object to save

        Returns:
            Episode ID
        """
        # Handle both dict and object
        if hasattr(episode, "to_dict"):
            episode_data = episode.to_dict()
        elif hasattr(episode, "__dict__"):
            episode_data = episode.__dict__.copy()
        else:
            episode_data = dict(episode)

        # Ensure episode has an ID
        episode_id = episode_data.get("id") or self._generate_id("episode")
        episode_data["id"] = episode_id

        # Determine storage path based on date
        timestamp = episode_data.get("timestamp", datetime.now(timezone.utc).isoformat())
        if isinstance(timestamp, str):
            date_str = timestamp[:10]  # Extract YYYY-MM-DD
        else:
            date_str = timestamp.strftime("%Y-%m-%d")

        date_dir = self.base_path / "episodic" / date_str
        date_dir.mkdir(parents=True, exist_ok=True)

        file_path = date_dir / f"task-{episode_id}.json"
        self._atomic_write(file_path, episode_data)

        return episode_id

    def load_episode(self, episode_id: str) -> Optional[EpisodeTrace]:
        """
        Load an episode trace by ID.

        Searches across all date directories.

        Args:
            episode_id: The episode ID to load

        Returns:
            EpisodeTrace object or None if not found
        """
        episodic_dir = self.base_path / "episodic"
        if not episodic_dir.exists():
            return None

        # Search all date directories
        for date_dir in episodic_dir.iterdir():
            if date_dir.is_dir():
                file_path = date_dir / f"task-{episode_id}.json"
                if file_path.exists():
                    data = self._load_json(file_path)
                    if data:
                        return data  # Return raw dict; caller can convert

        return None

    def list_episodes(
        self,
        since: Optional[datetime] = None,
        limit: int = 100
    ) -> List[str]:
        """
        List episode IDs, optionally filtered by date.

        Args:
            since: Only return episodes after this datetime
            limit: Maximum number of episodes to return

        Returns:
            List of episode IDs, newest first
        """
        episodic_dir = self.base_path / "episodic"
        if not episodic_dir.exists():
            return []

        episodes = []

        # Get all date directories, sorted newest first
        date_dirs = sorted(
            [d for d in episodic_dir.iterdir() if d.is_dir()],
            reverse=True
        )

        for date_dir in date_dirs:
            # Check if date is before filter
            if since:
                try:
                    dir_date = datetime.strptime(date_dir.name, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                    since_cmp = since.replace(hour=0, minute=0, second=0, microsecond=0)
                    if since_cmp.tzinfo is None:
                        since_cmp = since_cmp.replace(tzinfo=timezone.utc)
                    if dir_date < since_cmp:
                        continue
                except ValueError:
                    continue

            # List episode files in this directory
            for file_path in sorted(date_dir.glob("task-*.json"), reverse=True):
                episode_id = file_path.stem.replace("task-", "")
                episodes.append(episode_id)

                if len(episodes) >= limit:
                    return episodes

        return episodes

    def delete_episode(self, episode_id: str) -> bool:
        """
        Delete an episode by ID.

        Args:
            episode_id: The episode ID to delete

        Returns:
            True if deleted, False if not found
        """
        episodic_dir = self.base_path / "episodic"
        if not episodic_dir.exists():
            return False

        for date_dir in episodic_dir.iterdir():
            if date_dir.is_dir():
                file_path = date_dir / f"task-{episode_id}.json"
                if file_path.exists():
                    with self._file_lock(file_path, exclusive=True):
                        file_path.unlink()
                    # Clean up lock file (safety net in case _file_lock missed it)
                    lock_path = file_path.with_suffix(".json.lock")
                    try:
                        if lock_path.exists():
                            lock_path.unlink()
                    except OSError:
                        pass
                    # Clean up any remaining lock files before checking if dir is empty
                    for stale_lock in date_dir.glob("*.lock"):
                        try:
                            stale_lock.unlink()
                        except OSError:
                            pass
                    # Clean up empty date directory
                    if not any(date_dir.iterdir()):
                        date_dir.rmdir()
                    return True

        return False

    # -------------------------------------------------------------------------
    # Pattern Storage
    # -------------------------------------------------------------------------

    def save_pattern(self, pattern: SemanticPattern) -> str:
        """
        Save a semantic pattern to storage.

        Patterns are stored in: semantic/patterns.json (append-friendly)

        Args:
            pattern: SemanticPattern object to save

        Returns:
            Pattern ID
        """
        # Handle both dict and object
        if hasattr(pattern, "to_dict"):
            pattern_data = pattern.to_dict()
        elif hasattr(pattern, "__dict__"):
            pattern_data = pattern.__dict__.copy()
        else:
            pattern_data = dict(pattern)

        # Ensure pattern has an ID
        pattern_id = pattern_data.get("id") or self._generate_id("pattern")
        pattern_data["id"] = pattern_id
        pattern_data["created_at"] = pattern_data.get(
            "created_at",
            datetime.now(timezone.utc).isoformat()
        )

        patterns_path = self.base_path / "semantic" / "patterns.json"

        with self._file_lock(patterns_path, exclusive=True):
            # Load existing patterns
            if patterns_path.exists():
                with open(patterns_path, "r") as f:
                    patterns_file = json.load(f)
            else:
                patterns_file = {
                    "version": self.VERSION,
                    "patterns": []
                }

            # Upsert: update existing pattern or append new
            existing_idx = None
            for i, p in enumerate(patterns_file["patterns"]):
                if p.get("id") == pattern_id:
                    existing_idx = i
                    break
            if existing_idx is not None:
                patterns_file["patterns"][existing_idx] = pattern_data
            else:
                patterns_file["patterns"].append(pattern_data)
            patterns_file["last_updated"] = datetime.now(timezone.utc).isoformat()

            # Write atomically
            fd, temp_path = tempfile.mkstemp(
                dir=patterns_path.parent,
                prefix=".tmp_",
                suffix=".json"
            )
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(patterns_file, f, indent=2, default=str)
                shutil.move(temp_path, patterns_path)
            except Exception:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
                raise

        return pattern_id

    def load_pattern(self, pattern_id: str) -> Optional[SemanticPattern]:
        """
        Load a semantic pattern by ID.

        Args:
            pattern_id: The pattern ID to load

        Returns:
            SemanticPattern object or None if not found
        """
        patterns_path = self.base_path / "semantic" / "patterns.json"
        patterns_file = self._load_json(patterns_path)

        if not patterns_file:
            return None

        for pattern in patterns_file.get("patterns", []):
            if pattern.get("id") == pattern_id:
                return pattern

        return None

    def list_patterns(self, category: str = None) -> List[str]:
        """
        List pattern IDs, optionally filtered by category.

        Args:
            category: Optional category filter

        Returns:
            List of pattern IDs
        """
        patterns_path = self.base_path / "semantic" / "patterns.json"
        patterns_file = self._load_json(patterns_path)

        if not patterns_file:
            return []

        pattern_ids = []
        for pattern in patterns_file.get("patterns", []):
            if category is None or pattern.get("category") == category:
                pattern_ids.append(pattern.get("id"))

        return pattern_ids

    def update_pattern(self, pattern: SemanticPattern) -> bool:
        """
        Update an existing pattern.

        Args:
            pattern: SemanticPattern with updated data (must have id)

        Returns:
            True if updated, False if not found
        """
        # Handle both dict and object
        if hasattr(pattern, "to_dict"):
            pattern_data = pattern.to_dict()
        elif hasattr(pattern, "__dict__"):
            pattern_data = pattern.__dict__.copy()
        else:
            pattern_data = dict(pattern)

        pattern_id = pattern_data.get("id")
        if not pattern_id:
            return False

        patterns_path = self.base_path / "semantic" / "patterns.json"

        with self._file_lock(patterns_path, exclusive=True):
            if not patterns_path.exists():
                return False

            with open(patterns_path, "r") as f:
                patterns_file = json.load(f)

            # Find and update pattern
            found = False
            for i, p in enumerate(patterns_file.get("patterns", [])):
                if p.get("id") == pattern_id:
                    pattern_data["updated_at"] = datetime.now(timezone.utc).isoformat()
                    patterns_file["patterns"][i] = pattern_data
                    found = True
                    break

            if not found:
                return False

            patterns_file["last_updated"] = datetime.now(timezone.utc).isoformat()

            # Write atomically
            fd, temp_path = tempfile.mkstemp(
                dir=patterns_path.parent,
                prefix=".tmp_",
                suffix=".json"
            )
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(patterns_file, f, indent=2, default=str)
                shutil.move(temp_path, patterns_path)
            except Exception:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
                raise

        return True

    # -------------------------------------------------------------------------
    # Skill Storage
    # -------------------------------------------------------------------------

    def save_skill(self, skill: ProceduralSkill) -> str:
        """
        Save a procedural skill to storage.

        Skills are stored in: skills/{skill-name}.json

        Args:
            skill: ProceduralSkill object to save

        Returns:
            Skill ID
        """
        # Handle both dict and object
        if hasattr(skill, "to_dict"):
            skill_data = skill.to_dict()
        elif hasattr(skill, "__dict__"):
            skill_data = skill.__dict__.copy()
        else:
            skill_data = dict(skill)

        # Ensure skill has an ID
        skill_id = skill_data.get("id") or self._generate_id("skill")
        skill_data["id"] = skill_id
        skill_data["created_at"] = skill_data.get(
            "created_at",
            datetime.now(timezone.utc).isoformat()
        )

        # Use skill name for filename if available, otherwise use ID
        skill_name = skill_data.get("name", skill_id)
        # Sanitize filename
        safe_name = "".join(
            c if c.isalnum() or c in "-_" else "_"
            for c in skill_name
        )

        file_path = self.base_path / "skills" / f"{safe_name}.json"
        self._atomic_write(file_path, skill_data)

        return skill_id

    def load_skill(self, skill_id: str) -> Optional[ProceduralSkill]:
        """
        Load a procedural skill by ID.

        Args:
            skill_id: The skill ID to load

        Returns:
            ProceduralSkill object or None if not found
        """
        skills_dir = self.base_path / "skills"
        if not skills_dir.exists():
            return None

        # Search all skill files
        for file_path in skills_dir.glob("*.json"):
            data = self._load_json(file_path)
            if data and data.get("id") == skill_id:
                return data

        return None

    def list_skills(self) -> List[str]:
        """
        List all skill IDs.

        Returns:
            List of skill IDs
        """
        skills_dir = self.base_path / "skills"
        if not skills_dir.exists():
            return []

        skill_ids = []
        for file_path in skills_dir.glob("*.json"):
            data = self._load_json(file_path)
            if data and data.get("id"):
                skill_ids.append(data.get("id"))

        return skill_ids

    # -------------------------------------------------------------------------
    # Index Management
    # -------------------------------------------------------------------------

    def update_index(self) -> None:
        """
        Rebuild the index.json file.

        Scans all memory stores and builds a topic index for efficient lookup.
        """
        index = {
            "version": self.VERSION,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "topics": []
        }

        # Index episodes
        for episode_id in self.list_episodes(limit=1000):
            episode = self.load_episode(episode_id)
            if episode:
                topic = {
                    "id": episode_id,
                    "type": "episode",
                    "summary": episode.get("summary", ""),
                    "relevance_score": episode.get("importance", 0.5),
                    "token_count": episode.get("token_count", 0)
                }
                index["topics"].append(topic)

        # Index patterns
        for pattern_id in self.list_patterns():
            pattern = self.load_pattern(pattern_id)
            if pattern:
                topic = {
                    "id": pattern_id,
                    "type": "pattern",
                    "summary": pattern.get("description", ""),
                    "relevance_score": pattern.get("confidence", 0.5),
                    "token_count": pattern.get("token_count", 0)
                }
                index["topics"].append(topic)

        # Index skills
        for skill_id in self.list_skills():
            skill = self.load_skill(skill_id)
            if skill:
                topic = {
                    "id": skill_id,
                    "type": "skill",
                    "summary": skill.get("description", ""),
                    "relevance_score": skill.get("success_rate", 0.5),
                    "token_count": skill.get("token_count", 0)
                }
                index["topics"].append(topic)

        index_path = self.base_path / "index.json"
        self._atomic_write(index_path, index)

    def get_index(self) -> dict:
        """
        Get the current index.

        Returns:
            Index dictionary with topics and metadata
        """
        index_path = self.base_path / "index.json"
        return self._load_json(index_path) or {
            "version": self.VERSION,
            "last_updated": None,
            "topics": []
        }

    # -------------------------------------------------------------------------
    # Timeline Management
    # -------------------------------------------------------------------------

    def update_timeline(self, action: dict) -> None:
        """
        Add an action to the timeline.

        Args:
            action: Action dictionary with type, description, timestamp, etc.
        """
        timeline_path = self.base_path / "timeline.json"

        with self._file_lock(timeline_path, exclusive=True):
            if timeline_path.exists():
                with open(timeline_path, "r") as f:
                    timeline = json.load(f)
            else:
                timeline = {
                    "version": self.VERSION,
                    "recent_actions": [],
                    "key_decisions": [],
                    "active_context": {}
                }

            # Add timestamp if not present
            if "timestamp" not in action:
                action["timestamp"] = datetime.now(timezone.utc).isoformat()

            # Add to recent actions
            timeline["recent_actions"].insert(0, action)

            # Keep only last 100 actions
            timeline["recent_actions"] = timeline["recent_actions"][:100]

            # Track key decisions separately
            if action.get("is_key_decision"):
                timeline["key_decisions"].insert(0, action)
                timeline["key_decisions"] = timeline["key_decisions"][:50]

            timeline["last_updated"] = datetime.now(timezone.utc).isoformat()

            # Write atomically
            fd, temp_path = tempfile.mkstemp(
                dir=timeline_path.parent,
                prefix=".tmp_",
                suffix=".json"
            )
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(timeline, f, indent=2, default=str)
                shutil.move(temp_path, timeline_path)
            except Exception:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
                raise

    def get_timeline(self) -> dict:
        """
        Get the current timeline.

        Returns:
            Timeline dictionary with actions, decisions, and context
        """
        timeline_path = self.base_path / "timeline.json"
        return self._load_json(timeline_path) or {
            "version": self.VERSION,
            "last_updated": None,
            "recent_actions": [],
            "key_decisions": [],
            "active_context": {}
        }

    # -------------------------------------------------------------------------
    # Context Management
    # -------------------------------------------------------------------------

    def set_active_context(self, context: dict) -> None:
        """
        Set the active context in the timeline.

        Args:
            context: Dictionary of current context variables
        """
        timeline_path = self.base_path / "timeline.json"

        with self._file_lock(timeline_path, exclusive=True):
            if timeline_path.exists():
                with open(timeline_path, "r") as f:
                    timeline = json.load(f)
            else:
                timeline = {
                    "version": self.VERSION,
                    "recent_actions": [],
                    "key_decisions": [],
                    "active_context": {}
                }

            timeline["active_context"] = context
            timeline["last_updated"] = datetime.now(timezone.utc).isoformat()

            # Write atomically
            fd, temp_path = tempfile.mkstemp(
                dir=timeline_path.parent,
                prefix=".tmp_",
                suffix=".json"
            )
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(timeline, f, indent=2, default=str)
                shutil.move(temp_path, timeline_path)
            except Exception:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
                raise

    def get_active_context(self) -> dict:
        """
        Get the current active context.

        Returns:
            Active context dictionary
        """
        timeline = self.get_timeline()
        return timeline.get("active_context", {})

    # -------------------------------------------------------------------------
    # Public Wrapper Methods (used by engine.py)
    # -------------------------------------------------------------------------

    def ensure_directory(self, subpath: str) -> None:
        """Create directory if it doesn't exist."""
        path = os.path.join(self.base_path, subpath)
        os.makedirs(path, exist_ok=True)

    def _resolve_path(self, filepath: str) -> str:
        """Resolve filepath within base_path, preventing path traversal."""
        if os.path.isabs(filepath):
            raise ValueError(f"Absolute paths not allowed: {filepath}")
        if ".." in filepath.split(os.sep):
            raise ValueError(f"Path traversal not allowed: {filepath}")
        full_path = os.path.join(self.base_path, filepath)
        real_base = os.path.realpath(self.base_path)
        real_full = os.path.realpath(full_path)
        if not real_full.startswith(real_base + os.sep) and real_full != real_base:
            raise ValueError(f"Path escapes base directory: {filepath}")
        return full_path

    def read_json(self, filepath: str) -> Optional[dict]:
        """Read JSON file, return None if not found."""
        full_path = self._resolve_path(filepath)
        return self._load_json(full_path)

    def write_json(self, filepath: str, data: dict) -> None:
        """Write JSON file atomically."""
        full_path = self._resolve_path(filepath)
        self._atomic_write(full_path, data)

    def list_files(self, subpath: str, pattern: str = "*.json") -> List[Path]:
        """List files in directory matching pattern. Returns Path objects."""
        path = Path(self.base_path) / subpath
        if not path.exists():
            return []
        return list(path.glob(pattern))

    def delete_file(self, filepath: str) -> bool:
        """Delete file, return True if deleted."""
        full_path = self._resolve_path(filepath)
        try:
            os.remove(full_path)
            return True
        except (OSError, FileNotFoundError):
            return False

    # -------------------------------------------------------------------------
    # Importance Scoring Functions
    # -------------------------------------------------------------------------

    def calculate_importance(
        self,
        memory: Dict[str, Any],
        task_type: Optional[str] = None,
    ) -> float:
        """
        Calculate importance score for a memory based on various signals.

        Factors considered:
        - Base importance (default 0.5)
        - Outcome success (boost for success, penalty for failure)
        - Error resolution (higher if errors were resolved)
        - Access frequency (more accessed = more important)
        - Task type match (boost if memory matches current task type)
        - Confidence (for semantic patterns)

        Args:
            memory: Memory dictionary (episode, pattern, or skill)
            task_type: Optional current task type for relevance matching

        Returns:
            Calculated importance score between 0.0 and 1.0
        """
        base = memory.get("importance", 0.5)

        # Outcome adjustment for episodes
        outcome = memory.get("outcome", "")
        if outcome == "success":
            base = min(1.0, base + 0.1)
        elif outcome == "failure":
            base = max(0.0, base - 0.1)

        # Error resolution boost
        errors = memory.get("errors_encountered", [])
        if errors:
            # If there are errors but outcome is success, errors were resolved
            if outcome == "success":
                base = min(1.0, base + 0.05 * min(len(errors), 3))

        # Access frequency boost (diminishing returns)
        access_count = memory.get("access_count", 0)
        if access_count > 0:
            # Log scale boost, caps at about 0.15 for 100+ accesses
            access_boost = 0.05 * math.log1p(access_count)
            base = min(1.0, base + access_boost)

        # Confidence factor for semantic patterns
        confidence = memory.get("confidence")
        if confidence is not None:
            # Blend with confidence
            base = (base + confidence) / 2

        # Task type relevance boost
        if task_type:
            context = memory.get("context", {})
            phase = context.get("phase", memory.get("phase", "")).lower()
            category = memory.get("category", "").lower()

            task_type_lower = task_type.lower()

            # Phase match boost
            if task_type_lower in phase or phase in task_type_lower:
                base = min(1.0, base + 0.1)

            # Category match boost for patterns
            if task_type_lower in category or category in task_type_lower:
                base = min(1.0, base + 0.1)

        return round(min(1.0, max(0.0, base)), 3)

    def apply_decay(
        self,
        memories: List[Dict[str, Any]],
        decay_rate: float = 0.1,
        half_life_days: int = 30,
    ) -> List[Dict[str, Any]]:
        """
        Apply time-based decay to importance scores.

        Uses exponential decay based on time since last access.
        Decay formula: importance * exp(-decay_rate * days_since_access / half_life)

        Args:
            memories: List of memory dictionaries to decay
            decay_rate: Base decay rate (default 0.1)
            half_life_days: Days until importance halves without access (default 30)

        Returns:
            List of memories with decayed importance scores
        """
        now = datetime.now(timezone.utc)

        for memory in memories:
            # Get the reference time (last_accessed or timestamp or last_used)
            ref_time = None
            for time_field in ["last_accessed", "timestamp", "last_used"]:
                time_value = memory.get(time_field)
                if time_value:
                    if isinstance(time_value, str):
                        if time_value.endswith("Z"):
                            time_value = time_value[:-1]
                        try:
                            ref_time = datetime.fromisoformat(time_value)
                            if ref_time.tzinfo is None:
                                ref_time = ref_time.replace(tzinfo=timezone.utc)
                            break
                        except ValueError:
                            continue
                    elif isinstance(time_value, datetime):
                        ref_time = time_value
                        if ref_time.tzinfo is None:
                            ref_time = ref_time.replace(tzinfo=timezone.utc)
                        break

            if ref_time is None:
                continue

            # Calculate days since reference time
            days_elapsed = (now - ref_time).total_seconds() / 86400

            if days_elapsed <= 0:
                continue

            # Apply exponential decay
            current_importance = memory.get("importance", 0.5)
            decay_factor = math.exp(-decay_rate * days_elapsed / half_life_days)
            decayed_importance = current_importance * decay_factor

            # Ensure minimum importance of 0.01 (memories don't fully disappear)
            memory["importance"] = round(max(0.01, decayed_importance), 3)

        return memories

    def boost_on_retrieval(
        self,
        memory: Dict[str, Any],
        boost: float = 0.1,
    ) -> Dict[str, Any]:
        """
        Boost importance and update access tracking when a memory is retrieved.

        This implements the "use it or lose it" principle - frequently accessed
        memories maintain their importance while unused ones decay.

        Args:
            memory: Memory dictionary to boost
            boost: Amount to boost importance (default 0.1)

        Returns:
            Memory with boosted importance and updated access tracking
        """
        now = datetime.now(timezone.utc)

        # Update access tracking
        memory["last_accessed"] = now.isoformat()
        memory["access_count"] = memory.get("access_count", 0) + 1

        # Boost importance (with diminishing returns for high importance)
        current_importance = memory.get("importance", 0.5)

        # Diminishing returns: boost is reduced as importance approaches 1.0
        effective_boost = boost * (1.0 - current_importance)
        new_importance = min(1.0, current_importance + effective_boost)

        memory["importance"] = round(new_importance, 3)

        return memory

    def batch_apply_decay(
        self,
        collection: str = "all",
        decay_rate: float = 0.1,
        half_life_days: int = 30,
    ) -> int:
        """
        Apply decay to all memories in a collection and persist changes.

        Args:
            collection: Which collection to decay ("episodic", "semantic",
                       "skills", or "all")
            decay_rate: Base decay rate
            half_life_days: Days until importance halves

        Returns:
            Number of memories updated
        """
        updated_count = 0

        collections_to_process = []
        if collection == "all":
            collections_to_process = ["episodic", "semantic", "skills"]
        else:
            collections_to_process = [collection]

        for coll in collections_to_process:
            if coll == "episodic":
                updated_count += self._decay_episodic(decay_rate, half_life_days)
            elif coll == "semantic":
                updated_count += self._decay_semantic(decay_rate, half_life_days)
            elif coll == "skills":
                updated_count += self._decay_skills(decay_rate, half_life_days)

        return updated_count

    def _decay_episodic(self, decay_rate: float, half_life_days: int) -> int:
        """Apply decay to episodic memories."""
        updated = 0
        episodic_dir = self.base_path / "episodic"
        if not episodic_dir.exists():
            return 0

        for date_dir in episodic_dir.iterdir():
            if not date_dir.is_dir():
                continue

            for file_path in date_dir.glob("task-*.json"):
                data = self._load_json(file_path)
                if data:
                    original_importance = data.get("importance", 0.5)
                    memories = self.apply_decay([data], decay_rate, half_life_days)
                    if memories[0].get("importance") != original_importance:
                        self._atomic_write(file_path, memories[0])
                        updated += 1

        return updated

    def _decay_semantic(self, decay_rate: float, half_life_days: int) -> int:
        """Apply decay to semantic patterns."""
        patterns_path = self.base_path / "semantic" / "patterns.json"
        if not patterns_path.exists():
            return 0

        patterns_file = self._load_json(patterns_path)
        if not patterns_file:
            return 0

        patterns = patterns_file.get("patterns", [])
        if not patterns:
            return 0

        updated = 0
        for pattern in patterns:
            original = pattern.get("importance", 0.5)
            self.apply_decay([pattern], decay_rate, half_life_days)
            if pattern.get("importance") != original:
                updated += 1

        if updated > 0:
            patterns_file["last_updated"] = datetime.now(timezone.utc).isoformat()
            self._atomic_write(patterns_path, patterns_file)

        return updated

    def _decay_skills(self, decay_rate: float, half_life_days: int) -> int:
        """Apply decay to procedural skills."""
        updated = 0
        skills_dir = self.base_path / "skills"
        if not skills_dir.exists():
            return 0

        for file_path in skills_dir.glob("*.json"):
            data = self._load_json(file_path)
            if data:
                original = data.get("importance", 0.5)
                self.apply_decay([data], decay_rate, half_life_days)
                if data.get("importance") != original:
                    self._atomic_write(file_path, data)
                    updated += 1

        return updated

    # -------------------------------------------------------------------------
    # Namespace Management
    # -------------------------------------------------------------------------

    def list_namespaces(self) -> List[str]:
        """
        List all available namespaces in the memory system.

        Returns:
            List of namespace names
        """
        namespaces = []

        # Check for namespace directories
        if self._root_path.exists():
            for item in self._root_path.iterdir():
                if item.is_dir() and not item.name.startswith("."):
                    # Check if it looks like a namespace (has memory subdirs)
                    has_memory_dirs = any(
                        (item / subdir).exists()
                        for subdir in ["episodic", "semantic", "skills"]
                    )
                    if has_memory_dirs:
                        namespaces.append(item.name)

        # Also check if root has direct memory dirs (default namespace)
        has_root_memory = any(
            (self._root_path / subdir).exists()
            for subdir in ["episodic", "semantic", "skills"]
        )
        if has_root_memory and DEFAULT_NAMESPACE not in namespaces:
            namespaces.insert(0, DEFAULT_NAMESPACE)

        return sorted(namespaces)

    def get_namespace_stats(self, namespace: Optional[str] = None) -> Dict[str, Any]:
        """
        Get statistics for a specific namespace.

        Args:
            namespace: Namespace to get stats for (uses current if None)

        Returns:
            Dictionary with episode, pattern, and skill counts
        """
        storage = self if namespace is None else self.with_namespace(namespace)

        # Count episodes
        episode_count = 0
        episodic_dir = storage.base_path / "episodic"
        if episodic_dir.exists():
            for date_dir in episodic_dir.iterdir():
                if date_dir.is_dir():
                    episode_count += len(list(date_dir.glob("task-*.json")))

        # Count patterns
        pattern_count = 0
        patterns_path = storage.base_path / "semantic" / "patterns.json"
        if patterns_path.exists():
            patterns_data = storage._load_json(patterns_path)
            if patterns_data:
                pattern_count = len(patterns_data.get("patterns", []))

        # Count skills
        skill_count = 0
        skills_dir = storage.base_path / "skills"
        if skills_dir.exists():
            skill_count = len(list(skills_dir.glob("*.json")))

        return {
            "namespace": namespace or self._namespace or DEFAULT_NAMESPACE,
            "episode_count": episode_count,
            "pattern_count": pattern_count,
            "skill_count": skill_count,
            "total_count": episode_count + pattern_count + skill_count,
            "path": str(storage.base_path),
        }

    def copy_to_namespace(
        self,
        target_namespace: str,
        include_episodes: bool = True,
        include_patterns: bool = True,
        include_skills: bool = True,
    ) -> Dict[str, int]:
        """
        Copy memories from current namespace to target namespace.

        Args:
            target_namespace: Namespace to copy to
            include_episodes: Copy episodic memories
            include_patterns: Copy semantic patterns
            include_skills: Copy procedural skills

        Returns:
            Dictionary with counts of copied items
        """
        target = self.with_namespace(target_namespace)
        copied = {"episodes": 0, "patterns": 0, "skills": 0}

        # Copy episodes
        if include_episodes:
            for episode_id in self.list_episodes(limit=10000):
                episode = self.load_episode(episode_id)
                if episode:
                    target.save_episode(episode)
                    copied["episodes"] += 1

        # Copy patterns
        if include_patterns:
            for pattern_id in self.list_patterns():
                pattern = self.load_pattern(pattern_id)
                if pattern:
                    target.save_pattern(pattern)
                    copied["patterns"] += 1

        # Copy skills
        if include_skills:
            for skill_id in self.list_skills():
                skill = self.load_skill(skill_id)
                if skill:
                    target.save_skill(skill)
                    copied["skills"] += 1

        return copied

    def merge_from_namespace(
        self,
        source_namespace: str,
        deduplicate: bool = True,
    ) -> Dict[str, int]:
        """
        Merge memories from another namespace into current namespace.

        Args:
            source_namespace: Namespace to merge from
            deduplicate: Skip items that already exist (by ID)

        Returns:
            Dictionary with counts of merged items
        """
        source = self.with_namespace(source_namespace)
        merged = {"episodes": 0, "patterns": 0, "skills": 0}

        # Get existing IDs for deduplication
        existing_episodes = set(self.list_episodes(limit=10000)) if deduplicate else set()
        existing_patterns = set(self.list_patterns()) if deduplicate else set()
        existing_skills = set(self.list_skills()) if deduplicate else set()

        # Merge episodes
        for episode_id in source.list_episodes(limit=10000):
            if episode_id not in existing_episodes:
                episode = source.load_episode(episode_id)
                if episode:
                    self.save_episode(episode)
                    merged["episodes"] += 1

        # Merge patterns
        for pattern_id in source.list_patterns():
            if pattern_id not in existing_patterns:
                pattern = source.load_pattern(pattern_id)
                if pattern:
                    self.save_pattern(pattern)
                    merged["patterns"] += 1

        # Merge skills
        for skill_id in source.list_skills():
            if skill_id not in existing_skills:
                skill = source.load_skill(skill_id)
                if skill:
                    self.save_skill(skill)
                    merged["skills"] += 1

        return merged
