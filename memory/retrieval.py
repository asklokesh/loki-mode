"""
Loki Mode Memory System - Task-Aware Memory Retrieval

Provides task-aware memory retrieval with multiple strategies based on
arXiv 2512.18746 (MemEvolve) finding that task-aware adaptation improves
performance by 17% over static weights.

Retrieval Strategies:
- exploration: Heavy episodic (0.6), moderate semantic (0.3)
- implementation: Heavy semantic (0.5), moderate skills (0.35)
- debugging: Balanced episodic/anti-patterns (0.4/0.4)
- review: Heavy semantic (0.5), moderate episodic (0.3)
- refactoring: Heavy semantic (0.45), moderate skills (0.3)

See references/memory-system.md for full documentation.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol, Tuple, Union, TYPE_CHECKING

# numpy is optional - only required for vector operations
try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    np = None  # type: ignore
    NUMPY_AVAILABLE = False

# Import from sibling modules
from .schemas import EpisodeTrace, SemanticPattern, ProceduralSkill
from .token_economics import estimate_memory_tokens, optimize_context, get_context_efficiency


# -----------------------------------------------------------------------------
# Type Definitions and Protocols
# -----------------------------------------------------------------------------


class EmbeddingEngine(Protocol):
    """Protocol for embedding engines."""

    def embed(self, text: str) -> Any:
        """Generate embedding for text. Returns numpy array if available."""
        ...

    def embed_batch(self, texts: List[str]) -> List[Any]:
        """Generate embeddings for multiple texts."""
        ...


class VectorIndex(Protocol):
    """Protocol for vector index backends."""

    def add(self, id: str, embedding: Any, metadata: Dict[str, Any]) -> None:
        """Add an embedding to the index."""
        ...

    def search(
        self,
        query: Any,
        top_k: int = 5,
        filters: Optional[Dict[str, Any]] = None,
    ) -> List[Tuple[str, float, Dict[str, Any]]]:
        """Search for similar embeddings. Returns (id, score, metadata) tuples."""
        ...

    def remove(self, id: str) -> bool:
        """Remove an embedding from the index."""
        ...

    def save(self, path: str) -> None:
        """Save the index to disk."""
        ...

    def load(self, path: str) -> None:
        """Load the index from disk."""
        ...


class MemoryStorageProtocol(Protocol):
    """Protocol for memory storage backends."""

    def read_json(self, filepath: str) -> Optional[Dict[str, Any]]:
        """Read JSON file and return contents."""
        ...

    def list_files(self, subpath: str, pattern: str = "*.json") -> List[Path]:
        """List files matching pattern in subdirectory."""
        ...

    def calculate_importance(
        self, memory: Dict[str, Any], task_type: Optional[str] = None
    ) -> float:
        """Calculate importance score for a memory."""
        ...

    def boost_on_retrieval(
        self, memory: Dict[str, Any], boost: float = 0.1
    ) -> Dict[str, Any]:
        """Boost importance when memory is retrieved."""
        ...


# -----------------------------------------------------------------------------
# Task Strategy Definitions
# -----------------------------------------------------------------------------


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


# Task type detection signals
TASK_SIGNALS: Dict[str, Dict[str, List[str]]] = {
    "exploration": {
        "keywords": [
            "explore",
            "understand",
            "research",
            "investigate",
            "analyze",
            "discover",
            "find",
            "what is",
            "how does",
            "architecture",
            "structure",
            "overview",
        ],
        "actions": ["read_file", "search", "list_files"],
        "phases": ["planning", "discovery", "research"],
    },
    "implementation": {
        "keywords": [
            "implement",
            "create",
            "build",
            "add",
            "write",
            "develop",
            "make",
            "construct",
            "new feature",
        ],
        "actions": ["write_file", "create_file", "edit_file"],
        "phases": ["development", "implementation", "coding"],
    },
    "debugging": {
        "keywords": [
            "fix",
            "debug",
            "error",
            "bug",
            "issue",
            "broken",
            "failing",
            "crash",
            "exception",
            "investigate error",
        ],
        "actions": ["run_test", "check_logs", "trace"],
        "phases": ["debugging", "troubleshooting", "fixing"],
    },
    "review": {
        "keywords": [
            "review",
            "check",
            "validate",
            "verify",
            "audit",
            "inspect",
            "quality",
            "standards",
            "lint",
        ],
        "actions": ["diff", "review_pr", "check_style"],
        "phases": ["review", "qa", "validation"],
    },
    "refactoring": {
        "keywords": [
            "refactor",
            "restructure",
            "reorganize",
            "clean up",
            "improve structure",
            "extract",
            "rename",
            "move",
        ],
        "actions": ["rename", "move_file", "extract_function"],
        "phases": ["refactoring", "cleanup", "optimization"],
    },
}


# -----------------------------------------------------------------------------
# Memory Retrieval Class
# -----------------------------------------------------------------------------


class MemoryRetrieval:
    """
    Task-aware memory retrieval with multiple strategies.

    Provides unified retrieval across episodic, semantic, and procedural
    memory with task-type-aware weighting. Supports both vector-based
    similarity search (when embeddings are available) and keyword-based
    fallback search.

    Supports namespace-based project isolation with:
    - Namespace-scoped retrieval (only current namespace)
    - Cross-namespace search (include parent/global namespaces)
    - Namespace inheritance (child can access parent memories)

    Attributes:
        storage: MemoryStorage instance for file I/O
        embedding_engine: Optional embedding engine for similarity search
        vector_indices: Dictionary of VectorIndex instances per collection
        base_path: Base path for memory storage
        namespace: Current namespace for scoped retrieval
    """

    def __init__(
        self,
        storage: MemoryStorageProtocol,
        embedding_engine: Optional[EmbeddingEngine] = None,
        vector_indices: Optional[Dict[str, VectorIndex]] = None,
        base_path: str = ".loki/memory",
        namespace: Optional[str] = None,
    ):
        """
        Initialize the memory retrieval system.

        Args:
            storage: MemoryStorage instance for reading memory files
            embedding_engine: Optional embedding engine for similarity search
            vector_indices: Optional dict of vector indices (episodic, semantic, skills)
            base_path: Base path for memory storage directory
            namespace: Optional namespace for scoped retrieval
        """
        self.storage = storage
        self.embedding_engine = embedding_engine
        self.vector_indices = vector_indices or {}
        self.base_path = Path(base_path)
        self._namespace = namespace

    @property
    def namespace(self) -> Optional[str]:
        """Get the current namespace."""
        return self._namespace

    def with_namespace(self, namespace: str) -> "MemoryRetrieval":
        """
        Create a new MemoryRetrieval instance with a different namespace.

        Args:
            namespace: The namespace to switch to

        Returns:
            New MemoryRetrieval instance for the specified namespace
        """
        # Get storage for the new namespace
        if hasattr(self.storage, 'with_namespace'):
            new_storage = self.storage.with_namespace(namespace)
        else:
            new_storage = self.storage

        return MemoryRetrieval(
            storage=new_storage,
            embedding_engine=self.embedding_engine,
            vector_indices=self.vector_indices,
            base_path=str(self.base_path),
            namespace=namespace,
        )

    # -------------------------------------------------------------------------
    # Task Detection
    # -------------------------------------------------------------------------

    def detect_task_type(self, context: Dict[str, Any]) -> str:
        """
        Detect task type from context using keyword signals and structural patterns.

        Analyzes the goal, action type, and phase fields in the context to
        determine the most likely task type.

        Args:
            context: Dictionary containing goal, action_type, phase, etc.

        Returns:
            One of: exploration, implementation, debugging, review, refactoring
        """
        goal = context.get("goal", "").lower()
        action = context.get("action_type", "").lower()
        phase = context.get("phase", "").lower()

        scores: Dict[str, int] = {}

        for task_type, signals in TASK_SIGNALS.items():
            score = 0

            # Keyword matches (weight: 2)
            for keyword in signals["keywords"]:
                if keyword in goal:
                    score += 2

            # Action matches (weight: 3)
            for action_signal in signals["actions"]:
                if action_signal in action:
                    score += 3

            # Phase matches (weight: 4 - strongest signal)
            for phase_signal in signals["phases"]:
                if phase_signal in phase:
                    score += 4

            scores[task_type] = score

        # Return highest scoring type, default to implementation
        best_type = max(scores, key=lambda k: scores[k])
        if scores[best_type] == 0:
            return "implementation"

        return best_type

    # -------------------------------------------------------------------------
    # Task-Aware Retrieval
    # -------------------------------------------------------------------------

    def retrieve_task_aware(
        self,
        context: Dict[str, Any],
        top_k: int = 5,
        token_budget: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve memories with task-type-aware weighting.

        Detects the task type from context and applies appropriate weights
        to retrieval from each memory collection.

        Args:
            context: Dictionary with query context (goal, task_type, phase, etc.)
            top_k: Maximum number of results to return
            token_budget: Optional maximum token budget for returned memories.
                         If specified, results will be optimized to fit within
                         this budget using importance/recency/relevance scoring.

        Returns:
            List of memory items with source field indicating origin
        """
        # Detect task type
        task_type = self.detect_task_type(context)
        weights = TASK_STRATEGIES.get(task_type, TASK_STRATEGIES["implementation"])

        # Build query from context
        query = self._build_query_from_context(context)

        # Retrieve from each collection based on weights
        results_by_collection: Dict[str, List[Dict[str, Any]]] = {}

        if weights.get("episodic", 0) > 0:
            episodic_k = max(1, int(top_k * 2))
            results_by_collection["episodic"] = self.retrieve_from_episodic(
                query, episodic_k
            )

        if weights.get("semantic", 0) > 0:
            semantic_k = max(1, int(top_k * 2))
            results_by_collection["semantic"] = self.retrieve_from_semantic(
                query, semantic_k
            )

        if weights.get("skills", 0) > 0:
            skills_k = max(1, int(top_k * 2))
            results_by_collection["skills"] = self.retrieve_from_skills(
                query, skills_k
            )

        if weights.get("anti_patterns", 0) > 0:
            anti_k = max(1, int(top_k * 2))
            results_by_collection["anti_patterns"] = self.retrieve_anti_patterns(
                query, anti_k
            )

        # Merge and rank results (including importance scoring)
        merged = self._merge_results(
            results_by_collection,
            weights,
            top_k * 2 if token_budget else top_k,
            task_type=task_type,
        )

        # Apply recency boost
        merged = self._apply_recency_boost(merged, boost_factor=0.1)

        # Boost importance for retrieved memories (use it or lose it)
        if hasattr(self.storage, 'boost_on_retrieval'):
            for memory in merged[:top_k]:
                self.storage.boost_on_retrieval(memory, boost=0.05)

        # Apply token budget optimization if specified
        if token_budget is not None and token_budget > 0:
            merged = optimize_context(merged, token_budget)

        return merged[:top_k]

    # -------------------------------------------------------------------------
    # Cross-Namespace Retrieval
    # -------------------------------------------------------------------------

    def retrieve_cross_namespace(
        self,
        context: Dict[str, Any],
        namespaces: List[str],
        top_k: int = 5,
        token_budget: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve memories from multiple namespaces.

        Searches across specified namespaces, merges results, and ranks
        by relevance. Useful for finding patterns that apply across projects.

        Args:
            context: Query context (goal, task_type, phase, etc.)
            namespaces: List of namespaces to search
            top_k: Maximum results per namespace (then merged)
            token_budget: Optional token budget for total results

        Returns:
            Merged and ranked list of memories with namespace annotations
        """
        all_results: List[Dict[str, Any]] = []

        for ns in namespaces:
            # Create retrieval instance for this namespace
            ns_retrieval = self.with_namespace(ns)

            # Retrieve from this namespace
            ns_results = ns_retrieval.retrieve_task_aware(
                context=context,
                top_k=top_k,
                token_budget=None,  # Apply budget after merge
            )

            # Annotate with namespace
            for result in ns_results:
                result["_namespace"] = ns
                # Slight penalty for non-current namespace
                if ns != self._namespace:
                    current_score = result.get("_weighted_score", 0.5)
                    result["_weighted_score"] = current_score * 0.9

            all_results.extend(ns_results)

        # Sort by weighted score
        all_results.sort(
            key=lambda x: x.get("_weighted_score", 0),
            reverse=True,
        )

        # Apply token budget if specified
        if token_budget is not None and token_budget > 0:
            all_results = optimize_context(all_results, token_budget)

        return all_results[:top_k * len(namespaces)]

    def retrieve_with_inheritance(
        self,
        context: Dict[str, Any],
        top_k: int = 5,
        include_global: bool = True,
        token_budget: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve memories following namespace inheritance chain.

        Searches current namespace first, then parent namespaces,
        finally global namespace. Results from more specific namespaces
        are prioritized.

        Args:
            context: Query context (goal, task_type, phase, etc.)
            top_k: Maximum results to return
            include_global: Whether to include global namespace
            token_budget: Optional token budget for results

        Returns:
            Merged results from inheritance chain
        """
        # Build namespace chain
        namespaces = [self._namespace or "default"]

        # Try to get parent namespaces from namespace manager
        try:
            from .namespace import NamespaceManager, GLOBAL_NAMESPACE
            manager = NamespaceManager(str(self.base_path))
            chain = manager.get_inheritance_chain(namespaces[0])
            namespaces = chain
        except ImportError:
            # Fallback: just use current and global
            if include_global:
                namespaces.append("global")

        if not include_global and "global" in namespaces:
            namespaces = [ns for ns in namespaces if ns != "global"]

        return self.retrieve_cross_namespace(
            context=context,
            namespaces=namespaces,
            top_k=top_k,
            token_budget=token_budget,
        )

    def search_all_namespaces(
        self,
        query: str,
        top_k: int = 10,
    ) -> List[Dict[str, Any]]:
        """
        Search across all available namespaces.

        Useful for finding global patterns or migrating knowledge
        between projects.

        Args:
            query: Search query string
            top_k: Maximum results to return

        Returns:
            Results from all namespaces with namespace annotations
        """
        all_results: List[Dict[str, Any]] = []

        # Get all namespaces from storage
        if hasattr(self.storage, 'list_namespaces'):
            namespaces = self.storage.list_namespaces()
        else:
            # Fallback: just search current
            namespaces = [self._namespace or "default"]

        for ns in namespaces:
            ns_retrieval = self.with_namespace(ns)

            # Simple keyword search in this namespace
            for collection in ["episodic", "semantic", "skills"]:
                results = ns_retrieval.retrieve_by_keyword(
                    query.split(),
                    collection,
                )
                for result in results:
                    result["_namespace"] = ns
                    result["_collection"] = collection
                all_results.extend(results)

        # Sort by score
        all_results.sort(
            key=lambda x: x.get("_score", 0),
            reverse=True,
        )

        return all_results[:top_k]

    # -------------------------------------------------------------------------
    # Collection-Specific Retrieval
    # -------------------------------------------------------------------------

    def retrieve_from_episodic(
        self,
        query: str,
        top_k: int = 5,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve from episodic memory collection.

        Args:
            query: Search query string
            top_k: Maximum number of results

        Returns:
            List of episodic memory items with scores
        """
        if self.embedding_engine and "episodic" in self.vector_indices:
            return self.retrieve_by_similarity(query, "episodic", top_k)

        return self.retrieve_by_keyword(query.split(), "episodic")[:top_k]

    def retrieve_from_semantic(
        self,
        query: str,
        top_k: int = 5,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve from semantic memory collection.

        Args:
            query: Search query string
            top_k: Maximum number of results

        Returns:
            List of semantic pattern items with scores
        """
        if self.embedding_engine and "semantic" in self.vector_indices:
            return self.retrieve_by_similarity(query, "semantic", top_k)

        return self.retrieve_by_keyword(query.split(), "semantic")[:top_k]

    def retrieve_from_skills(
        self,
        query: str,
        top_k: int = 5,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve from skills/procedural memory collection.

        Args:
            query: Search query string
            top_k: Maximum number of results

        Returns:
            List of skill items with scores
        """
        if self.embedding_engine and "skills" in self.vector_indices:
            return self.retrieve_by_similarity(query, "skills", top_k)

        return self.retrieve_by_keyword(query.split(), "skills")[:top_k]

    def retrieve_anti_patterns(
        self,
        query: str,
        top_k: int = 5,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve from anti-patterns collection.

        Args:
            query: Search query string
            top_k: Maximum number of results

        Returns:
            List of anti-pattern items with scores
        """
        if self.embedding_engine and "anti_patterns" in self.vector_indices:
            return self.retrieve_by_similarity(query, "anti_patterns", top_k)

        return self.retrieve_by_keyword(query.split(), "anti_patterns")[:top_k]

    # -------------------------------------------------------------------------
    # Multi-Modal Retrieval
    # -------------------------------------------------------------------------

    def retrieve_by_similarity(
        self,
        query: str,
        collection: str,
        top_k: int = 5,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve by semantic similarity using embeddings.

        Falls back to keyword search if embeddings are not available.

        Args:
            query: Search query text
            collection: Memory collection name
            top_k: Maximum number of results

        Returns:
            List of similar memory items
        """
        if self.embedding_engine is None:
            return self.retrieve_by_keyword(query.split(), collection)[:top_k]

        if collection not in self.vector_indices:
            return self.retrieve_by_keyword(query.split(), collection)[:top_k]

        # Generate query embedding
        query_embedding = self.embedding_engine.embed(query)

        # Search vector index
        index = self.vector_indices[collection]
        results = index.search(query_embedding, top_k)

        # Convert to standard format
        items: List[Dict[str, Any]] = []
        for item_id, score, metadata in results:
            item = metadata.copy()
            item["id"] = item_id
            item["_score"] = float(score)
            item["_source"] = collection
            items.append(item)

        return items

    def retrieve_by_temporal(
        self,
        since: datetime,
        until: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve memories within a time range.

        Searches across all collections for memories within the specified
        date range.

        Args:
            since: Start datetime (inclusive)
            until: End datetime (inclusive), defaults to now

        Returns:
            List of memories within the time range
        """
        until = until or datetime.now(timezone.utc)
        results: List[Dict[str, Any]] = []

        # Search episodic memories by date directory (via storage layer)
        date_dirs = self.storage.list_files("episodic", "*")
        for date_dir in date_dirs:
            if not date_dir.is_dir():
                continue

            try:
                dir_date = datetime.strptime(date_dir.name, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except ValueError:
                continue

            if since.date() <= dir_date.date() <= until.date():
                episode_files = self.storage.list_files(
                    f"episodic/{date_dir.name}", "*.json"
                )
                for episode_file in episode_files:
                    if episode_file.name == "index.json":
                        continue

                    data = self.storage.read_json(
                        f"episodic/{date_dir.name}/{episode_file.name}"
                    )
                    if data:
                        data["_source"] = "episodic"
                        results.append(data)

        # Filter semantic patterns by last_used
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}
        for pattern in patterns_data.get("patterns", []):
            last_used = pattern.get("last_used")
            if last_used:
                try:
                    if isinstance(last_used, str):
                        if last_used.endswith("Z"):
                            last_used = last_used[:-1] + "+00:00"
                        last_used_dt = datetime.fromisoformat(last_used)
                    else:
                        last_used_dt = last_used

                    # Ensure timezone-aware for comparison
                    if last_used_dt.tzinfo is None:
                        last_used_dt = last_used_dt.replace(tzinfo=timezone.utc)

                    if since <= last_used_dt <= until:
                        pattern["_source"] = "semantic"
                        results.append(pattern)
                except (ValueError, TypeError):
                    continue

        return results

    def retrieve_by_keyword(
        self,
        keywords: List[str],
        collection: str,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve memories by keyword matching.

        Simple keyword-based fallback when embeddings are not available.

        Args:
            keywords: List of keywords to search for
            collection: Memory collection to search

        Returns:
            List of matching memory items with scores
        """
        results: List[Dict[str, Any]] = []
        keywords_lower = [kw.lower() for kw in keywords]

        if collection == "episodic":
            results = self._keyword_search_episodic(keywords_lower)
        elif collection == "semantic":
            results = self._keyword_search_semantic(keywords_lower)
        elif collection == "skills":
            results = self._keyword_search_skills(keywords_lower)
        elif collection == "anti_patterns":
            results = self._keyword_search_anti_patterns(keywords_lower)

        # Sort by score descending
        results.sort(key=lambda x: x.get("_score", 0), reverse=True)
        return results

    # -------------------------------------------------------------------------
    # Scoring and Ranking
    # -------------------------------------------------------------------------

    def _score_result(
        self,
        result: Dict[str, Any],
        weights: Dict[str, float],
        task_type: Optional[str] = None,
    ) -> float:
        """
        Calculate weighted score for a result, factoring in importance.

        The score combines:
        - Base relevance score from keyword/vector matching
        - Task strategy weights for the memory collection
        - Memory importance score (0.0-1.0)
        - Confidence factor for semantic patterns

        Args:
            result: Memory item with _source and _score fields
            weights: Task strategy weights
            task_type: Optional task type for relevance calculation

        Returns:
            Weighted score incorporating importance
        """
        source = result.get("_source", "")
        base_score = result.get("_score", 0.5)

        # Map source to weight key
        weight_key = source
        if source == "procedural":
            weight_key = "skills"

        weight = weights.get(weight_key, 0.0)

        # Get importance score (default 0.5 if not set)
        importance = result.get("importance", 0.5)

        # Get confidence for semantic patterns
        confidence = result.get("confidence", 1.0)

        # Combined score: relevance * task_weight * importance * confidence
        # Importance contributes 30% of the final score
        importance_factor = 0.7 + (0.3 * importance)
        score = base_score * weight * importance_factor * confidence

        return score

    def _merge_results(
        self,
        results_by_collection: Dict[str, List[Dict[str, Any]]],
        weights: Dict[str, float],
        top_k: int,
        task_type: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Merge and rank results from multiple collections.

        Results are ranked by a combined score that factors in:
        - Relevance to query (base score)
        - Task strategy weights
        - Memory importance (with decay)
        - Confidence (for patterns)

        Args:
            results_by_collection: Results grouped by collection name
            weights: Task strategy weights
            top_k: Maximum number of results
            task_type: Optional task type for importance calculation

        Returns:
            Merged and ranked list of results
        """
        all_results: List[Dict[str, Any]] = []

        for collection, items in results_by_collection.items():
            for item in items:
                # Ensure source is set
                if "_source" not in item:
                    item["_source"] = collection

                # Calculate weighted score with importance
                item["_weighted_score"] = self._score_result(item, weights, task_type)
                all_results.append(item)

        # Sort by weighted score
        all_results.sort(key=lambda x: x.get("_weighted_score", 0), reverse=True)

        return all_results[:top_k]

    def _apply_recency_boost(
        self,
        results: List[Dict[str, Any]],
        boost_factor: float = 0.1,
    ) -> List[Dict[str, Any]]:
        """
        Apply recency boost to results.

        More recent items get a score boost.

        Args:
            results: List of memory items
            boost_factor: Maximum boost for most recent items (0.1 = 10%)

        Returns:
            Results with recency boost applied
        """
        now = datetime.now(timezone.utc)

        for result in results:
            timestamp = result.get("timestamp") or result.get("last_used")
            if not timestamp:
                continue

            try:
                if isinstance(timestamp, str):
                    if timestamp.endswith("Z"):
                        timestamp = timestamp[:-1] + "+00:00"
                    item_time = datetime.fromisoformat(timestamp)
                else:
                    item_time = timestamp

                # Ensure timezone-aware for comparison with UTC now
                if item_time.tzinfo is None:
                    item_time = item_time.replace(tzinfo=timezone.utc)

                # Calculate age in days
                age_days = (now - item_time).days

                # Boost decays linearly over 30 days
                if age_days < 30:
                    boost = boost_factor * (1 - age_days / 30)
                    current_score = result.get("_weighted_score", result.get("_score", 0.5))
                    result["_weighted_score"] = current_score * (1 + boost)

            except (ValueError, TypeError):
                continue

        # Re-sort after applying boost
        results.sort(key=lambda x: x.get("_weighted_score", 0), reverse=True)
        return results

    # -------------------------------------------------------------------------
    # Token Budget Optimization
    # -------------------------------------------------------------------------

    def retrieve_with_budget(
        self,
        context: Dict[str, Any],
        token_budget: int,
        progressive: bool = True,
    ) -> Dict[str, Any]:
        """
        Retrieve memories optimized for a specific token budget.

        Uses progressive disclosure: starts with layer 1 (topic index),
        expands to layer 2 (summaries) if budget allows, and finally
        layer 3 (full details) for highest priority items.

        Args:
            context: Query context (goal, phase, action_type, etc.)
            token_budget: Maximum tokens to use for context
            progressive: If True, use progressive disclosure layers.
                        If False, retrieve all available data and trim.

        Returns:
            Dictionary with:
                - memories: List of selected memories
                - metrics: Token usage and efficiency metrics
                - task_type: Detected task type
        """
        task_type = self.detect_task_type(context)

        if progressive:
            return self._progressive_retrieve(context, token_budget, task_type)
        else:
            # Standard retrieval with budget optimization
            memories = self.retrieve_task_aware(context, top_k=50, token_budget=token_budget)

            # Calculate efficiency metrics
            total_available = self._estimate_total_available_tokens()
            metrics = get_context_efficiency(memories, token_budget, total_available)

            return {
                "memories": memories,
                "metrics": metrics,
                "task_type": task_type,
            }

    def _progressive_retrieve(
        self,
        context: Dict[str, Any],
        token_budget: int,
        task_type: str,
    ) -> Dict[str, Any]:
        """
        Implement progressive disclosure retrieval.

        Layer 1: Topic index only (minimal tokens)
        Layer 2: Add summaries for relevant topics
        Layer 3: Expand full details for highest priority items
        """
        weights = TASK_STRATEGIES.get(task_type, TASK_STRATEGIES["implementation"])
        query = self._build_query_from_context(context)

        # Track budget usage
        budget_remaining = token_budget
        selected_memories: List[Dict[str, Any]] = []

        # Layer 1: Load topic index (minimal cost)
        layer1_budget = int(token_budget * 0.2)  # Reserve 20% for index
        index_data = self.storage.read_json("index.json") or {}
        topics = index_data.get("topics", [])

        # Filter topics by relevance to query
        relevant_topics = self._filter_relevant_topics(topics, query, weights)

        # Estimate tokens for layer 1
        layer1_tokens = sum(estimate_memory_tokens(t) for t in relevant_topics[:10])
        if layer1_tokens <= layer1_budget:
            for topic in relevant_topics[:10]:
                topic["_layer"] = 1
                selected_memories.append(topic)
            budget_remaining -= layer1_tokens

        # Layer 2: Expand summaries for top topics
        layer2_budget = int(token_budget * 0.4)  # Reserve 40% for summaries
        if budget_remaining > layer2_budget * 0.5:
            summaries = self._get_topic_summaries(relevant_topics[:5], query, weights)
            layer2_tokens = sum(estimate_memory_tokens(s) for s in summaries)

            if layer2_tokens <= budget_remaining:
                for summary in summaries:
                    summary["_layer"] = 2
                    selected_memories.append(summary)
                budget_remaining -= layer2_tokens

        # Layer 3: Full details for highest priority items
        if budget_remaining > 100:  # At least 100 tokens remaining
            full_details = self.retrieve_task_aware(context, top_k=10)
            for detail in full_details:
                detail["_layer"] = 3

            # Optimize to fit remaining budget
            optimized = optimize_context(full_details, budget_remaining)
            selected_memories.extend(optimized)

        # Calculate final metrics
        total_available = self._estimate_total_available_tokens()
        metrics = get_context_efficiency(selected_memories, token_budget, total_available)
        metrics["layers_used"] = list(set(m.get("_layer", 2) for m in selected_memories))

        return {
            "memories": selected_memories,
            "metrics": metrics,
            "task_type": task_type,
        }

    def _filter_relevant_topics(
        self,
        topics: List[Dict[str, Any]],
        query: str,
        weights: Dict[str, float],
    ) -> List[Dict[str, Any]]:
        """Filter and score topics by relevance to query."""
        query_lower = query.lower()
        query_words = set(query_lower.split())

        scored_topics = []
        for topic in topics:
            topic_name = topic.get("topic", "").lower()
            memory_type = topic.get("type", "").lower()

            # Calculate relevance score
            score = 0.0

            # Word overlap
            topic_words = set(topic_name.split())
            overlap = len(query_words & topic_words)
            score += overlap * 0.3

            # Memory type weight
            type_weight = weights.get(memory_type, 0.1)
            score += type_weight

            # Recency boost
            if topic.get("last_updated"):
                score += 0.1

            if score > 0:
                topic["_relevance_score"] = score
                scored_topics.append(topic)

        # Sort by score
        scored_topics.sort(key=lambda x: x.get("_relevance_score", 0), reverse=True)
        return scored_topics

    def _get_topic_summaries(
        self,
        topics: List[Dict[str, Any]],
        query: str,
        weights: Dict[str, float],
    ) -> List[Dict[str, Any]]:
        """Get summaries for selected topics."""
        summaries = []

        for topic in topics:
            topic_name = topic.get("topic", "")
            memory_type = topic.get("type", "episodic")

            # Try to load summary from appropriate collection
            if memory_type == "episodic":
                # Get recent episodes for this topic
                episodes = self.retrieve_from_episodic(topic_name, top_k=3)
                for ep in episodes:
                    # Create summary version
                    summary = {
                        "id": ep.get("id"),
                        "topic": topic_name,
                        "goal": ep.get("context", {}).get("goal", ""),
                        "outcome": ep.get("outcome", ""),
                        "_source": "episodic",
                    }
                    summaries.append(summary)

            elif memory_type == "semantic":
                patterns = self.retrieve_from_semantic(topic_name, top_k=3)
                for pat in patterns:
                    summary = {
                        "id": pat.get("id"),
                        "topic": topic_name,
                        "pattern": pat.get("pattern", ""),
                        "category": pat.get("category", ""),
                        "_source": "semantic",
                    }
                    summaries.append(summary)

            elif memory_type == "skills":
                skills = self.retrieve_from_skills(topic_name, top_k=2)
                for skill in skills:
                    summary = {
                        "id": skill.get("id"),
                        "topic": topic_name,
                        "name": skill.get("name", ""),
                        "description": skill.get("description", ""),
                        "_source": "skills",
                    }
                    summaries.append(summary)

        return summaries

    def _estimate_total_available_tokens(self) -> int:
        """Estimate total tokens if all memories were loaded."""
        from .token_economics import estimate_full_load_tokens
        return estimate_full_load_tokens(str(self.base_path))

    def get_token_usage_summary(
        self,
        context: Dict[str, Any],
        results: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Get a summary of token usage for a retrieval operation.

        Args:
            context: The query context used
            results: The results returned

        Returns:
            Dictionary with token usage statistics
        """
        total_tokens = sum(estimate_memory_tokens(r) for r in results)
        total_available = self._estimate_total_available_tokens()

        # Count by source
        by_source: Dict[str, int] = {}
        for result in results:
            source = result.get("_source", "unknown")
            tokens = estimate_memory_tokens(result)
            by_source[source] = by_source.get(source, 0) + tokens

        # Count by layer
        by_layer: Dict[int, int] = {}
        for result in results:
            layer = result.get("_layer", 2)
            tokens = estimate_memory_tokens(result)
            by_layer[layer] = by_layer.get(layer, 0) + tokens

        return {
            "total_tokens": total_tokens,
            "total_available": total_available,
            "compression_ratio": round(total_tokens / total_available, 3) if total_available > 0 else 1.0,
            "memory_count": len(results),
            "by_source": by_source,
            "by_layer": by_layer,
            "task_type": self.detect_task_type(context),
        }

    # -------------------------------------------------------------------------
    # Index Management
    # -------------------------------------------------------------------------

    def build_indices(self) -> None:
        """
        Build all vector indices from storage.

        Reads all memories and creates vector embeddings for similarity search.
        Requires embedding_engine to be configured.
        """
        if self.embedding_engine is None:
            return

        # Build episodic index
        if "episodic" in self.vector_indices:
            self._build_episodic_index()

        # Build semantic index
        if "semantic" in self.vector_indices:
            self._build_semantic_index()

        # Build skills index
        if "skills" in self.vector_indices:
            self._build_skills_index()

        # Build anti-patterns index
        if "anti_patterns" in self.vector_indices:
            self._build_anti_patterns_index()

    def update_index(
        self,
        collection: str,
        item_id: str,
        embedding: Any,
        metadata: Dict[str, Any],
    ) -> None:
        """
        Update a single entry in a vector index.

        Args:
            collection: Index collection name
            item_id: Unique identifier for the item
            embedding: Vector embedding
            metadata: Item metadata
        """
        if collection not in self.vector_indices:
            return

        index = self.vector_indices[collection]
        index.add(item_id, embedding, metadata)

    def save_indices(self) -> None:
        """
        Save all vector indices to disk.
        """
        if hasattr(self.storage, 'ensure_directory'):
            self.storage.ensure_directory("vectors")

        for name, index in self.vector_indices.items():
            # Resolve path through storage to respect namespace isolation
            if hasattr(self.storage, '_resolve_path'):
                index_path = self.storage._resolve_path(f"vectors/{name}_index")
            else:
                index_path = str(self.base_path / "vectors" / f"{name}_index")
            index.save(index_path)

    def load_indices(self) -> None:
        """
        Load all vector indices from disk.
        """
        vectors_files = self.storage.list_files("vectors", "*")
        if not vectors_files:
            return

        for name, index in self.vector_indices.items():
            if hasattr(self.storage, '_resolve_path'):
                index_path = self.storage._resolve_path(f"vectors/{name}_index")
            else:
                index_path = str(self.base_path / "vectors" / f"{name}_index")
            # Check if the npz file exists (VectorIndex.load expects base path without extension)
            import os
            if os.path.exists(f"{index_path}.npz"):
                index.load(index_path)

    # -------------------------------------------------------------------------
    # Private Helper Methods
    # -------------------------------------------------------------------------

    def _build_query_from_context(self, context: Dict[str, Any]) -> str:
        """Build a query string from context dictionary."""
        parts = []

        if context.get("goal"):
            parts.append(context["goal"])

        if context.get("phase"):
            parts.append(f"phase: {context['phase']}")

        if context.get("action_type"):
            parts.append(f"action: {context['action_type']}")

        if context.get("files"):
            parts.append(f"files: {', '.join(context['files'][:3])}")

        return " ".join(parts) if parts else ""

    def _keyword_search_episodic(
        self,
        keywords: List[str],
    ) -> List[Dict[str, Any]]:
        """Keyword search in episodic memories."""
        results: List[Dict[str, Any]] = []
        date_dirs = self.storage.list_files("episodic", "*")

        if not date_dirs:
            return results

        for date_dir in sorted(date_dirs, reverse=True):
            if not date_dir.is_dir():
                continue

            episode_files = self.storage.list_files(
                f"episodic/{date_dir.name}", "*.json"
            )
            for episode_file in episode_files:
                if episode_file.name == "index.json":
                    continue

                data = self.storage.read_json(
                    f"episodic/{date_dir.name}/{episode_file.name}"
                )
                if not data:
                    continue

                # Score based on keyword matches in goal
                context = data.get("context", {})
                goal = context.get("goal", "").lower()
                score = sum(1 for kw in keywords if kw in goal)

                # Also check phase
                phase = context.get("phase", "").lower()
                score += sum(0.5 for kw in keywords if kw in phase)

                if score > 0:
                    data["_score"] = score
                    data["_source"] = "episodic"
                    results.append(data)

        return results

    def _keyword_search_semantic(
        self,
        keywords: List[str],
    ) -> List[Dict[str, Any]]:
        """Keyword search in semantic patterns."""
        results: List[Dict[str, Any]] = []
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}

        for pattern in patterns_data.get("patterns", []):
            pattern_text = pattern.get("pattern", "").lower()
            category = pattern.get("category", "").lower()
            correct = pattern.get("correct_approach", "").lower()

            score = sum(1 for kw in keywords if kw in pattern_text)
            score += sum(0.5 for kw in keywords if kw in category)
            score += sum(0.3 for kw in keywords if kw in correct)

            # Weight by confidence
            confidence = pattern.get("confidence", 0.5)
            score *= confidence

            if score > 0:
                pattern["_score"] = score
                pattern["_source"] = "semantic"
                results.append(pattern)

        return results

    def _keyword_search_skills(
        self,
        keywords: List[str],
    ) -> List[Dict[str, Any]]:
        """Keyword search in skills."""
        results: List[Dict[str, Any]] = []
        skills_files = self.storage.list_files("skills", "*.json")

        for skill_file in skills_files:
            data = self.storage.read_json(f"skills/{skill_file.name}")
            if not data:
                continue

            name = data.get("name", "").lower()
            description = data.get("description", "").lower()
            steps_text = " ".join(data.get("steps", [])).lower()

            score = sum(2 for kw in keywords if kw in name)
            score += sum(1 for kw in keywords if kw in description)
            score += sum(0.5 for kw in keywords if kw in steps_text)

            if score > 0:
                data["_score"] = score
                data["_source"] = "skills"
                results.append(data)

        return results

    def _keyword_search_anti_patterns(
        self,
        keywords: List[str],
    ) -> List[Dict[str, Any]]:
        """Keyword search in anti-patterns."""
        results: List[Dict[str, Any]] = []
        anti_data = self.storage.read_json("semantic/anti-patterns.json") or {}

        for anti in anti_data.get("anti_patterns", []):
            what_fails = anti.get("what_fails", "").lower()
            why = anti.get("why", "").lower()
            prevention = anti.get("prevention", "").lower()

            score = sum(2 for kw in keywords if kw in what_fails)
            score += sum(1 for kw in keywords if kw in why)
            score += sum(1 for kw in keywords if kw in prevention)

            if score > 0:
                anti["_score"] = score
                anti["_source"] = "anti_patterns"
                results.append(anti)

        return results

    def _build_episodic_index(self) -> None:
        """Build vector index for episodic memories."""
        if self.embedding_engine is None or "episodic" not in self.vector_indices:
            return

        index = self.vector_indices["episodic"]
        date_dirs = self.storage.list_files("episodic", "*")

        for date_dir in date_dirs:
            if not date_dir.is_dir():
                continue

            episode_files = self.storage.list_files(
                f"episodic/{date_dir.name}", "*.json"
            )
            for episode_file in episode_files:
                if episode_file.name == "index.json":
                    continue

                data = self.storage.read_json(
                    f"episodic/{date_dir.name}/{episode_file.name}"
                )
                if not data:
                    continue

                # Create text for embedding
                context = data.get("context", {})
                text = f"{context.get('goal', '')} {context.get('phase', '')}"

                # Generate embedding
                embedding = self.embedding_engine.embed(text)

                # Add to index
                index.add(data.get("id", ""), embedding, data)

    def _build_semantic_index(self) -> None:
        """Build vector index for semantic patterns."""
        if self.embedding_engine is None or "semantic" not in self.vector_indices:
            return

        index = self.vector_indices["semantic"]
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}

        for pattern in patterns_data.get("patterns", []):
            # Create text for embedding
            text = f"{pattern.get('pattern', '')} {pattern.get('category', '')} {pattern.get('correct_approach', '')}"

            # Generate embedding
            embedding = self.embedding_engine.embed(text)

            # Add to index
            index.add(pattern.get("id", ""), embedding, pattern)

    def _build_skills_index(self) -> None:
        """Build vector index for skills."""
        if self.embedding_engine is None or "skills" not in self.vector_indices:
            return

        index = self.vector_indices["skills"]
        skills_files = self.storage.list_files("skills", "*.json")

        for skill_file in skills_files:
            data = self.storage.read_json(f"skills/{skill_file.name}")
            if not data:
                continue

            # Create text for embedding
            steps = " ".join(data.get("steps", []))
            text = f"{data.get('name', '')} {data.get('description', '')} {steps}"

            # Generate embedding
            embedding = self.embedding_engine.embed(text)

            # Add to index
            index.add(data.get("id", ""), embedding, data)

    def _build_anti_patterns_index(self) -> None:
        """Build vector index for anti-patterns."""
        if self.embedding_engine is None or "anti_patterns" not in self.vector_indices:
            return

        index = self.vector_indices["anti_patterns"]
        anti_data = self.storage.read_json("semantic/anti-patterns.json") or {}

        for anti in anti_data.get("anti_patterns", []):
            # Create text for embedding
            text = f"{anti.get('what_fails', '')} {anti.get('why', '')} {anti.get('prevention', '')}"

            # Generate embedding
            embedding = self.embedding_engine.embed(text)

            # Add to index with ID
            item_id = anti.get("id", anti.get("source", f"anti-{hash(text) % 10000}"))
            index.add(item_id, embedding, anti)
