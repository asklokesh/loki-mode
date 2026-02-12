"""
Loki Mode Memory System - Token Economics

This module tracks memory access efficiency and token usage.
It helps optimize memory retrieval by monitoring discovery vs read ratios
and triggering actions when thresholds are exceeded.

Key concepts:
- Discovery tokens: Tokens spent creating/indexing new memories
- Read tokens: Tokens spent retrieving/reading existing memories
- Layer loads: Tracking which memory layers are accessed (1=topic, 2=summary, 3=full)
- Cache hits/misses: Memory cache efficiency tracking
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------

THRESHOLDS = [
    {
        "metric": "ratio",
        "op": ">",
        "value": 0.15,
        "action": "compress_layer3",
        "priority": 1,
    },
    {
        "metric": "savings_percent",
        "op": "<",
        "value": 50,
        "action": "review_topic_relevance",
        "priority": 2,
    },
    {
        "metric": "layer3_loads",
        "op": ">",
        "value": 3,
        "action": "create_specialized_index",
        "priority": 3,
    },
    {
        "metric": "discovery_tokens",
        "op": ">",
        "value": 200,
        "action": "reorganize_topic_index",
        "priority": 4,
    },
]


# -----------------------------------------------------------------------------
# Action Dataclass
# -----------------------------------------------------------------------------


@dataclass
class Action:
    """
    An action to be taken based on threshold evaluation.

    Attributes:
        action_type: The type of action to take (e.g., "compress_layer3")
        priority: Priority level (lower = higher priority)
        description: Human-readable description of the action
        triggered_by: Which threshold triggered this action
    """

    action_type: str
    priority: int
    description: str
    triggered_by: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "action_type": self.action_type,
            "priority": self.priority,
            "description": self.description,
            "triggered_by": self.triggered_by,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Action:
        """Create from dictionary."""
        return cls(
            action_type=data.get("action_type", ""),
            priority=data.get("priority", 999),
            description=data.get("description", ""),
            triggered_by=data.get("triggered_by", ""),
        )


# -----------------------------------------------------------------------------
# Estimation Functions
# -----------------------------------------------------------------------------


def estimate_tokens(text: str) -> int:
    """
    Estimate the number of tokens in a text string.

    Uses a rough approximation of 4 characters per token, which is
    a common heuristic for English text with code mixed in.

    Args:
        text: The text to estimate tokens for

    Returns:
        Estimated token count
    """
    if not text:
        return 0
    return max(1, len(text) // 4)


def estimate_memory_tokens(memory: dict) -> int:
    """
    Estimate the number of tokens in a memory entry.

    Serializes the memory to JSON and estimates tokens from the result.

    Args:
        memory: A memory entry dictionary

    Returns:
        Estimated token count for the memory
    """
    if not memory:
        return 0
    try:
        json_str = json.dumps(memory, default=str)
        return estimate_tokens(json_str)
    except (TypeError, ValueError):
        return 0


def optimize_context(
    memories: list,
    budget: int,
    importance_weight: float = 0.4,
    recency_weight: float = 0.3,
    relevance_weight: float = 0.3,
) -> list:
    """
    Optimize memory selection to fit within token budget.

    Uses a weighted scoring approach prioritizing:
    - Importance (confidence, usage count)
    - Recency (recently accessed memories)
    - Relevance (pre-computed scores from retrieval)

    Implements progressive disclosure by preferring layer 1 (topic) data
    first, expanding to layer 2 (summary) and layer 3 (full) only if
    budget allows.

    Args:
        memories: List of memory dictionaries with optional fields:
            - _score: relevance score from retrieval
            - confidence: pattern confidence (0-1)
            - usage_count: how often this memory has been used
            - last_used: datetime of last access
            - timestamp: creation time
            - _layer: memory layer (1=topic, 2=summary, 3=full)
        budget: Maximum token budget
        importance_weight: Weight for importance scoring (default 0.4)
        recency_weight: Weight for recency scoring (default 0.3)
        relevance_weight: Weight for relevance scoring (default 0.3)

    Returns:
        List of memories that fit within the token budget, sorted by
        combined score.
    """
    from datetime import datetime, timezone

    if not memories:
        return []

    if budget <= 0:
        return []

    scored_memories = []
    now = datetime.now(timezone.utc)

    for memory in memories:
        # Calculate importance score (0-1)
        confidence = memory.get("confidence", 0.5)
        usage_count = memory.get("usage_count", 0)
        # Normalize usage count with diminishing returns
        usage_score = min(1.0, usage_count / 10.0) if usage_count > 0 else 0.0
        importance = (confidence + usage_score) / 2.0

        # Calculate recency score (0-1)
        recency = 0.5  # default
        timestamp = memory.get("last_used") or memory.get("timestamp")
        if timestamp:
            try:
                if isinstance(timestamp, str):
                    if timestamp.endswith("Z"):
                        timestamp = timestamp[:-1] + "+00:00"
                    item_time = datetime.fromisoformat(timestamp)
                else:
                    item_time = timestamp
                if item_time.tzinfo is None:
                    item_time = item_time.replace(tzinfo=timezone.utc)

                # Calculate age in days
                age_days = (now - item_time).days
                # Recency decays over 30 days
                recency = max(0.0, 1.0 - (age_days / 30.0))
            except (ValueError, TypeError):
                pass

        # Get relevance score (already computed by retrieval)
        relevance = memory.get("_score", 0.5)
        if relevance > 1.0:
            # Normalize high scores
            relevance = min(1.0, relevance / 10.0)

        # Calculate combined score
        combined_score = (
            importance * importance_weight +
            recency * recency_weight +
            relevance * relevance_weight
        )

        # Apply layer preference (layer 1 > layer 2 > layer 3)
        layer = memory.get("_layer", 2)  # default to layer 2
        layer_boost = {1: 1.1, 2: 1.0, 3: 0.9}.get(layer, 1.0)
        combined_score *= layer_boost

        # Estimate tokens for this memory
        tokens = estimate_memory_tokens(memory)

        scored_memories.append({
            "memory": memory,
            "score": combined_score,
            "tokens": tokens,
        })

    # Sort by score (highest first)
    scored_memories.sort(key=lambda x: x["score"], reverse=True)

    # Select memories that fit within budget
    selected = []
    total_tokens = 0

    for item in scored_memories:
        if total_tokens + item["tokens"] <= budget:
            selected.append(item["memory"])
            total_tokens += item["tokens"]
        elif item["tokens"] < budget * 0.1:
            # Allow small memories even if slightly over budget
            if total_tokens + item["tokens"] <= budget * 1.1:
                selected.append(item["memory"])
                total_tokens += item["tokens"]

    return selected


def get_context_efficiency(
    selected_memories: list,
    budget: int,
    total_available: int,
) -> dict:
    """
    Calculate context efficiency metrics.

    Args:
        selected_memories: Memories selected for context
        budget: Token budget used
        total_available: Total tokens if all memories were loaded

    Returns:
        Dictionary with efficiency metrics:
            - tokens_used: Actual tokens in selected memories
            - budget: The token budget
            - utilization: tokens_used / budget ratio
            - compression: tokens_used / total_available ratio
            - memories_selected: Count of selected memories
    """
    tokens_used = sum(estimate_memory_tokens(m) for m in selected_memories)

    utilization = tokens_used / budget if budget > 0 else 0.0
    compression = tokens_used / total_available if total_available > 0 else 1.0

    return {
        "tokens_used": tokens_used,
        "budget": budget,
        "utilization": round(utilization, 3),
        "compression": round(compression, 3),
        "memories_selected": len(selected_memories),
    }


def estimate_full_load_tokens(base_path: str) -> int:
    """
    Estimate the total tokens if all memories were loaded at once.

    Walks through all JSON files in the memory directories and
    sums up their estimated token counts.

    Args:
        base_path: Path to the memory base directory (e.g., ".loki/memory")

    Returns:
        Total estimated token count for full memory load
    """
    total_tokens = 0
    base = Path(base_path)

    if not base.exists():
        return 0

    # Walk through all subdirectories looking for JSON files
    memory_dirs = ["episodic", "semantic", "procedural", "skills"]

    for subdir in memory_dirs:
        subdir_path = base / subdir
        if not subdir_path.exists():
            continue

        for json_file in subdir_path.rglob("*.json"):
            try:
                content = json_file.read_text(encoding="utf-8")
                total_tokens += estimate_tokens(content)
            except (IOError, OSError):
                continue

    return total_tokens


# -----------------------------------------------------------------------------
# Threshold Evaluation Functions
# -----------------------------------------------------------------------------


def evaluate_thresholds(metrics: dict) -> List[Action]:
    """
    Evaluate metrics against thresholds and return triggered actions.

    Args:
        metrics: Dictionary containing metric values:
            - ratio: discovery/read ratio
            - savings_percent: percentage savings vs full load
            - layer3_loads: count of layer 3 memory loads
            - discovery_tokens: tokens used for discovery

    Returns:
        List of Action objects for thresholds that were triggered
    """
    actions = []

    for threshold in THRESHOLDS:
        metric_name = threshold["metric"]
        op = threshold["op"]
        value = threshold["value"]

        metric_value = metrics.get(metric_name)
        if metric_value is None:
            continue

        triggered = False
        if op == ">" and metric_value > value:
            triggered = True
        elif op == "<" and metric_value < value:
            triggered = True
        elif op == ">=" and metric_value >= value:
            triggered = True
        elif op == "<=" and metric_value <= value:
            triggered = True
        elif op == "==" and metric_value == value:
            triggered = True

        if triggered:
            description = _get_action_description(threshold["action"], metric_name, metric_value, value)
            action = Action(
                action_type=threshold["action"],
                priority=threshold["priority"],
                description=description,
                triggered_by=f"{metric_name} {op} {value} (actual: {metric_value})",
            )
            actions.append(action)

    return actions


def _get_action_description(action_type: str, metric: str, actual: float, threshold: float) -> str:
    """Generate a human-readable description for an action."""
    descriptions = {
        "compress_layer3": f"Discovery/read ratio ({actual:.2f}) exceeds {threshold}. Consider compressing layer 3 memories to reduce discovery overhead.",
        "review_topic_relevance": f"Savings ({actual:.1f}%) below {threshold}%. Review topic indexing to improve relevance matching.",
        "create_specialized_index": f"Layer 3 loads ({int(actual)}) exceed {int(threshold)}. Create specialized indexes for frequently accessed topics.",
        "reorganize_topic_index": f"Discovery tokens ({int(actual)}) exceed {int(threshold)}. Reorganize topic index for better coverage.",
    }
    return descriptions.get(action_type, f"Action triggered: {action_type}")


def prioritize_actions(actions: List[Action]) -> List[Action]:
    """
    Sort actions by priority (lower priority number = higher importance).

    Args:
        actions: List of Action objects

    Returns:
        Sorted list of Action objects
    """
    return sorted(actions, key=lambda a: a.priority)


# -----------------------------------------------------------------------------
# TokenEconomics Class
# -----------------------------------------------------------------------------


class TokenEconomics:
    """
    Tracks memory access efficiency and token usage for a session.

    This class monitors the balance between token expenditure on memory
    discovery (creating/indexing) vs memory retrieval (reading), and
    triggers optimization actions when thresholds are exceeded.

    Attributes:
        session_id: Unique identifier for this tracking session
        base_path: Path to the memory storage directory
        metrics: Dictionary of tracked metrics
    """

    def __init__(self, session_id: str, base_path: str = ".loki/memory"):
        """
        Initialize TokenEconomics tracker.

        Args:
            session_id: Unique identifier for this session
            base_path: Path to memory storage (default: ".loki/memory")
        """
        self.session_id = session_id
        self.base_path = base_path
        self.started_at = datetime.now(timezone.utc)

        self.metrics: Dict[str, int] = {
            "discovery_tokens": 0,
            "read_tokens": 0,
            "layer1_loads": 0,
            "layer2_loads": 0,
            "layer3_loads": 0,
            "cache_hits": 0,
            "cache_misses": 0,
        }

        self._full_load_baseline: Optional[int] = None

    def record_discovery(self, tokens: int) -> None:
        """
        Record tokens used for memory discovery/creation.

        Args:
            tokens: Number of tokens used
        """
        if tokens > 0:
            self.metrics["discovery_tokens"] += tokens

    def record_read(self, tokens: int, layer: int) -> None:
        """
        Record tokens used for memory retrieval and track layer access.

        Args:
            tokens: Number of tokens used
            layer: Memory layer accessed (1=topic, 2=summary, 3=full)
        """
        if tokens > 0:
            self.metrics["read_tokens"] += tokens

        if layer in (1, 2, 3):
            layer_key = f"layer{layer}_loads"
            self.metrics[layer_key] += 1

    def record_cache_hit(self) -> None:
        """Record a cache hit."""
        self.metrics["cache_hits"] += 1

    def record_cache_miss(self) -> None:
        """Record a cache miss."""
        self.metrics["cache_misses"] += 1

    def get_ratio(self) -> float:
        """
        Calculate the discovery to read token ratio.

        A lower ratio is better - it means we're spending more tokens
        on productive reads than on discovery overhead.

        Returns:
            Ratio of discovery_tokens / read_tokens (0.0 if no reads)
        """
        read_tokens = self.metrics["read_tokens"]
        if read_tokens == 0:
            return 0.0
        return self.metrics["discovery_tokens"] / read_tokens

    def get_savings_percent(self) -> float:
        """
        Calculate percentage savings vs loading all memories at once.

        Compares total tokens used (discovery + read) against the
        estimated cost of loading all memories completely.

        Returns:
            Percentage of tokens saved (0-100, can be negative if over baseline)
        """
        if self._full_load_baseline is None:
            self._full_load_baseline = estimate_full_load_tokens(self.base_path)

        if self._full_load_baseline == 0:
            return 100.0

        total_used = self.metrics["discovery_tokens"] + self.metrics["read_tokens"]
        savings = self._full_load_baseline - total_used
        return (savings / self._full_load_baseline) * 100

    def check_thresholds(self) -> List[Action]:
        """
        Check metrics against thresholds and return triggered actions.

        Returns:
            Sorted list of Action objects for triggered thresholds
        """
        check_metrics = {
            "ratio": self.get_ratio(),
            "savings_percent": self.get_savings_percent(),
            "layer3_loads": self.metrics["layer3_loads"],
            "discovery_tokens": self.metrics["discovery_tokens"],
        }

        actions = evaluate_thresholds(check_metrics)
        return prioritize_actions(actions)

    def get_summary(self) -> dict:
        """
        Get a summary of token economics for this session.

        Returns:
            Dictionary with session info, metrics, and computed values
        """
        return {
            "session_id": self.session_id,
            "started_at": self.started_at.isoformat(),
            "metrics": dict(self.metrics),
            "ratio": self.get_ratio(),
            "savings_percent": self.get_savings_percent(),
            "thresholds_triggered": [a.to_dict() for a in self.check_thresholds()],
        }

    def save(self) -> None:
        """
        Save token economics data to file.

        Writes to {base_path}/token_economics.json
        """
        file_path = Path(self.base_path) / "token_economics.json"
        file_path.parent.mkdir(parents=True, exist_ok=True)

        data = self.get_summary()

        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    def load(self) -> None:
        """
        Load token economics data from file.

        Reads from {base_path}/token_economics.json
        """
        file_path = Path(self.base_path) / "token_economics.json"

        if not file_path.exists():
            return

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            self.session_id = data.get("session_id", self.session_id)

            started_at_str = data.get("started_at", "")
            if started_at_str:
                if started_at_str.endswith("Z"):
                    started_at_str = started_at_str[:-1] + "+00:00"
                self.started_at = datetime.fromisoformat(started_at_str)
                if self.started_at.tzinfo is None:
                    self.started_at = self.started_at.replace(tzinfo=timezone.utc)

            loaded_metrics = data.get("metrics", {})
            for key in self.metrics:
                if key in loaded_metrics:
                    self.metrics[key] = loaded_metrics[key]

        except (json.JSONDecodeError, IOError, OSError):
            pass

    def reset(self) -> None:
        """Reset all metrics to zero."""
        for key in self.metrics:
            self.metrics[key] = 0
        self._full_load_baseline = None
        self.started_at = datetime.now(timezone.utc)
