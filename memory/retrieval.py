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
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Protocol, Tuple, Union, TYPE_CHECKING

logger = logging.getLogger(__name__)

# numpy is optional - only required for vector operations
try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    np = None  # type: ignore
    NUMPY_AVAILABLE = False
    logger.warning(
        "numpy not installed. Vector operations in memory retrieval will be "
        "degraded. Install with: pip install numpy"
    )

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
        include_unstamped_legacy: bool = False,
    ):
        """
        Initialize the memory retrieval system.

        Args:
            storage: MemoryStorage instance for reading memory files
            embedding_engine: Optional embedding engine for similarity search
            vector_indices: Optional dict of vector indices (episodic, semantic, skills)
            base_path: Base path for memory storage directory
            namespace: Optional namespace for scoped retrieval
            include_unstamped_legacy: Opt-in escape hatch. When False (the
                secure default), legacy entries that lack a "_namespace" stamp
                are EXCLUDED from a namespaced query. This prevents a silent
                cross-namespace leak where one project reads another project's
                unstamped memory. Set True only when migrating a single-project
                store whose entries predate namespace stamping and you have
                verified every entry belongs to the active namespace.
        """
        self.storage = storage
        self.embedding_engine = embedding_engine
        self.vector_indices = vector_indices or {}
        self.base_path = Path(base_path)
        self._namespace = namespace
        self._include_unstamped_legacy = include_unstamped_legacy
        # Track when indices were last built to detect staleness (BUG-MEM-002).
        # When consolidation modifies patterns, indices become stale and should
        # be rebuilt before the next similarity search.
        self._indices_built_at: Optional[float] = None

    @property
    def namespace(self) -> Optional[str]:
        """Get the current namespace."""
        return self._namespace

    # Track which legacy entries we've already warned about to avoid log spam.
    _LEGACY_WARN_LIMIT = 5

    # Cap on episode files read per keyword scan. The episodic store grows
    # unbounded over a long-lived project, so an uncapped scan reads+parses
    # every episode on every keyword query. Date dirs are walked newest-first,
    # so the cap retains the most recent episodes (the natural relevance order)
    # and only stops unbounded IO; it does not change scoring of retained
    # candidates.
    _KEYWORD_SCAN_MAX_EPISODES = 2000
    _legacy_warned_count: int = 0

    def _belongs_to_namespace(self, result: Dict[str, Any]) -> bool:
        """
        Check if a memory result belongs to the current namespace.

        Cross-namespace leak defense (v7.5.10). Storage layer should isolate
        files by directory, but this filter provides defense-in-depth and
        handles cases where vector indices span namespaces.

        Behavior:
        - If self._namespace is None, accept all (backward compat for unscoped retrieval).
        - If result has "_namespace" matching, accept.
        - If result lacks "_namespace" (legacy entry written before stamping):
          treat it conservatively. An unstamped entry has no provable origin,
          so under a namespaced query it could belong to ANY namespace and
          including it is a silent cross-namespace leak (one project reading
          another's memory). By default (self._include_unstamped_legacy is
          False) such entries are EXCLUDED, with a rate-limited warning telling
          operators to re-save the entry to add a stamp. Operators who have
          verified a single-project store predates stamping can opt back in via
          include_unstamped_legacy=True.
        - Otherwise (stamp present but does not match), reject.
        """
        if self._namespace is None:
            return True
        result_ns = result.get("_namespace")
        if result_ns is None:
            # Legacy entry without namespace stamp. No provable origin -> do not
            # silently leak it across namespaces. Exclude by default; warn so
            # operators can re-save to add a stamp (rate-limited to avoid spam).
            if MemoryRetrieval._legacy_warned_count < MemoryRetrieval._LEGACY_WARN_LIMIT:
                if self._include_unstamped_legacy:
                    logger.warning(
                        "Memory entry id=%s lacks '_namespace' stamp (legacy "
                        "entry). Including under namespace=%s because "
                        "include_unstamped_legacy is set. Re-save this entry to "
                        "stamp it and remove the opt-in.",
                        result.get("id", "<unknown>"),
                        self._namespace,
                    )
                else:
                    logger.warning(
                        "Memory entry id=%s lacks '_namespace' stamp (legacy "
                        "entry). Excluding from namespace=%s query to prevent a "
                        "cross-namespace leak. Re-save this entry to stamp it, "
                        "or pass include_unstamped_legacy=True to opt in.",
                        result.get("id", "<unknown>"),
                        self._namespace,
                    )
                MemoryRetrieval._legacy_warned_count += 1
            return self._include_unstamped_legacy
        return result_ns == self._namespace

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
            include_unstamped_legacy=self._include_unstamped_legacy,
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
        goal = (context.get("goal") or "").lower()
        action = (context.get("action_type") or "").lower()
        phase = (context.get("phase") or "").lower()

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
        persist_boost: bool = False,
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
            persist_boost: When True, persist the retrieval-time importance boost
                         to disk ("use it or lose it" reinforcement). Default
                         False so manual/on-demand retrievals (dashboard, MCP)
                         do NOT silently reinforce importance; only the autonomous
                         RARV loop opts in. The in-memory boost that shapes the
                         returned ranking is applied either way.

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

        # Boost importance for retrieved memories (use it or lose it). The
        # in-memory boost shapes the returned ranking; persist_boost writes the
        # reinforcement to disk (retrieval-F1: boost_on_retrieval alone never
        # persisted). Persistence is best-effort: a locked/missing record must
        # never break retrieval, so failures are swallowed (mirrors other
        # best-effort writes).
        if hasattr(self.storage, 'boost_on_retrieval'):
            for memory in merged[:top_k]:
                self.storage.boost_on_retrieval(memory, boost=0.05)
                if persist_boost and hasattr(self.storage, 'persist_boost'):
                    try:
                        self.storage.persist_boost(memory, boost=0.05)
                    except Exception:
                        pass

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

            # Simple keyword search in this namespace.
            # BUG-MEM-012: 'anti_patterns' was omitted, so anti-pattern
            # memories were silently missed in cross-namespace search.
            for collection in ["episodic", "semantic", "skills", "anti_patterns"]:
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

    def mark_indices_stale(self) -> None:
        """
        Mark vector indices as stale so they are rebuilt before next search.

        Should be called after consolidation modifies the semantic memory
        to prevent returning stale results (BUG-MEM-002 fix).
        """
        self._indices_built_at = None

    def retrieve_by_similarity(
        self,
        query: str,
        collection: str,
        top_k: int = 5,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve by semantic similarity using embeddings.

        Falls back to keyword search if embeddings are not available.
        Checks for index staleness and falls back to keyword search
        if indices may be stale (BUG-MEM-002 fix).

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

        # Check if indices need rebuilding after consolidation (BUG-MEM-002,
        # BUG-MEM-007). Consolidation rewrites semantic/patterns.json (and may
        # touch semantic/anti-patterns.json), so any index sourced from those
        # files can go stale. The 'semantic' index reads patterns.json; the
        # 'anti_patterns' index reads BOTH patterns.json and anti-patterns.json
        # (consolidated anti-patterns are bridged from patterns.json). If a
        # source file was modified more recently than we last built indices,
        # fall back to keyword search for accuracy. (episodic/skills read their
        # own per-record files and are not rewritten by consolidation, so they
        # are not checked here.)
        if self._indices_built_at is not None:
            stale_sources: List[str] = []
            if collection == "semantic":
                stale_sources = ["semantic/patterns.json"]
            elif collection == "anti_patterns":
                stale_sources = ["semantic/patterns.json",
                                 "semantic/anti-patterns.json"]
            if stale_sources:
                import os
                for rel in stale_sources:
                    source_path = self.base_path / rel
                    if source_path.exists() and \
                            os.path.getmtime(source_path) > self._indices_built_at:
                        logger.info(
                            "%s index is stale (%s modified after index build). "
                            "Falling back to keyword search for accuracy.",
                            collection, rel,
                        )
                        return self.retrieve_by_keyword(
                            query.split(), collection)[:top_k]

        # Generate query embedding and search the vector index. If the embedding
        # engine has fallen back to a different model/dimension since the index
        # was built, the query vector dimension will not match the stored index
        # and VectorSearchIndex.search raises ValueError. That must NOT crash
        # retrieval or return wrong-dimension neighbors -- degrade to keyword
        # search (the honest, accurate fallback), same as the staleness path.
        index = self.vector_indices[collection]
        try:
            query_embedding = self.embedding_engine.embed(query)
            results = index.search(query_embedding, top_k)
        except ValueError as exc:
            logger.info(
                "%s vector search failed (%s); likely an embedding "
                "dimension change since index build. Falling back to keyword "
                "search for accuracy.",
                collection, exc,
            )
            return self.retrieve_by_keyword(query.split(), collection)[:top_k]

        # Convert to standard format
        items: List[Dict[str, Any]] = []
        for item_id, score, metadata in results:
            item = metadata.copy()
            item["id"] = item_id
            item["_score"] = float(score)
            item["_source"] = collection
            # Cross-namespace leak defense (v7.5.10): vector indices may be
            # shared across namespaces, so filter here too.
            if self._belongs_to_namespace(item):
                items.append(item)

        return items

    @staticmethod
    def _anti_pattern_content_key(record: Dict[str, Any]) -> tuple:
        """Normalized content key for an anti-pattern across both schemas.

        Consolidation writes anti-patterns into semantic/patterns.json as
        SemanticPattern objects (fields incorrect_approach|pattern /
        description / correct_approach), while the legacy
        semantic/anti-patterns.json uses what_fails / why / prevention. The
        same anti-pattern can therefore appear in both stores (no migration
        copies one into the other), which would double-count it on read and in
        the vector index (BUG-MEM-011). Map both schemas onto the same
        lowercased/stripped (what_fails, why, prevention) tuple so the two
        representations of one anti-pattern collide on a single key.
        """
        def _norm(*candidates: Any) -> str:
            for c in candidates:
                if c:
                    return str(c).strip().lower()
            return ""

        what_fails = _norm(record.get("what_fails"),
                           record.get("incorrect_approach"),
                           record.get("pattern"))
        why = _norm(record.get("why"), record.get("description"))
        prevention = _norm(record.get("prevention"),
                           record.get("correct_approach"))
        return (what_fails, why, prevention)

    @staticmethod
    def _parse_episode_timestamp(value: Any) -> Optional[datetime]:
        """Parse an episode timestamp to a tz-aware datetime, or None.

        Accepts ISO-8601 strings (with or without a trailing Z) and existing
        datetime objects. Returns None when the value is missing or cannot be
        parsed, so callers can fall back to coarser filtering instead of
        crashing on a corrupt record. Naive results are assumed UTC so they
        compare correctly against tz-aware bounds.
        """
        if not value:
            return None
        try:
            if isinstance(value, datetime):
                dt = value
            elif isinstance(value, str):
                s = value[:-1] + "+00:00" if value.endswith("Z") else value
                dt = datetime.fromisoformat(s)
            else:
                return None
        except (ValueError, TypeError):
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt

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
        # Normalize bounds to tz-aware UTC so comparisons against tz-aware
        # episode/pattern timestamps below never raise on a naive bound.
        if since.tzinfo is None:
            since = since.replace(tzinfo=timezone.utc)
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
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
                        # The date-dir match above is a coarse, day-granularity
                        # prefilter. Without this per-episode timestamp check, an
                        # episode at 08:00 on the `since` day was returned even
                        # when `since` was 14:00 that same day (and likewise at
                        # the `until` boundary). Filter each episode by its own
                        # timestamp when one is present and parseable; episodes
                        # with a missing/unparseable timestamp keep the previous
                        # day-level behavior rather than being silently dropped.
                        ep_ts = self._parse_episode_timestamp(data.get("timestamp"))
                        if ep_ts is not None and not (since <= ep_ts <= until):
                            continue
                        data["_source"] = "episodic"
                        if self._belongs_to_namespace(data):
                            results.append(data)

        # Filter semantic patterns by last_used
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}
        for pattern in patterns_data.get("patterns", []):
            if not isinstance(pattern, dict):
                continue
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
                        if self._belongs_to_namespace(pattern):
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
        source = result.get("_source") or ""
        # _score is set internally so null is unlikely, but guard for
        # uniformity since it feeds the arithmetic below.
        base_score = result.get("_score")
        base_score = 0.5 if base_score is None else base_score

        # Map source to weight key
        weight_key = source
        if source == "procedural":
            weight_key = "skills"

        weight = weights.get(weight_key, 0.0)

        # Get importance score (default 0.5 if not set). Defensive: a
        # corrupt/hand-edited record may carry importance=null, which would
        # raise TypeError in the arithmetic below. Use the default only when
        # missing/null; a legitimate 0.0 is preserved.
        importance = result.get("importance")
        importance = 0.5 if importance is None else importance

        # Get confidence for semantic patterns. Same null guard; default 1.0
        # only when missing/null, a legitimate 0.0 is preserved.
        confidence = result.get("confidence")
        confidence = 1.0 if confidence is None else confidence

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
                item = dict(item)  # shallow copy to avoid mutating original
                # Ensure source is set
                if "_source" not in item:
                    item["_source"] = collection

                # Calculate weighted score with importance
                item["_weighted_score"] = self._score_result(item, weights, task_type)
                all_results.append(item)

        # Sort by weighted score
        all_results.sort(key=lambda x: x.get("_weighted_score", 0), reverse=True)

        # Defense-in-depth dedup by id. The same record can legitimately reach
        # more than one collection bucket (e.g. an anti-pattern bridged into the
        # anti_patterns source while a category filter is also expected upstream).
        # Keep the highest-scoring copy: results are already sorted descending, so
        # the first occurrence of an id is the best one. Records without an id are
        # never collapsed together (each keeps its own slot).
        deduped: List[Dict[str, Any]] = []
        seen_ids: set = set()
        for item in all_results:
            item_id = item.get("id")
            if item_id is not None:
                if item_id in seen_ids:
                    continue
                seen_ids.add(item_id)
            deduped.append(item)

        return deduped[:top_k]

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

                # Calculate age in days. Use total_seconds()/86400 for a
                # continuous value (the .days attribute truncates to whole days,
                # losing sub-day resolution, e.g. an 18-hour-old record reads as
                # age 0 instead of 0.75).
                age_days = (now - item_time).total_seconds() / 86400.0

                # Boost decays linearly over 30 days. Gate on [0, 30): a
                # future-dated record (clock skew or a forward-stamped entry)
                # has a negative age and must NOT be treated as the freshest
                # record. The old code (age_days < 30) let a negative age through
                # and produced boost = boost_factor * (1 - negative/30) > the
                # intended cap, inflating future records above all real ones.
                if 0 <= age_days < 30:
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

        # Layer 2: Expand summaries for top topics.
        # Gate on the remaining budget (not a fraction of the layer-2 reserve)
        # and trim the summary set to fit via optimize_context, mirroring
        # Layer 3 below. Previously this admitted summaries all-or-nothing: a
        # set that exceeded budget_remaining was dropped entirely, and the gate
        # compared against layer2_budget*0.5 (a fraction of the reserve) rather
        # than the budget actually left.
        if budget_remaining > 100:
            summaries = self._get_topic_summaries(relevant_topics[:5], query, weights)
            for summary in summaries:
                summary["_layer"] = 2

            # Optimize to fit remaining budget (trimmed set, not all-or-nothing)
            optimized = optimize_context(summaries, budget_remaining)
            selected_memories.extend(optimized)
            budget_remaining -= sum(estimate_memory_tokens(s) for s in optimized)

        # Layer 3: Full details for highest priority items
        if budget_remaining > 100:  # At least 100 tokens remaining
            # Cap top_k based on remaining budget to avoid loading unbounded data.
            # Estimate ~50 tokens per result as a rough lower bound.
            max_results = max(1, min(10, budget_remaining // 50))
            full_details = self.retrieve_task_aware(context, top_k=max_results)
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
            if not isinstance(topic, dict):
                continue
            # The index.json writer (engine.py _stamp_topic at ~368 and
            # store_pattern at ~978) emits topics keyed by "id" (a phase or
            # category slug, e.g. "implementation", "auth") and "summary"
            # (prose: the goal text or "Patterns for <category>"). It does NOT
            # emit "topic", "type", or "last_updated". Previously this scorer
            # read only "topic"/"type"/"last_updated", so word overlap, type
            # weighting, and the recency boost were all silent no-ops on real
            # data. Score against the real keys (id + summary for word overlap,
            # id as the type/category for the strategy weight, the real recency
            # keys), and keep the legacy "topic"/"type"/"last_updated" keys as
            # fallbacks so any older-shape index still ranks.
            topic_text = " ".join(
                str(v) for v in (
                    topic.get("summary"),
                    topic.get("id"),
                    topic.get("topic"),
                ) if v
            ).lower()
            # The category/phase slug doubles as the memory-type weight key
            # (the writer uses the category name as the id). Fall back to the
            # legacy "type" key for older-shape indexes.
            memory_type = (topic.get("id") or topic.get("type") or "").lower()

            # Calculate relevance score
            score = 0.0

            # Word overlap
            topic_words = set(topic_text.split())
            overlap = len(query_words & topic_words)
            score += overlap * 0.3

            # Memory type weight
            type_weight = weights.get(memory_type, 0.1)
            score += type_weight

            # Recency boost. The writer stamps "last_accessed"/"first_seen";
            # "last_updated" is the legacy key.
            if (topic.get("last_accessed")
                    or topic.get("first_seen")
                    or topic.get("last_updated")):
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
            if not isinstance(topic, dict):
                continue
            # Mirror _filter_relevant_topics: the writer emits "id"/"summary",
            # not "topic". Fall back to the legacy "topic" key so both shapes
            # resolve a usable name. Default type stays "episodic".
            topic_name = (
                topic.get("id") or topic.get("topic") or topic.get("summary") or ""
            )
            memory_type = topic.get("type") or "episodic"

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
        Records build timestamp so staleness can be detected (BUG-MEM-002).
        """
        if self.embedding_engine is None:
            return

        import time as _time

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

        # Record build timestamp for staleness detection (BUG-MEM-002)
        self._indices_built_at = _time.time()

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
            # Defensive: filter to str elements so a list carrying None or
            # non-str entries (corrupt/hand-edited record) does not raise
            # TypeError inside join. Mirrors the steps-join in skills search.
            files = [f for f in context["files"][:3] if isinstance(f, str)]
            if files:
                parts.append(f"files: {', '.join(files)}")

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

        # Bound the scan so an unbounded episodic store does not force a
        # read+parse of every episode on each query (see
        # _KEYWORD_SCAN_MAX_EPISODES). Newest date dirs first keeps the most
        # recent episodes.
        scanned = 0
        for date_dir in sorted(date_dirs, reverse=True):
            if scanned >= self._KEYWORD_SCAN_MAX_EPISODES:
                break
            if not date_dir.is_dir():
                continue

            episode_files = self.storage.list_files(
                f"episodic/{date_dir.name}", "*.json"
            )
            for episode_file in episode_files:
                if episode_file.name == "index.json":
                    continue
                if scanned >= self._KEYWORD_SCAN_MAX_EPISODES:
                    break

                scanned += 1
                data = self.storage.read_json(
                    f"episodic/{date_dir.name}/{episode_file.name}"
                )
                if not data:
                    continue

                # Score based on keyword matches in goal.
                # Defensive: a corrupt or hand-edited record may carry
                # context=null or null string fields; (x or "") avoids
                # AttributeError on None.
                context = data.get("context") or {}
                goal = (context.get("goal") or "").lower()
                score = sum(1 for kw in keywords if kw in goal)

                # Also check phase
                phase = (context.get("phase") or "").lower()
                score += sum(0.5 for kw in keywords if kw in phase)

                if score > 0:
                    data_copy = dict(data)
                    data_copy["_score"] = score
                    data_copy["_source"] = "episodic"
                    if self._belongs_to_namespace(data_copy):
                        results.append(data_copy)

        return results

    def _keyword_search_semantic(
        self,
        keywords: List[str],
    ) -> List[Dict[str, Any]]:
        """Keyword search in semantic patterns."""
        results: List[Dict[str, Any]] = []
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}

        for pattern in patterns_data.get("patterns", []):
            if not isinstance(pattern, dict):
                continue
            # Anti-patterns live in this same patterns.json (consolidation
            # writes them as SemanticPattern records with category="anti-pattern").
            # They are surfaced separately by _keyword_search_anti_patterns, which
            # bridges those records into the anti_patterns source. Including them
            # here too returns the same record twice (once as semantic, once as
            # anti_patterns), double-counting and wasting token budget. Skip them.
            if (pattern.get("category") or "").lower() == "anti-pattern":
                continue
            # Defensive: corrupt or hand-edited records may carry null
            # string fields; (x or "") avoids AttributeError on None.
            pattern_text = (pattern.get("pattern") or "").lower()
            category = (pattern.get("category") or "").lower()
            correct = (pattern.get("correct_approach") or "").lower()

            score = sum(1 for kw in keywords if kw in pattern_text)
            score += sum(0.5 for kw in keywords if kw in category)
            score += sum(0.3 for kw in keywords if kw in correct)

            # Weight by confidence. Defensive: a null confidence would make
            # score *= None raise TypeError. Use 0.5 only when missing/null;
            # a legitimate 0.0 is preserved (it correctly zeroes the score).
            confidence = pattern.get("confidence")
            confidence = 0.5 if confidence is None else confidence
            score *= confidence

            if score > 0:
                pattern_copy = dict(pattern)
                pattern_copy["_score"] = score
                pattern_copy["_source"] = "semantic"
                if self._belongs_to_namespace(pattern_copy):
                    results.append(pattern_copy)

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

            name = (data.get("name") or "").lower()
            description = (data.get("description") or "").lower()
            steps_text = " ".join(
                s for s in (data.get("steps") or []) if isinstance(s, str)
            ).lower()

            score = sum(2 for kw in keywords if kw in name)
            score += sum(1 for kw in keywords if kw in description)
            score += sum(0.5 for kw in keywords if kw in steps_text)

            if score > 0:
                data_copy = dict(data)
                data_copy["_score"] = score
                data_copy["_source"] = "skills"
                if self._belongs_to_namespace(data_copy):
                    results.append(data_copy)

        return results

    def _keyword_search_anti_patterns(
        self,
        keywords: List[str],
    ) -> List[Dict[str, Any]]:
        """Keyword search in anti-patterns."""
        results: List[Dict[str, Any]] = []
        anti_data = self.storage.read_json("semantic/anti-patterns.json") or {}
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}

        # BUG-MEM-011: an anti-pattern can live in BOTH the consolidated
        # patterns.json (category="anti-pattern") and the legacy
        # anti-patterns.json, with no migration copying one into the other.
        # Reading both naively double-counts it. Pre-scan the consolidated
        # store (which we keep) into a seen-set keyed by id AND normalized
        # content, then skip any legacy record that collides with either.
        seen_ids: set = set()
        seen_content: set = set()
        for pat in patterns_data.get("patterns", []):
            if not isinstance(pat, dict):
                continue
            if pat.get("category") != "anti-pattern":
                continue
            pid = pat.get("id")
            if pid:
                seen_ids.add(pid)
            seen_content.add(self._anti_pattern_content_key(pat))

        for anti in anti_data.get("anti_patterns", []):
            # Defensive: mirror the sibling loop below. A corrupt or
            # hand-edited record may be a non-dict or carry null fields;
            # the isinstance guard and (x or "") avoid AttributeError.
            if not isinstance(anti, dict):
                continue
            # Dedup: skip a legacy record already represented in patterns.json.
            aid = anti.get("id")
            if (aid and aid in seen_ids) or \
                    self._anti_pattern_content_key(anti) in seen_content:
                continue
            what_fails = (anti.get("what_fails") or "").lower()
            why = (anti.get("why") or "").lower()
            prevention = (anti.get("prevention") or "").lower()

            score = sum(2 for kw in keywords if kw in what_fails)
            score += sum(1 for kw in keywords if kw in why)
            score += sum(1 for kw in keywords if kw in prevention)

            if score > 0:
                anti_copy = dict(anti)
                anti_copy["_score"] = score
                anti_copy["_source"] = "anti_patterns"
                if self._belongs_to_namespace(anti_copy):
                    results.append(anti_copy)

        # Consolidation writes anti-patterns as SemanticPattern objects with
        # category="anti-pattern" into semantic/patterns.json (not the legacy
        # anti-patterns.json above), with fields incorrect_approach /
        # description / correct_approach. Without this bridge, consolidated
        # anti-patterns were never retrievable. Map them onto the same
        # what_fails / why / prevention scoring shape.
        for pat in patterns_data.get("patterns", []):
            if not isinstance(pat, dict):
                continue
            if pat.get("category") != "anti-pattern":
                continue
            what_fails = (pat.get("incorrect_approach")
                          or pat.get("pattern") or "").lower()
            why = (pat.get("description") or "").lower()
            prevention = (pat.get("correct_approach") or "").lower()

            score = sum(2 for kw in keywords if kw in what_fails)
            score += sum(1 for kw in keywords if kw in why)
            score += sum(1 for kw in keywords if kw in prevention)

            if score > 0:
                anti_copy = dict(pat)
                anti_copy["_score"] = score
                anti_copy["_source"] = "anti_patterns"
                anti_copy.setdefault("what_fails", pat.get("incorrect_approach", "") or pat.get("pattern", ""))
                anti_copy.setdefault("why", pat.get("description", ""))
                anti_copy.setdefault("prevention", pat.get("correct_approach", ""))
                if self._belongs_to_namespace(anti_copy):
                    results.append(anti_copy)

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
            if not isinstance(pattern, dict):
                continue
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
            steps = " ".join(
                s for s in (data.get("steps") or []) if isinstance(s, str)
            )
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
        patterns_data = self.storage.read_json("semantic/patterns.json") or {}

        # BUG-MEM-011: the same anti-pattern may live in BOTH the consolidated
        # patterns.json and the legacy anti-patterns.json. Indexing both
        # double-counts it in the vector index. Pre-scan the consolidated store
        # (which we keep) into a seen-set keyed by id AND normalized content,
        # then skip any legacy record that collides with either.
        seen_ids: set = set()
        seen_content: set = set()
        for pat in patterns_data.get("patterns", []):
            if not isinstance(pat, dict):
                continue
            if pat.get("category") != "anti-pattern":
                continue
            pid = pat.get("id")
            if pid:
                seen_ids.add(pid)
            seen_content.add(self._anti_pattern_content_key(pat))

        for anti in anti_data.get("anti_patterns", []):
            if not isinstance(anti, dict):
                continue
            # Dedup: skip a legacy record already represented in patterns.json.
            aid = anti.get("id")
            if (aid and aid in seen_ids) or \
                    self._anti_pattern_content_key(anti) in seen_content:
                continue
            # Create text for embedding
            text = f"{anti.get('what_fails', '')} {anti.get('why', '')} {anti.get('prevention', '')}"

            # Generate embedding
            embedding = self.embedding_engine.embed(text)

            # Add to index with ID
            item_id = anti.get("id", anti.get("source", f"anti-{hash(text) % 10000}"))
            index.add(item_id, embedding, anti)

        # Parity with the keyword path: consolidation writes anti-patterns as
        # category="anti-pattern" entries in semantic/patterns.json, not the
        # legacy anti-patterns.json above. Bridge those into the vector index
        # too so embedding-based retrieval sees consolidated anti-patterns.
        for pat in patterns_data.get("patterns", []):
            if not isinstance(pat, dict):
                continue
            if pat.get("category") != "anti-pattern":
                continue
            what_fails = pat.get("incorrect_approach", "") or pat.get("pattern", "")
            why = pat.get("description", "")
            prevention = pat.get("correct_approach", "")
            text = f"{what_fails} {why} {prevention}"
            embedding = self.embedding_engine.embed(text)
            item_id = pat.get("id", f"anti-{hash(text) % 10000}")
            bridged = dict(pat)
            bridged.setdefault("what_fails", what_fails)
            bridged.setdefault("why", why)
            bridged.setdefault("prevention", prevention)
            index.add(item_id, embedding, bridged)
