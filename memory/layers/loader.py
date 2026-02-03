"""
Progressive Loader - Multi-Layer Memory Loading

Implements the progressive disclosure algorithm that loads memory
content layer by layer, minimizing token usage while maximizing
relevance.

Loading sequence:
1. Layer 1 (Index): Load topic summaries (~100 tokens)
2. Layer 2 (Timeline): Load recent context for relevant topics (~500 tokens)
3. Layer 3 (Full): Load complete memories only when needed (variable)
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional, Set

from .index_layer import IndexLayer, Topic
from .timeline_layer import TimelineLayer


@dataclass
class TokenMetrics:
    """
    Tracks token usage across progressive disclosure layers.

    Attributes:
        layer1_tokens: Tokens used by index layer
        layer2_tokens: Tokens used by timeline layer
        layer3_tokens: Tokens used by full memory layer
        total_tokens: Sum of all layer tokens
        estimated_savings_percent: Estimated token savings vs loading all
    """
    layer1_tokens: int = 0
    layer2_tokens: int = 0
    layer3_tokens: int = 0
    total_tokens: int = 0
    estimated_savings_percent: float = 0.0

    def calculate_savings(self, total_available: int) -> None:
        """
        Calculate estimated savings percentage.

        Args:
            total_available: Total tokens if all memories were loaded
        """
        if total_available > 0:
            used = self.layer1_tokens + self.layer2_tokens + self.layer3_tokens
            self.total_tokens = used
            savings = ((total_available - used) / total_available) * 100
            self.estimated_savings_percent = round(max(0, savings), 1)
        else:
            self.total_tokens = self.layer1_tokens + self.layer2_tokens + self.layer3_tokens
            self.estimated_savings_percent = 0.0


class ProgressiveLoader:
    """
    Progressive memory loader with 3-layer disclosure.

    Optimizes context window usage by loading only the minimum
    amount of memory content needed to answer a query.
    """

    DEFAULT_MAX_TOKENS = 2000
    RELEVANCE_THRESHOLD = 0.5
    HIGH_RELEVANCE_THRESHOLD = 0.8

    def __init__(
        self,
        base_path: str,
        index_layer: IndexLayer,
        timeline_layer: TimelineLayer
    ):
        """
        Initialize the progressive loader.

        Args:
            base_path: Base directory for memory storage
            index_layer: IndexLayer instance for topic lookup
            timeline_layer: TimelineLayer instance for timeline context
        """
        self.base_path = Path(base_path)
        self.index_layer = index_layer
        self.timeline_layer = timeline_layer
        self._metrics = TokenMetrics()
        self._storage = None  # Lazy loaded

    def _get_storage(self):
        """Get or create storage instance for loading full memories."""
        if self._storage is None:
            try:
                from ..storage import MemoryStorage
                self._storage = MemoryStorage(str(self.base_path))
            except ImportError:
                self._storage = None
        return self._storage

    def load_relevant_context(
        self,
        query: str,
        max_tokens: int = DEFAULT_MAX_TOKENS
    ) -> Tuple[List[Dict[str, Any]], TokenMetrics]:
        """
        Load relevant context using progressive disclosure.

        Loading sequence:
        1. Load Layer 1 (index) to find relevant topics
        2. If relevant topics found, load Layer 2 (timeline) for those topics
        3. If more detail needed and budget allows, load Layer 3 (full memories)

        Args:
            query: The query to find relevant context for
            max_tokens: Maximum tokens to use across all layers

        Returns:
            Tuple of (list of relevant memories, token metrics)
        """
        self._metrics = TokenMetrics()
        memories: List[Dict[str, Any]] = []
        remaining_tokens = max_tokens

        # Layer 1: Load index
        index = self.index_layer.load()
        layer1_tokens = self.index_layer.get_token_count()
        self._metrics.layer1_tokens = layer1_tokens
        remaining_tokens -= layer1_tokens

        if remaining_tokens <= 0:
            self._metrics.calculate_savings(index.get("total_tokens_available", 0))
            return memories, self._metrics

        # Find relevant topics
        relevant_topics = self.index_layer.find_relevant_topics(
            query,
            threshold=self.RELEVANCE_THRESHOLD
        )

        if not relevant_topics:
            self._metrics.calculate_savings(index.get("total_tokens_available", 0))
            return memories, self._metrics

        # Layer 2: Load timeline for relevant topics
        timeline = self.timeline_layer.load()
        layer2_tokens = self.timeline_layer.get_token_count()
        self._metrics.layer2_tokens = layer2_tokens
        remaining_tokens -= layer2_tokens

        # Collect timeline context for each relevant topic
        topic_ids = {t.id for t in relevant_topics}
        timeline_context: Dict[str, List[Dict[str, Any]]] = {}

        for topic in relevant_topics:
            topic_entries = self.timeline_layer.get_recent_for_topic(topic.id)
            if topic_entries:
                timeline_context[topic.id] = topic_entries

        # Check if timeline provides sufficient context
        if self.sufficient_context(timeline_context, query):
            # Add timeline entries as context
            for topic_id, entries in timeline_context.items():
                for entry in entries:
                    memories.append({
                        "id": topic_id,
                        "type": "timeline",
                        "content": entry,
                    })
            self._metrics.calculate_savings(index.get("total_tokens_available", 0))
            return memories, self._metrics

        # Layer 3: Load full memories for high-relevance topics
        if remaining_tokens > 0:
            # Sort topics by relevance
            high_relevance = [
                t for t in relevant_topics
                if t.relevance_score >= self.HIGH_RELEVANCE_THRESHOLD
            ]

            storage = self._get_storage()
            loaded_tokens = 0

            for topic in high_relevance:
                # Check token budget
                if topic.token_count > remaining_tokens:
                    continue

                # Load full memory
                full_memory = self._load_full_memory(topic.id, storage)
                if full_memory:
                    memories.append(full_memory)
                    loaded_tokens += topic.token_count
                    remaining_tokens -= topic.token_count

                if remaining_tokens <= 0:
                    break

            self._metrics.layer3_tokens = loaded_tokens

        self._metrics.calculate_savings(index.get("total_tokens_available", 0))
        return memories, self._metrics

    def _load_full_memory(
        self,
        topic_id: str,
        storage: Optional[Any] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Load full memory content for a topic.

        Args:
            topic_id: The topic ID to load
            storage: Optional MemoryStorage instance

        Returns:
            Full memory dictionary or None
        """
        if storage is None:
            storage = self._get_storage()

        if storage is None:
            return None

        # Try loading as episode
        episode = storage.load_episode(topic_id)
        if episode:
            return {"id": topic_id, "type": "episode", "content": episode}

        # Try loading as pattern
        pattern = storage.load_pattern(topic_id)
        if pattern:
            return {"id": topic_id, "type": "pattern", "content": pattern}

        # Try loading as skill
        skill = storage.load_skill(topic_id)
        if skill:
            return {"id": topic_id, "type": "skill", "content": skill}

        return None

    def sufficient_context(
        self,
        memories: Any,
        query: str
    ) -> bool:
        """
        Determine if current memories provide sufficient context.

        Uses heuristics to decide if more detail is needed:
        - If no memories, insufficient
        - If query is simple and we have timeline context, sufficient
        - If query mentions specific details, may need full memories

        Args:
            memories: List of memories or dict of timeline context
            query: The original query

        Returns:
            True if context is sufficient, False if more detail needed
        """
        if not memories:
            return False

        # Convert dict to list if needed
        if isinstance(memories, dict):
            memory_list = []
            for entries in memories.values():
                memory_list.extend(entries)
        else:
            memory_list = memories

        # Simple heuristic: if we have 3+ relevant entries, likely sufficient
        if len(memory_list) >= 3:
            return True

        # Check for detail-seeking queries
        detail_keywords = [
            "exactly", "specifically", "details", "full",
            "complete", "all", "everything", "entire"
        ]
        query_lower = query.lower()

        for keyword in detail_keywords:
            if keyword in query_lower:
                return False

        # Default: if we have any context, try with it first
        return len(memory_list) > 0

    def track_token_usage(self, layer: int, tokens: int) -> None:
        """
        Track token usage for a specific layer.

        Args:
            layer: Layer number (1, 2, or 3)
            tokens: Number of tokens used
        """
        if layer == 1:
            self._metrics.layer1_tokens += tokens
        elif layer == 2:
            self._metrics.layer2_tokens += tokens
        elif layer == 3:
            self._metrics.layer3_tokens += tokens

        self._metrics.total_tokens = (
            self._metrics.layer1_tokens +
            self._metrics.layer2_tokens +
            self._metrics.layer3_tokens
        )

    def get_token_metrics(self) -> TokenMetrics:
        """
        Get current token usage metrics.

        Returns:
            TokenMetrics with usage across all layers
        """
        return self._metrics

    def reset_metrics(self) -> None:
        """Reset token metrics to zero."""
        self._metrics = TokenMetrics()

    def get_layer_summary(self) -> Dict[str, Any]:
        """
        Get a summary of current layer usage.

        Returns:
            Dictionary with layer counts and percentages
        """
        total = self._metrics.total_tokens or 1  # Avoid division by zero

        return {
            "layer1": {
                "tokens": self._metrics.layer1_tokens,
                "percent": round(self._metrics.layer1_tokens / total * 100, 1),
                "description": "Index - topic summaries",
            },
            "layer2": {
                "tokens": self._metrics.layer2_tokens,
                "percent": round(self._metrics.layer2_tokens / total * 100, 1),
                "description": "Timeline - recent actions and decisions",
            },
            "layer3": {
                "tokens": self._metrics.layer3_tokens,
                "percent": round(self._metrics.layer3_tokens / total * 100, 1),
                "description": "Full - complete memory content",
            },
            "total_tokens": self._metrics.total_tokens,
            "estimated_savings_percent": self._metrics.estimated_savings_percent,
        }
