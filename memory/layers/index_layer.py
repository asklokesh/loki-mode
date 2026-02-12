"""
Index Layer (Layer 1) - Progressive Disclosure

Provides lightweight topic index for quick relevance determination.
Target: ~100 tokens for the entire index.

This is the first layer loaded when processing a query, allowing
the system to quickly determine which topics are relevant without
loading full memory content.
"""

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional


@dataclass
class Topic:
    """
    A topic entry in the index.

    Attributes:
        id: Unique identifier for the topic
        summary: Brief summary of the topic content
        relevance_score: How relevant this topic is (0.0 to 1.0)
        token_count: Estimated tokens in the full memory
        last_accessed: When this topic was last accessed
    """
    id: str
    summary: str
    relevance_score: float = 0.5
    token_count: int = 0
    last_accessed: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "id": self.id,
            "summary": self.summary,
            "relevance_score": self.relevance_score,
            "token_count": self.token_count,
        }
        if self.last_accessed:
            result["last_accessed"] = self.last_accessed
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Topic":
        """Create from dictionary."""
        return cls(
            id=data.get("id", ""),
            summary=data.get("summary", ""),
            relevance_score=data.get("relevance_score", 0.5),
            token_count=data.get("token_count", 0),
            last_accessed=data.get("last_accessed"),
        )


class IndexLayer:
    """
    Layer 1: Topic Index (~100 tokens)

    Provides quick access to topic summaries and relevance scores
    for efficient memory retrieval decisions.
    """

    VERSION = "1.0"
    DEFAULT_THRESHOLD = 0.5

    def __init__(self, base_path: str = ".loki/memory"):
        """
        Initialize the index layer.

        Args:
            base_path: Base directory for memory storage
        """
        self.base_path = Path(base_path)
        self.index_path = self.base_path / "index.json"
        self._cache: Optional[Dict[str, Any]] = None

    def load(self) -> Dict[str, Any]:
        """
        Load index.json from disk.

        Returns:
            Index dictionary with version, topics, and metadata
        """
        if not self.index_path.exists():
            return self._create_empty_index()

        try:
            with open(self.index_path, "r") as f:
                self._cache = json.load(f)
                return self._cache
        except (json.JSONDecodeError, IOError):
            return self._create_empty_index()

    def _create_empty_index(self) -> Dict[str, Any]:
        """Create an empty index structure."""
        return {
            "version": self.VERSION,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "topics": [],
            "total_memories": 0,
            "total_tokens_available": 0,
        }

    def _save(self, index: Dict[str, Any]) -> None:
        """
        Save index to disk.

        Args:
            index: Index dictionary to save
        """
        self.base_path.mkdir(parents=True, exist_ok=True)
        index["last_updated"] = datetime.now(timezone.utc).isoformat()

        with open(self.index_path, "w") as f:
            json.dump(index, f, indent=2)

        self._cache = index

    def update(self, memories: List[Dict[str, Any]]) -> None:
        """
        Rebuild index from a list of memories.

        Args:
            memories: List of memory dictionaries with id, summary, etc.
        """
        topics = []
        total_tokens = 0

        for memory in memories:
            topic = Topic(
                id=memory.get("id", ""),
                summary=memory.get("summary", memory.get("description", "")[:100]),
                relevance_score=memory.get("relevance_score", memory.get("confidence", 0.5)),
                token_count=memory.get("token_count", self._estimate_tokens(memory)),
                last_accessed=memory.get("last_accessed"),
            )
            topics.append(topic.to_dict())
            total_tokens += topic.token_count

        index = {
            "version": self.VERSION,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "topics": topics,
            "total_memories": len(topics),
            "total_tokens_available": total_tokens,
        }

        self._save(index)

    def _estimate_tokens(self, memory: Dict[str, Any]) -> int:
        """
        Estimate token count for a memory.

        Uses rough approximation: 1 token per 4 characters.

        Args:
            memory: Memory dictionary

        Returns:
            Estimated token count
        """
        content = json.dumps(memory)
        return len(content) // 4

    def find_relevant_topics(
        self,
        query: str,
        threshold: float = DEFAULT_THRESHOLD
    ) -> List[Topic]:
        """
        Find topics relevant to a query.

        Uses simple keyword matching and relevance scores.
        For production, consider integrating with embeddings.

        Args:
            query: Search query string
            threshold: Minimum relevance score (0.0 to 1.0)

        Returns:
            List of Topic objects above the threshold
        """
        index = self.load()
        relevant = []

        query_lower = query.lower()
        query_words = set(query_lower.split())

        for topic_dict in index.get("topics", []):
            topic = Topic.from_dict(topic_dict)

            # Skip topics below threshold
            if topic.relevance_score < threshold:
                continue

            # Check for keyword matches in summary
            summary_lower = topic.summary.lower()
            summary_words = set(summary_lower.split())

            # Calculate match score based on word overlap
            common_words = query_words & summary_words
            if common_words:
                # Boost relevance based on word matches
                match_boost = len(common_words) / len(query_words) * 0.3
                topic.relevance_score = min(1.0, topic.relevance_score + match_boost)
                relevant.append(topic)
            elif topic.relevance_score >= 0.8:
                # Include high-relevance topics even without exact match
                relevant.append(topic)

        # Sort by relevance score, descending
        relevant.sort(key=lambda t: t.relevance_score, reverse=True)

        return relevant

    def get_token_count(self) -> int:
        """
        Get the token count for the current index.

        Returns:
            Estimated tokens for the index layer
        """
        index = self.load()
        # Estimate: JSON overhead + topic summaries
        content = json.dumps(index)
        return len(content) // 4

    def add_topic(self, topic: Dict[str, Any]) -> None:
        """
        Add a new topic to the index.

        Args:
            topic: Topic dictionary with id, summary, relevance_score, etc.
        """
        index = self.load()

        # Check if topic already exists
        existing_ids = {t.get("id") for t in index.get("topics", [])}
        if topic.get("id") in existing_ids:
            # Update existing topic
            for i, t in enumerate(index["topics"]):
                if t.get("id") == topic.get("id"):
                    index["topics"][i] = topic
                    break
        else:
            # Add new topic
            index["topics"].append(topic)
            index["total_memories"] = len(index["topics"])

        # Recalculate total tokens
        index["total_tokens_available"] = sum(
            t.get("token_count", 0) for t in index["topics"]
        )

        self._save(index)

    def remove_topic(self, topic_id: str) -> bool:
        """
        Remove a topic from the index.

        Args:
            topic_id: ID of the topic to remove

        Returns:
            True if removed, False if not found
        """
        index = self.load()
        original_count = len(index.get("topics", []))

        index["topics"] = [
            t for t in index.get("topics", [])
            if t.get("id") != topic_id
        ]

        if len(index["topics"]) < original_count:
            index["total_memories"] = len(index["topics"])
            index["total_tokens_available"] = sum(
                t.get("token_count", 0) for t in index["topics"]
            )
            self._save(index)
            return True

        return False

    def get_topics(self) -> List[Topic]:
        """
        Get all topics in the index.

        Returns:
            List of all Topic objects
        """
        index = self.load()
        return [Topic.from_dict(t) for t in index.get("topics", [])]
