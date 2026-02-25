"""
Loki Mode Memory System - Core Data Schemas

This module defines the dataclasses for the memory system:
- EpisodeTrace: Specific interaction traces (episodic memory)
- SemanticPattern: Generalized patterns (semantic memory)
- ProceduralSkill: Reusable skills (procedural memory)

See references/memory-system.md for full documentation.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any


def _to_utc_isoformat(dt: datetime) -> str:
    """Convert datetime to UTC ISO 8601 string with Z suffix.

    Handles both timezone-aware and timezone-naive datetimes,
    and avoids double-suffixing if already has timezone info.
    """
    iso = dt.isoformat()
    # If already has timezone offset like +00:00, replace with Z
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    # If no timezone info, append Z (assumed UTC)
    if not iso.endswith("Z") and "+" not in iso and iso.count("-") <= 2:
        return iso + "Z"
    return iso


def _parse_utc_datetime(s: str) -> datetime:
    """Parse an ISO 8601 string into a timezone-aware UTC datetime.

    Handles trailing 'Z', '+00:00', and naive strings (assumed UTC).
    """
    if s.endswith("Z"):
        s = s[:-1]
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# -----------------------------------------------------------------------------
# Supporting Types
# -----------------------------------------------------------------------------


@dataclass
class ActionEntry:
    """
    A single action taken during task execution.

    Attributes:
        tool: The tool or action type used (e.g., "read_file", "write_file")
        input: The input parameters for the action
        output: The result or output of the action
        timestamp: When the action occurred (relative seconds from start)
    """
    tool: str
    input: str
    output: str
    timestamp: int  # Relative seconds from episode start

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "t": self.timestamp,
            "action": self.tool,
            "target": self.input,
            "result": self.output,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ActionEntry:
        """Create from dictionary."""
        return cls(
            tool=data.get("action", data.get("tool", "")),
            input=data.get("target", data.get("input", "")),
            output=data.get("result", data.get("output", "")),
            timestamp=data.get("t", data.get("timestamp", 0)),
        )

    def validate(self) -> List[str]:
        """Validate the entry. Returns list of error messages."""
        errors = []
        if not self.tool:
            errors.append("ActionEntry.tool is required")
        if self.timestamp < 0:
            errors.append("ActionEntry.timestamp must be non-negative")
        return errors


@dataclass
class ErrorEntry:
    """
    An error encountered during task execution.

    Attributes:
        error_type: Category of error (e.g., "TypeScript compilation")
        message: The error message
        resolution: How the error was resolved
    """
    error_type: str
    message: str
    resolution: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "type": self.error_type,
            "message": self.message,
            "resolution": self.resolution,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ErrorEntry:
        """Create from dictionary."""
        return cls(
            error_type=data.get("type", data.get("error_type", "")),
            message=data.get("message", ""),
            resolution=data.get("resolution", ""),
        )

    def validate(self) -> List[str]:
        """Validate the entry. Returns list of error messages."""
        errors = []
        if not self.error_type:
            errors.append("ErrorEntry.error_type is required")
        if not self.message:
            errors.append("ErrorEntry.message is required")
        return errors


@dataclass
class Link:
    """
    A Zettelkasten-style link between memory entries.

    Attributes:
        to_id: ID of the linked memory entry
        relation: Type of relationship (derived_from, related_to, contradicts,
                  elaborates, example_of, supersedes, superseded_by)
        strength: Strength of the link (0.0 to 1.0)
    """
    to_id: str
    relation: str
    strength: float = 1.0

    VALID_RELATIONS = [
        "derived_from",
        "related_to",
        "contradicts",
        "elaborates",
        "example_of",
        "supersedes",
        "superseded_by",
        "supports",
    ]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "to": self.to_id,
            "relation": self.relation,
            "strength": self.strength,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Link:
        """Create from dictionary."""
        return cls(
            to_id=data.get("to", data.get("to_id", "")),
            relation=data.get("relation", ""),
            strength=data.get("strength", 1.0),
        )

    def validate(self) -> List[str]:
        """Validate the link. Returns list of error messages."""
        errors = []
        if not self.to_id:
            errors.append("Link.to_id is required")
        if self.relation not in self.VALID_RELATIONS:
            errors.append(
                f"Link.relation must be one of: {', '.join(self.VALID_RELATIONS)}"
            )
        if not 0.0 <= self.strength <= 1.0:
            errors.append("Link.strength must be between 0.0 and 1.0")
        return errors


@dataclass
class ErrorFix:
    """
    A common error and its fix for procedural skills.

    Attributes:
        error: Description of the error
        fix: How to fix it
    """
    error: str
    fix: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "error": self.error,
            "fix": self.fix,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ErrorFix:
        """Create from dictionary."""
        return cls(
            error=data.get("error", ""),
            fix=data.get("fix", ""),
        )

    def validate(self) -> List[str]:
        """Validate the entry. Returns list of error messages."""
        errors = []
        if not self.error:
            errors.append("ErrorFix.error is required")
        if not self.fix:
            errors.append("ErrorFix.fix is required")
        return errors


@dataclass
class TaskContext:
    """
    Context for a task execution.

    Attributes:
        goal: What the task is trying to accomplish
        phase: Current RARV phase (REASON, ACT, REFLECT, VERIFY)
        files: Files involved in the task
        constraints: Any constraints on the task
    """
    goal: str
    phase: str
    files: List[str] = field(default_factory=list)
    constraints: List[str] = field(default_factory=list)

    VALID_PHASES = ["REASON", "ACT", "REFLECT", "VERIFY"]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "goal": self.goal,
            "phase": self.phase,
            "files_involved": self.files,
            "constraints": self.constraints,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> TaskContext:
        """Create from dictionary."""
        return cls(
            goal=data.get("goal", ""),
            phase=data.get("phase", ""),
            files=data.get("files_involved", data.get("files", [])),
            constraints=data.get("constraints", []),
        )

    def validate(self) -> List[str]:
        """Validate the context. Returns list of error messages."""
        errors = []
        if not self.goal:
            errors.append("TaskContext.goal is required")
        if self.phase and self.phase not in self.VALID_PHASES:
            errors.append(
                f"TaskContext.phase must be one of: {', '.join(self.VALID_PHASES)}"
            )
        return errors


# -----------------------------------------------------------------------------
# Main Memory Types
# -----------------------------------------------------------------------------


@dataclass
class EpisodeTrace:
    """
    A specific interaction trace (episodic memory).

    Represents a complete record of a task execution, including
    all actions taken, errors encountered, and artifacts produced.

    Attributes:
        id: Unique identifier (e.g., "ep-2026-01-06-001")
        task_id: Reference to the task being executed
        timestamp: When the episode started
        duration_seconds: How long the episode took
        agent: Agent type that executed the task
        phase: RARV phase (REASON, ACT, REFLECT, VERIFY)
        goal: What the task was trying to accomplish
        action_log: List of actions taken
        outcome: Result of the task (success, failure, partial)
        errors_encountered: List of errors encountered
        artifacts_produced: List of files created
        git_commit: Git commit hash if applicable
        tokens_used: Number of tokens consumed
        files_read: List of files read during execution
        files_modified: List of files modified during execution
        importance: Importance score (0.0-1.0), decays over time
        last_accessed: When the memory was last accessed
        access_count: Number of times this memory has been accessed
    """
    id: str
    task_id: str
    timestamp: datetime
    duration_seconds: int
    agent: str
    phase: str
    goal: str
    action_log: List[ActionEntry] = field(default_factory=list)
    outcome: str = "success"
    errors_encountered: List[ErrorEntry] = field(default_factory=list)
    artifacts_produced: List[str] = field(default_factory=list)
    git_commit: Optional[str] = None
    tokens_used: int = 0
    files_read: List[str] = field(default_factory=list)
    files_modified: List[str] = field(default_factory=list)
    importance: float = 0.5
    last_accessed: Optional[datetime] = None
    access_count: int = 0

    VALID_OUTCOMES = ["success", "failure", "partial"]
    VALID_PHASES = ["REASON", "ACT", "REFLECT", "VERIFY"]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "id": self.id,
            "task_id": self.task_id,
            "timestamp": _to_utc_isoformat(self.timestamp),
            "duration_seconds": self.duration_seconds,
            "agent": self.agent,
            "context": {
                "phase": self.phase,
                "goal": self.goal,
                "files_involved": list(set(self.files_read + self.files_modified)),
            },
            "action_log": [a.to_dict() for a in self.action_log],
            "outcome": self.outcome,
            "errors_encountered": [e.to_dict() for e in self.errors_encountered],
            "artifacts_produced": self.artifacts_produced,
            "git_commit": self.git_commit,
            "tokens_used": self.tokens_used,
            "files_read": self.files_read,
            "files_modified": self.files_modified,
            "importance": self.importance,
            "access_count": self.access_count,
        }
        if self.last_accessed:
            result["last_accessed"] = _to_utc_isoformat(self.last_accessed)
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> EpisodeTrace:
        """Create from dictionary."""
        context = data.get("context", {})
        timestamp_str = data.get("timestamp", "")
        if isinstance(timestamp_str, str) and timestamp_str:
            timestamp = _parse_utc_datetime(timestamp_str)
        elif isinstance(timestamp_str, datetime):
            timestamp = timestamp_str
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
        else:
            timestamp = datetime.now(timezone.utc)

        # Parse last_accessed datetime
        last_accessed = None
        last_accessed_str = data.get("last_accessed")
        if last_accessed_str:
            if isinstance(last_accessed_str, str):
                last_accessed = _parse_utc_datetime(last_accessed_str)
            else:
                last_accessed = last_accessed_str
                if hasattr(last_accessed, 'tzinfo') and last_accessed.tzinfo is None:
                    last_accessed = last_accessed.replace(tzinfo=timezone.utc)

        return cls(
            id=data.get("id", ""),
            task_id=data.get("task_id", ""),
            timestamp=timestamp,
            duration_seconds=data.get("duration_seconds", 0),
            agent=data.get("agent", ""),
            phase=context.get("phase", data.get("phase", "")),
            goal=context.get("goal", data.get("goal", "")),
            action_log=[
                ActionEntry.from_dict(a) for a in data.get("action_log", [])
            ],
            outcome=data.get("outcome", "success"),
            errors_encountered=[
                ErrorEntry.from_dict(e) for e in data.get("errors_encountered", [])
            ],
            artifacts_produced=data.get("artifacts_produced", []),
            git_commit=data.get("git_commit"),
            tokens_used=data.get("tokens_used", 0),
            files_read=data.get("files_read", context.get("files_involved", [])),
            files_modified=data.get("files_modified", []),
            importance=data.get("importance", 0.5),
            last_accessed=last_accessed,
            access_count=data.get("access_count", 0),
        )

    def validate(self) -> List[str]:
        """Validate the episode trace. Returns list of error messages."""
        errors = []
        if not self.id:
            errors.append("EpisodeTrace.id is required")
        if not self.task_id:
            errors.append("EpisodeTrace.task_id is required")
        if not self.agent:
            errors.append("EpisodeTrace.agent is required")
        if not self.goal:
            errors.append("EpisodeTrace.goal is required")
        if self.phase and self.phase not in self.VALID_PHASES:
            errors.append(
                f"EpisodeTrace.phase must be one of: {', '.join(self.VALID_PHASES)}"
            )
        if self.outcome not in self.VALID_OUTCOMES:
            errors.append(
                f"EpisodeTrace.outcome must be one of: {', '.join(self.VALID_OUTCOMES)}"
            )
        if self.duration_seconds < 0:
            errors.append("EpisodeTrace.duration_seconds must be non-negative")
        if self.tokens_used < 0:
            errors.append("EpisodeTrace.tokens_used must be non-negative")
        if not 0.0 <= self.importance <= 1.0:
            errors.append("EpisodeTrace.importance must be between 0.0 and 1.0")
        if self.access_count < 0:
            errors.append("EpisodeTrace.access_count must be non-negative")

        # Validate nested entries
        for i, action in enumerate(self.action_log):
            action_errors = action.validate()
            for err in action_errors:
                errors.append(f"action_log[{i}]: {err}")

        for i, error in enumerate(self.errors_encountered):
            error_errors = error.validate()
            for err in error_errors:
                errors.append(f"errors_encountered[{i}]: {err}")

        return errors

    @classmethod
    def create(
        cls,
        task_id: str,
        agent: str,
        goal: str,
        phase: str = "ACT",
        id_prefix: str = "ep",
    ) -> EpisodeTrace:
        """Factory method to create a new episode trace with defaults."""
        now = datetime.now(timezone.utc)
        date_part = now.strftime("%Y-%m-%d")
        unique_id = str(uuid.uuid4())[:8]
        episode_id = f"{id_prefix}-{date_part}-{unique_id}"

        return cls(
            id=episode_id,
            task_id=task_id,
            timestamp=now,
            duration_seconds=0,
            agent=agent,
            phase=phase,
            goal=goal,
        )


@dataclass
class SemanticPattern:
    """
    A generalized pattern extracted from episodic memory (semantic memory).

    Represents knowledge that has been abstracted from specific experiences
    into reusable patterns.

    Attributes:
        id: Unique identifier (e.g., "sem-001")
        pattern: Description of the pattern
        category: Category (e.g., "error-handling", "testing", "architecture")
        conditions: When this pattern applies
        correct_approach: The right way to do it
        incorrect_approach: The anti-pattern to avoid
        confidence: How confident we are in this pattern (0-1)
        source_episodes: Episode IDs that contributed to this pattern
        usage_count: How many times this pattern has been used
        last_used: When the pattern was last applied
        links: Zettelkasten-style links to related patterns
        importance: Importance score (0.0-1.0), decays over time
        last_accessed: When the memory was last accessed
        access_count: Number of times this memory has been accessed
    """
    id: str
    pattern: str
    category: str
    conditions: List[str] = field(default_factory=list)
    correct_approach: str = ""
    incorrect_approach: str = ""
    confidence: float = 0.8
    source_episodes: List[str] = field(default_factory=list)
    usage_count: int = 0
    last_used: Optional[datetime] = None
    links: List[Link] = field(default_factory=list)
    importance: float = 0.5
    last_accessed: Optional[datetime] = None
    access_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "id": self.id,
            "pattern": self.pattern,
            "category": self.category,
            "conditions": self.conditions,
            "correct_approach": self.correct_approach,
            "incorrect_approach": self.incorrect_approach,
            "confidence": self.confidence,
            "source_episodes": self.source_episodes,
            "usage_count": self.usage_count,
            "links": [link.to_dict() for link in self.links],
            "importance": self.importance,
            "access_count": self.access_count,
        }
        if self.last_used:
            result["last_used"] = _to_utc_isoformat(self.last_used)
        if self.last_accessed:
            result["last_accessed"] = _to_utc_isoformat(self.last_accessed)
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> SemanticPattern:
        """Create from dictionary."""
        last_used = None
        if data.get("last_used"):
            last_used_str = data["last_used"]
            if isinstance(last_used_str, str):
                last_used = _parse_utc_datetime(last_used_str)
            elif isinstance(last_used_str, datetime):
                last_used = last_used_str
                if last_used.tzinfo is None:
                    last_used = last_used.replace(tzinfo=timezone.utc)

        last_accessed = None
        if data.get("last_accessed"):
            last_accessed_str = data["last_accessed"]
            if isinstance(last_accessed_str, str):
                last_accessed = _parse_utc_datetime(last_accessed_str)
            elif isinstance(last_accessed_str, datetime):
                last_accessed = last_accessed_str
                if last_accessed.tzinfo is None:
                    last_accessed = last_accessed.replace(tzinfo=timezone.utc)

        return cls(
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
            links=[Link.from_dict(link) for link in data.get("links", [])],
            importance=data.get("importance", 0.5),
            last_accessed=last_accessed,
            access_count=data.get("access_count", 0),
        )

    def validate(self) -> List[str]:
        """Validate the pattern. Returns list of error messages."""
        errors = []
        if not self.id:
            errors.append("SemanticPattern.id is required")
        if not self.pattern:
            errors.append("SemanticPattern.pattern is required")
        if not self.category:
            errors.append("SemanticPattern.category is required")
        if not 0.0 <= self.confidence <= 1.0:
            errors.append("SemanticPattern.confidence must be between 0.0 and 1.0")
        if self.usage_count < 0:
            errors.append("SemanticPattern.usage_count must be non-negative")
        if not 0.0 <= self.importance <= 1.0:
            errors.append("SemanticPattern.importance must be between 0.0 and 1.0")
        if self.access_count < 0:
            errors.append("SemanticPattern.access_count must be non-negative")

        # Validate links
        for i, link in enumerate(self.links):
            link_errors = link.validate()
            for err in link_errors:
                errors.append(f"links[{i}]: {err}")

        return errors

    @classmethod
    def create(
        cls,
        pattern: str,
        category: str,
        conditions: Optional[List[str]] = None,
        correct_approach: str = "",
        incorrect_approach: str = "",
        id_prefix: str = "sem",
    ) -> SemanticPattern:
        """Factory method to create a new semantic pattern."""
        unique_id = str(uuid.uuid4())[:8]
        pattern_id = f"{id_prefix}-{unique_id}"

        return cls(
            id=pattern_id,
            pattern=pattern,
            category=category,
            conditions=conditions or [],
            correct_approach=correct_approach,
            incorrect_approach=incorrect_approach,
            confidence=0.8,
            last_used=datetime.now(timezone.utc),
        )

    def increment_usage(self) -> None:
        """Record that this pattern was used."""
        self.usage_count += 1
        self.last_used = datetime.now(timezone.utc)

    def add_link(self, to_id: str, relation: str, strength: float = 1.0) -> None:
        """Add a Zettelkasten link to another pattern."""
        link = Link(to_id=to_id, relation=relation, strength=strength)
        link_errors = link.validate()
        if link_errors:
            raise ValueError(f"Invalid link: {'; '.join(link_errors)}")
        self.links.append(link)


@dataclass
class ProceduralSkill:
    """
    A reusable skill (procedural memory).

    Represents learned action sequences that can be reused
    across similar tasks.

    Attributes:
        id: Unique identifier (e.g., "skill-api-impl")
        name: Human-readable name of the skill
        description: What this skill does
        prerequisites: What must be true before using this skill
        steps: Ordered list of steps to execute
        common_errors: Errors that commonly occur and their fixes
        exit_criteria: How to know the skill completed successfully
        example_usage: Optional example of using this skill
        importance: Importance score (0.0-1.0), decays over time
        last_accessed: When the memory was last accessed
        access_count: Number of times this memory has been accessed
    """
    id: str
    name: str
    description: str
    prerequisites: List[str] = field(default_factory=list)
    steps: List[str] = field(default_factory=list)
    common_errors: List[ErrorFix] = field(default_factory=list)
    exit_criteria: List[str] = field(default_factory=list)
    example_usage: Optional[str] = None
    importance: float = 0.5
    last_accessed: Optional[datetime] = None
    access_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "prerequisites": self.prerequisites,
            "steps": self.steps,
            "common_errors": [e.to_dict() for e in self.common_errors],
            "exit_criteria": self.exit_criteria,
            "importance": self.importance,
            "access_count": self.access_count,
        }
        if self.example_usage:
            result["example_usage"] = self.example_usage
        if self.last_accessed:
            result["last_accessed"] = _to_utc_isoformat(self.last_accessed)
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ProceduralSkill:
        """Create from dictionary."""
        last_accessed = None
        if data.get("last_accessed"):
            last_accessed_str = data["last_accessed"]
            if isinstance(last_accessed_str, str):
                last_accessed = _parse_utc_datetime(last_accessed_str)
            elif isinstance(last_accessed_str, datetime):
                last_accessed = last_accessed_str
                if last_accessed.tzinfo is None:
                    last_accessed = last_accessed.replace(tzinfo=timezone.utc)

        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            description=data.get("description", ""),
            prerequisites=data.get("prerequisites", []),
            steps=data.get("steps", []),
            common_errors=[
                ErrorFix.from_dict(e) for e in data.get("common_errors", [])
            ],
            exit_criteria=data.get("exit_criteria", []),
            example_usage=data.get("example_usage"),
            importance=data.get("importance", 0.5),
            last_accessed=last_accessed,
            access_count=data.get("access_count", 0),
        )

    def validate(self) -> List[str]:
        """Validate the skill. Returns list of error messages."""
        errors = []
        if not self.id:
            errors.append("ProceduralSkill.id is required")
        if not self.name:
            errors.append("ProceduralSkill.name is required")
        if not self.description:
            errors.append("ProceduralSkill.description is required")
        if not self.steps:
            errors.append("ProceduralSkill.steps must have at least one step")
        if not 0.0 <= self.importance <= 1.0:
            errors.append("ProceduralSkill.importance must be between 0.0 and 1.0")
        if self.access_count < 0:
            errors.append("ProceduralSkill.access_count must be non-negative")

        # Validate common_errors
        for i, error_fix in enumerate(self.common_errors):
            ef_errors = error_fix.validate()
            for err in ef_errors:
                errors.append(f"common_errors[{i}]: {err}")

        return errors

    @classmethod
    def create(
        cls,
        name: str,
        description: str,
        steps: List[str],
        id_prefix: str = "skill",
    ) -> ProceduralSkill:
        """Factory method to create a new procedural skill."""
        # Generate ID from name: "API Implementation" -> "skill-api-implementation"
        slug = name.lower().replace(" ", "-").replace("_", "-")
        # Remove non-alphanumeric chars except hyphens
        slug = "".join(c for c in slug if c.isalnum() or c == "-")
        skill_id = f"{id_prefix}-{slug}"

        return cls(
            id=skill_id,
            name=name,
            description=description,
            steps=steps,
        )

    def add_error_fix(self, error: str, fix: str) -> None:
        """Add a common error and its fix."""
        self.common_errors.append(ErrorFix(error=error, fix=fix))
