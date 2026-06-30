"""
Loki Mode Memory System - Episodic to Semantic Consolidation

This module handles the transformation of episodic memories into semantic patterns.
Implements clustering, pattern extraction, anti-pattern detection, and Zettelkasten linking.

See references/memory-system.md for full documentation.
"""

from __future__ import annotations

import uuid
import time
import fcntl
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    np = None
    HAS_NUMPY = False

from .schemas import EpisodeTrace, SemanticPattern, Link
from .storage import MemoryStorage


# -----------------------------------------------------------------------------
# Data Classes
# -----------------------------------------------------------------------------


@dataclass
class ConsolidationResult:
    """
    Result of a memory consolidation run.

    Attributes:
        patterns_created: Number of new patterns created
        patterns_merged: Number of existing patterns that were merged with new data
        anti_patterns_created: Number of anti-patterns extracted from failures
        links_created: Number of Zettelkasten links created
        episodes_processed: Number of episodes that were processed
        duration_seconds: How long the consolidation took
        vector_index_stale: Whether vector indices need rebuilding
    """
    patterns_created: int = 0
    patterns_merged: int = 0
    anti_patterns_created: int = 0
    links_created: int = 0
    episodes_processed: int = 0
    duration_seconds: float = 0.0
    vector_index_stale: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "patterns_created": self.patterns_created,
            "patterns_merged": self.patterns_merged,
            "anti_patterns_created": self.anti_patterns_created,
            "links_created": self.links_created,
            "episodes_processed": self.episodes_processed,
            "duration_seconds": self.duration_seconds,
            "vector_index_stale": self.vector_index_stale,
        }


@dataclass
class Cluster:
    """
    A cluster of similar episodes.

    Attributes:
        episodes: List of episodes in this cluster
        centroid: Optional centroid vector for embedding-based clustering
        label: Human-readable label for the cluster
    """
    episodes: List[EpisodeTrace] = field(default_factory=list)
    centroid: Optional[Any] = None  # np.ndarray when numpy available
    label: str = ""

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "episode_ids": [getattr(ep, 'id', '') if not isinstance(ep, dict) else ep.get('id', '') for ep in self.episodes],
            "label": self.label,
            "size": len(self.episodes),
        }


# -----------------------------------------------------------------------------
# Consolidation Pipeline
# -----------------------------------------------------------------------------


class ConsolidationPipeline:
    """
    Pipeline for consolidating episodic memories into semantic patterns.

    This class orchestrates the transformation of specific interaction traces
    (episodic memory) into generalized, reusable patterns (semantic memory).

    The consolidation process:
    1. Load recent episodes from storage
    2. Cluster episodes by similarity or task type
    3. Extract common patterns from successful clusters
    4. Extract anti-patterns from failed episodes
    5. Merge new patterns with existing ones
    6. Create Zettelkasten-style links between patterns
    """

    def __init__(
        self,
        storage: MemoryStorage,
        embedding_engine: Optional[Any] = None,
        base_path: str = ".loki/memory"
    ):
        """
        Initialize the consolidation pipeline.

        Args:
            storage: MemoryStorage instance for reading/writing memory
            embedding_engine: Optional embedding engine for similarity computation.
                              If None, falls back to text-based similarity.
            base_path: Base path for memory storage (used if storage is None)
        """
        self.storage = storage
        self.embedding_engine = embedding_engine
        self.base_path = base_path

    def consolidate(self, since_hours: int = 24) -> ConsolidationResult:
        """
        Run the full consolidation pipeline.

        Uses a file lock to prevent concurrent consolidation runs from
        corrupting data (BUG-MEM-003 fix). If another consolidation is
        already in progress, this call blocks until it completes.

        Args:
            since_hours: Only process episodes from the last N hours

        Returns:
            ConsolidationResult with statistics about the consolidation run
        """
        lock_path = Path(self.base_path) / ".consolidation.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_file = None
        try:
            lock_file = open(lock_path, "w")
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            return self._consolidate_locked(since_hours)
        finally:
            if lock_file is not None:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                lock_file.close()
                # Do NOT unlink the lock inode here. Unlinking on release is a
                # flock+unlink inode-replacement race: waiter B blocked on
                # inode-1 acquires it after holder A unlinks inode-1, then a
                # third consolidation C opens the path, finds it gone, creates
                # inode-2 and flocks inode-2 -- entering _consolidate_locked
                # while B is still inside, breaking the BUG-MEM-003
                # single-consolidation guarantee. Same class fixed in
                # storage._file_lock. Persistent lock files are the standard
                # flock pattern; the file is reused across runs.

    def _consolidate_locked(self, since_hours: int) -> ConsolidationResult:
        """Run the consolidation pipeline under an exclusive lock."""
        start_time = time.time()
        result = ConsolidationResult()

        # 1. Load recent episodes
        since_datetime = datetime.now(timezone.utc) - timedelta(hours=since_hours)
        episode_ids = self.storage.list_episodes(since=since_datetime, limit=1000)

        episodes = []
        for episode_id in episode_ids:
            episode_data = self.storage.load_episode(episode_id)
            if episode_data:
                if isinstance(episode_data, dict):
                    episode = EpisodeTrace.from_dict(episode_data)
                else:
                    episode = episode_data
                episodes.append(episode)

        result.episodes_processed = len(episodes)

        if not episodes:
            result.duration_seconds = time.time() - start_time
            return result

        # 2. Separate successful and failed episodes
        successful_episodes = [ep for ep in episodes if ep.outcome == "success"]
        failed_episodes = [ep for ep in episodes if ep.outcome == "failure"]

        # 3. Cluster episodes
        if self.embedding_engine is not None and HAS_NUMPY:
            clusters = self.cluster_by_similarity(successful_episodes)
        else:
            clusters = self._clusters_from_task_type(
                self.cluster_by_task_type(successful_episodes)
            )

        # 4. Load existing patterns for merging
        existing_pattern_ids = self.storage.list_patterns()
        existing_patterns = []
        for pattern_id in existing_pattern_ids:
            pattern_data = self.storage.load_pattern(pattern_id)
            if pattern_data:
                if isinstance(pattern_data, dict):
                    pattern = SemanticPattern.from_dict(pattern_data)
                else:
                    pattern = pattern_data
                existing_patterns.append(pattern)

        all_patterns = existing_patterns.copy()
        new_patterns = []

        # 5. Extract patterns from clusters
        for cluster in clusters:
            if len(cluster.episodes) >= 2:  # Need at least 2 episodes to form a pattern
                new_pattern = self.extract_common_pattern(cluster.episodes)
                if new_pattern:
                    # Try to merge with existing
                    merged = False
                    for idx, existing in enumerate(existing_patterns):
                        if self._patterns_similar(new_pattern, existing):
                            # Atomic read-merge-write (BUG-MEM C1, lost-update).
                            # The whole-run snapshot at step 4 can be stale by now:
                            # a concurrent storage.increment_pattern_usage()
                            # (atomic read-mutate-write under one exclusive lock)
                            # may have bumped usage_count/last_used AFTER the
                            # snapshot, and merge_with_existing() builds the merged
                            # record from the base's usage_count/last_used. The
                            # merge now runs INSIDE update_pattern_with_merge's
                            # single lock on patterns.json (the same path
                            # increment_pattern_usage locks), so the merge base is
                            # the live on-disk record and the bump cannot be lost.
                            merged_holder = {}

                            def _merge(current, _np=new_pattern, _holder=merged_holder):
                                base = SemanticPattern.from_dict(current)
                                m = self.merge_with_existing(_np, [base])
                                _holder["pattern"] = m
                                return m

                            if self.storage.update_pattern_with_merge(existing.id, _merge):
                                merged_pattern = merged_holder["pattern"]
                                # Refresh the in-memory copy so a later new pattern
                                # in this same run that also merges into this
                                # existing pattern builds on the just-merged state.
                                existing_patterns[idx] = merged_pattern
                                result.patterns_merged += 1
                                merged = True
                                break

                    if not merged:
                        self.storage.save_pattern(new_pattern)
                        new_patterns.append(new_pattern)
                        all_patterns.append(new_pattern)
                        # Add to existing_patterns so a later cluster pattern in
                        # this same run is deduped against it (mirrors the
                        # anti-pattern step below). Without this, two clusters
                        # producing >=0.8-similar patterns would both take the
                        # create branch, yielding near-duplicate patterns.
                        existing_patterns.append(new_pattern)
                        result.patterns_created += 1

        # 6. Extract anti-patterns from failures
        anti_patterns = self.extract_anti_patterns(failed_episodes)
        # Track only anti-patterns that were persisted under their OWN id (the
        # save_pattern branch). Merged anti-patterns are persisted under the
        # existing pattern's id via update_pattern(merged_pattern); their own
        # fresh uuid was never saved, so linking against it later would update
        # a non-existent record (update_pattern -> False) and drop the links.
        saved_anti_patterns = []
        for anti_pattern in anti_patterns:
            # Check if similar anti-pattern already exists
            merged = False
            for idx, existing in enumerate(existing_patterns):
                if (existing.incorrect_approach and
                    self._patterns_similar(anti_pattern, existing, threshold=0.6)):
                    # Atomic read-merge-write (same C1 lost-update guard as the
                    # cluster merge loop above): merge from the live on-disk record
                    # inside update_pattern_with_merge's single lock so a concurrent
                    # usage bump cannot be clobbered.
                    merged_holder = {}

                    def _merge(current, _ap=anti_pattern, _holder=merged_holder):
                        base = SemanticPattern.from_dict(current)
                        m = self.merge_with_existing(_ap, [base])
                        _holder["pattern"] = m
                        return m

                    if self.storage.update_pattern_with_merge(existing.id, _merge):
                        merged_pattern = merged_holder["pattern"]
                        # Refresh in-memory copy: a later anti-pattern merging into
                        # this same existing pattern must build on the just-merged
                        # state, not the stale pre-merge base.
                        existing_patterns[idx] = merged_pattern
                        result.patterns_merged += 1
                        merged = True
                        break

            if not merged:
                self.storage.save_pattern(anti_pattern)
                all_patterns.append(anti_pattern)
                saved_anti_patterns.append(anti_pattern)
                # Add to existing_patterns so subsequent anti-patterns in this
                # run are checked against it, preventing current-run duplicates.
                existing_patterns.append(anti_pattern)
                result.anti_patterns_created += 1

        # 7. Create Zettelkasten links
        # Only link patterns that were persisted under their own id this run
        # (new_patterns from step 5 + saved_anti_patterns from step 6). Merged
        # patterns already live under an existing id and were updated in place.
        for pattern in new_patterns + saved_anti_patterns:
            links = self.create_zettelkasten_links(pattern, all_patterns)
            if links:
                pattern.links.extend(links)
                # Only count links that actually persisted. update_pattern()
                # returns False when the target id is not on disk; counting
                # unconditionally would inflate links_created.
                if self.storage.update_pattern(pattern):
                    result.links_created += len(links)

        # Flag vector indices as stale when patterns changed (BUG-MEM-007).
        # Callers should rebuild vector indices when this flag is True to
        # ensure semantic search returns up-to-date results.
        if result.patterns_created > 0 or result.patterns_merged > 0 or result.anti_patterns_created > 0:
            result.vector_index_stale = True

        result.duration_seconds = time.time() - start_time
        return result

    # NOTE: The former _reload_pattern() helper (a partial C1 lost-update
    # mitigation that re-read the pattern in a SEPARATE lock from the write) was
    # removed once the merge moved fully inside storage.update_pattern_with_merge,
    # which performs the read, merge, and write under ONE exclusive lock on
    # patterns.json. That closes the lost-update race cross-process; no residual
    # narrow window remains.

    # -------------------------------------------------------------------------
    # Clustering Methods
    # -------------------------------------------------------------------------

    def cluster_by_similarity(
        self,
        episodes: List[EpisodeTrace],
        threshold: float = 0.7
    ) -> List[Cluster]:
        """
        Cluster episodes by embedding similarity.

        Uses the embedding engine to compute similarity between episodes
        and groups them into clusters.

        Args:
            episodes: List of episodes to cluster
            threshold: Similarity threshold for clustering (0-1)

        Returns:
            List of Cluster objects
        """
        if not episodes:
            return []

        if not HAS_NUMPY or self.embedding_engine is None:
            # Fallback to task-type clustering
            return self._clusters_from_task_type(self.cluster_by_task_type(episodes))

        # Compute embeddings for all episodes
        embeddings = []
        for episode in episodes:
            text = self._episode_to_text(episode)
            if hasattr(self.embedding_engine, 'encode'):
                embedding = self.embedding_engine.encode(text)
            elif hasattr(self.embedding_engine, 'embed'):
                embedding = self.embedding_engine.embed(text)
            else:
                # Fallback to task-type clustering
                return self._clusters_from_task_type(self.cluster_by_task_type(episodes))
            embeddings.append(embedding)

        # Simple agglomerative clustering
        clusters = []
        used = set()

        for i, episode in enumerate(episodes):
            if i in used:
                continue

            cluster = Cluster(
                episodes=[episode],
                centroid=embeddings[i],
                label=self._generate_cluster_label([episode])
            )
            used.add(i)
            member_indices = [i]

            # Find similar episodes
            for j, other_episode in enumerate(episodes):
                if j in used:
                    continue

                similarity = self._cosine_similarity(embeddings[i], embeddings[j])
                if similarity >= threshold:
                    cluster.episodes.append(other_episode)
                    used.add(j)
                    member_indices.append(j)

            # Update centroid using tracked indices (avoids O(n) list.index())
            if len(cluster.episodes) > 1:
                cluster_embeddings = [embeddings[idx] for idx in member_indices]
                cluster.centroid = np.mean(cluster_embeddings, axis=0)
                cluster.label = self._generate_cluster_label(cluster.episodes)

            clusters.append(cluster)

        return clusters

    def cluster_by_task_type(
        self,
        episodes: List[EpisodeTrace]
    ) -> Dict[str, List[EpisodeTrace]]:
        """
        Cluster episodes by task type/category.

        This is the fallback clustering method when embeddings are not available.
        Groups episodes by their goal/task similarity using text-based heuristics.

        Args:
            episodes: List of episodes to cluster

        Returns:
            Dictionary mapping task type to list of episodes
        """
        clusters: Dict[str, List[EpisodeTrace]] = defaultdict(list)

        for episode in episodes:
            # Extract task type from goal or agent type
            task_type = self._infer_task_type(episode)
            clusters[task_type].append(episode)

        return dict(clusters)

    def _simple_text_similarity(self, a: str, b: str) -> float:
        """
        Compute Jaccard similarity between two texts.

        Uses word-level Jaccard similarity as a simple fallback
        when embeddings are not available.

        Args:
            a: First text
            b: Second text

        Returns:
            Similarity score between 0 and 1
        """
        if not a or not b:
            return 0.0

        # Tokenize: lowercase and split on whitespace/punctuation
        words_a = set(w.lower() for w in a.split() if len(w) > 2)
        words_b = set(w.lower() for w in b.split() if len(w) > 2)

        if not words_a or not words_b:
            return 0.0

        intersection = len(words_a & words_b)
        union = len(words_a | words_b)

        return intersection / union if union > 0 else 0.0

    def _clusters_from_task_type(
        self,
        task_clusters: Dict[str, List[EpisodeTrace]]
    ) -> List[Cluster]:
        """Convert task-type dictionary to list of Cluster objects."""
        return [
            Cluster(episodes=episodes, label=task_type)
            for task_type, episodes in task_clusters.items()
        ]

    def _infer_task_type(self, episode: EpisodeTrace) -> str:
        """Infer task type from episode goal and agent type."""
        goal = episode.goal.lower() if episode.goal else ""
        agent = episode.agent.lower() if episode.agent else ""

        # Common task type patterns
        if any(w in goal for w in ["test", "spec", "verify"]):
            return "testing"
        elif any(w in goal for w in ["fix", "bug", "error", "debug"]):
            return "debugging"
        elif any(w in goal for w in ["implement", "create", "build", "add"]):
            return "implementation"
        elif any(w in goal for w in ["refactor", "clean", "improve"]):
            return "refactoring"
        elif any(w in goal for w in ["deploy", "release", "publish"]):
            return "deployment"
        elif any(w in goal for w in ["document", "readme", "docs"]):
            return "documentation"
        elif any(w in goal for w in ["review", "analyze", "check"]):
            return "review"
        elif "architect" in agent or "design" in goal:
            return "architecture"
        else:
            return "general"

    def _episode_to_text(self, episode: EpisodeTrace) -> str:
        """Convert episode to text for embedding."""
        # Guard explicit-null goal (C2): from_dict's .get(key, default) returns
        # None on a JSON null, and the " ".join(parts) below crashes on a None
        # member. Mirror the wave-6 (episode.goal or "") idiom.
        parts = [episode.goal or ""]

        # Add action summaries (handle both ActionEntry objects and dicts)
        for action in episode.action_log[:5]:  # Limit to first 5 actions
            if isinstance(action, dict):
                tool = action.get("tool", action.get("action", ""))
                inp = action.get("input", action.get("target", ""))
            else:
                tool = action.tool
                inp = action.input
            parts.append(f"{tool}: {str(inp)[:100]}")

        # Add error types (handle both ErrorEntry objects and dicts)
        for error in episode.errors_encountered:
            if isinstance(error, dict):
                err_type = error.get("error_type", error.get("type", ""))
            else:
                err_type = error.error_type
            parts.append(f"Error: {err_type}")

        return " ".join(parts)

    def _generate_cluster_label(self, episodes: List[EpisodeTrace]) -> str:
        """Generate a human-readable label for a cluster."""
        if not episodes:
            return "empty"

        # Find common words in goals
        all_words: Dict[str, int] = defaultdict(int)
        for episode in episodes:
            # Guard explicit-null goal (C2): None has no .lower().
            for word in (episode.goal or "").lower().split():
                if len(word) > 3:
                    all_words[word] += 1

        # Get top common words
        common = sorted(all_words.items(), key=lambda x: x[1], reverse=True)[:3]
        if common:
            return "_".join(w for w, _ in common)

        return f"cluster_{len(episodes)}"

    def _cosine_similarity(self, a: Any, b: Any) -> float:
        """Compute cosine similarity between two vectors."""
        if not HAS_NUMPY:
            return 0.0

        a = np.asarray(a)
        b = np.asarray(b)

        dot = np.dot(a, b)
        norm_a = np.linalg.norm(a)
        norm_b = np.linalg.norm(b)

        if norm_a == 0 or norm_b == 0:
            return 0.0

        return float(dot / (norm_a * norm_b))

    # -------------------------------------------------------------------------
    # Pattern Extraction
    # -------------------------------------------------------------------------

    def extract_common_pattern(
        self,
        cluster: List[EpisodeTrace]
    ) -> Optional[SemanticPattern]:
        """
        Extract a common pattern from a cluster of similar episodes.

        Analyzes the cluster to find:
        - Common actions and tools used
        - Common outcomes and success factors
        - Conditions under which the pattern applies

        Args:
            cluster: List of similar episodes

        Returns:
            SemanticPattern or None if no pattern can be extracted
        """
        if len(cluster) < 2:
            return None

        # Find common tools/actions
        tool_counts: Dict[str, int] = defaultdict(int)
        for episode in cluster:
            for action in episode.action_log:
                # Skip explicit-null tools (C2): an explicit JSON null tool would
                # become a None dict key here, harmless until ", ".join(common_tools)
                # at the end of _extract_correct_approach crashes on it.
                if action.tool:
                    tool_counts[action.tool] += 1

        # Filter to tools used in most episodes
        common_tools = [
            tool for tool, count in tool_counts.items()
            if count >= len(cluster) * 0.5
        ]

        # Find common goal patterns
        goals = [ep.goal for ep in cluster]
        pattern_desc = compress_episodes_to_pattern_desc(cluster)

        # Extract conditions from goals
        conditions = self._extract_conditions(cluster)

        # Generate correct approach from successful actions
        correct_approach = self._extract_correct_approach(cluster, common_tools)

        # Calculate confidence based on cluster size and consistency
        confidence = min(0.5 + (len(cluster) * 0.1), 0.95)

        # Determine category
        category = self._infer_task_type(cluster[0])

        pattern = SemanticPattern.create(
            pattern=pattern_desc,
            category=category,
            conditions=conditions,
            correct_approach=correct_approach,
        )

        pattern.confidence = confidence
        pattern.source_episodes = [ep.id for ep in cluster]

        return pattern

    def extract_anti_patterns(
        self,
        failed_episodes: List[EpisodeTrace]
    ) -> List[SemanticPattern]:
        """
        Extract anti-patterns from failed episodes.

        Analyzes failures to identify:
        - Common error types and their causes
        - Actions that led to failures
        - Patterns to avoid

        Args:
            failed_episodes: List of episodes that resulted in failure

        Returns:
            List of anti-pattern SemanticPatterns
        """
        if not failed_episodes:
            return []

        # Group failures by error type (use set to avoid duplicate episodes)
        error_groups: Dict[str, List[EpisodeTrace]] = defaultdict(list)
        seen_episodes: Dict[str, set] = defaultdict(set)
        for episode in failed_episodes:
            for err_entry in episode.errors_encountered:
                if episode.id not in seen_episodes[err_entry.error_type]:
                    error_groups[err_entry.error_type].append(episode)
                    seen_episodes[err_entry.error_type].add(episode.id)

        anti_patterns = []

        for error_type, episodes in error_groups.items():
            if len(episodes) < 1:
                continue

            # Find common actions leading to this error
            pre_error_actions = []
            resolutions = []

            for episode in episodes:
                # Get actions before error
                if episode.action_log:
                    # Filter explicit-null tools (C2): pre_error_actions feeds
                    # _summarize_actions, whose ", ".join crashes on a None member.
                    pre_error_actions.extend(
                        [a.tool for a in episode.action_log[-3:] if a.tool]  # Last 3 actions
                    )

                # Collect resolutions
                for err_entry in episode.errors_encountered:
                    if err_entry.error_type == error_type and err_entry.resolution:
                        resolutions.append(err_entry.resolution)

            # Create anti-pattern
            incorrect_approach = self._summarize_actions(pre_error_actions)
            correct_approach = self._summarize_resolutions(resolutions) if resolutions else ""

            pattern = SemanticPattern.create(
                pattern=f"Avoid: {error_type}",
                category="anti-pattern",
                conditions=[f"When encountering: {error_type}"],
                correct_approach=correct_approach,
                incorrect_approach=incorrect_approach,
            )

            pattern.confidence = min(0.4 + (len(episodes) * 0.1), 0.8)
            pattern.source_episodes = [ep.id for ep in episodes]

            anti_patterns.append(pattern)

        return anti_patterns

    def _extract_conditions(self, cluster: List[EpisodeTrace]) -> List[str]:
        """Extract common conditions from a cluster of episodes."""
        conditions = []

        # Check for common phase
        phases = [ep.phase for ep in cluster if ep.phase]
        if phases:
            common_phase = max(set(phases), key=phases.count)
            if phases.count(common_phase) >= len(cluster) * 0.5:
                conditions.append(f"During {common_phase} phase")

        # Check for common file patterns
        all_files = []
        for ep in cluster:
            all_files.extend(ep.files_read + ep.files_modified)

        if all_files:
            # Find common file extensions
            extensions = [f.split('.')[-1] for f in all_files if '.' in f]
            if extensions:
                common_ext = max(set(extensions), key=extensions.count)
                if extensions.count(common_ext) >= len(cluster):
                    conditions.append(f"When working with .{common_ext} files")

        return conditions[:3]  # Limit to 3 conditions

    def _extract_correct_approach(
        self,
        cluster: List[EpisodeTrace],
        common_tools: List[str]
    ) -> str:
        """Extract the correct approach from successful episodes."""
        if not common_tools:
            return ""

        steps = []

        # Build sequence of common tools
        tool_sequences: Dict[Tuple[str, ...], int] = defaultdict(int)
        for episode in cluster:
            tools = tuple(a.tool for a in episode.action_log[:5])
            tool_sequences[tools] += 1

        # Find most common sequence
        if tool_sequences:
            common_seq = max(tool_sequences.items(), key=lambda x: x[1])[0]
            for i, tool in enumerate(common_seq[:5], 1):
                steps.append(f"{i}. Use {tool}")

        # Defensively drop any None tool before join (C2): callers filter Nones,
        # but guard here too since this join crashes on a None member.
        return "; ".join(steps) if steps else f"Use: {', '.join(t for t in common_tools if t)}"

    def _summarize_actions(self, actions: List[str]) -> str:
        """Summarize a list of actions into a description."""
        if not actions:
            return ""

        action_counts = defaultdict(int)
        for action in actions:
            action_counts[action] += 1

        top_actions = sorted(action_counts.items(), key=lambda x: x[1], reverse=True)[:3]
        return "Common actions before failure: " + ", ".join(a for a, _ in top_actions)

    def _summarize_resolutions(self, resolutions: List[str]) -> str:
        """Summarize resolutions into a correct approach."""
        if not resolutions:
            return ""

        # Return most common resolution or first one
        resolution_counts = defaultdict(int)
        for r in resolutions:
            resolution_counts[r] += 1

        return max(resolution_counts.items(), key=lambda x: x[1])[0]

    # -------------------------------------------------------------------------
    # Pattern Merging
    # -------------------------------------------------------------------------

    def merge_with_existing(
        self,
        new_pattern: SemanticPattern,
        existing: List[SemanticPattern]
    ) -> SemanticPattern:
        """
        Merge a new pattern with existing similar patterns.

        If a similar pattern exists, the patterns are merged:
        - Confidence is increased
        - Source episodes are combined
        - Conditions are merged

        Args:
            new_pattern: The new pattern to merge
            existing: List of existing patterns to check against

        Returns:
            Merged pattern (or new_pattern if no match found)
        """
        if not existing:
            return new_pattern

        # Find most similar existing pattern
        best_match = None
        best_similarity = 0.0

        for pattern in existing:
            similarity = self._pattern_similarity_score(new_pattern, pattern)
            if similarity > best_similarity:
                best_similarity = similarity
                best_match = pattern

        if best_match is None or best_similarity < 0.5:
            return new_pattern

        # Idempotency guard (consolidation-C4): only boost confidence when the
        # merge actually introduces NEW evidence. consolidate() reloads every
        # episode in the since-window on each run (storage.list_episodes has no
        # consolidated-state filter), so re-running over an unchanged episode set
        # re-extracts identical patterns that re-match this existing pattern. A
        # flat +0.05 every time would ratchet confidence up artificially with no
        # new data. Comparing source_episodes (which round-trips through storage)
        # makes the merge a no-op for confidence when no new source episode is
        # present, while still rewarding a genuinely new similar episode.
        new_source_episodes = (
            set(new_pattern.source_episodes) - set(best_match.source_episodes)
        )
        confidence_boost = 0.05 if new_source_episodes else 0.0

        # Merge patterns
        merged = SemanticPattern(
            id=best_match.id,
            pattern=best_match.pattern,  # Keep existing description
            category=best_match.category,
            conditions=list(set(best_match.conditions + new_pattern.conditions)),
            correct_approach=best_match.correct_approach or new_pattern.correct_approach,
            incorrect_approach=best_match.incorrect_approach or new_pattern.incorrect_approach,
            confidence=min(best_match.confidence + confidence_boost, 0.99),
            source_episodes=list(set(best_match.source_episodes + new_pattern.source_episodes)),
            usage_count=best_match.usage_count,
            last_used=best_match.last_used,
            links=best_match.links.copy(),
            # Preserve retrieval/decay-relevant fields. The constructor previously
            # omitted these, so the merged pattern fell back to schema defaults
            # (importance=0.5, access_count=0, last_accessed=None), resetting a hot,
            # high-importance pattern to the floor on every merge and corrupting
            # apply_decay() + importance-weighted ranking in retrieval.
            importance=max(best_match.importance, new_pattern.importance),
            access_count=best_match.access_count,
            last_accessed=best_match.last_accessed,
        )

        return merged

    def _patterns_similar(
        self,
        a: SemanticPattern,
        b: SemanticPattern,
        threshold: float = 0.8
    ) -> bool:
        """
        Check if two patterns are similar enough to merge.

        Args:
            a: First pattern
            b: Second pattern
            threshold: Similarity threshold (0-1)

        Returns:
            True if patterns are similar
        """
        return self._pattern_similarity_score(a, b) >= threshold

    def _pattern_similarity_score(
        self,
        a: SemanticPattern,
        b: SemanticPattern
    ) -> float:
        """Compute similarity score between two patterns."""
        # Compare pattern descriptions
        desc_sim = self._simple_text_similarity(a.pattern, b.pattern)

        # Compare categories
        cat_sim = 1.0 if a.category == b.category else 0.0

        # Compare conditions
        cond_sim = 0.0
        if a.conditions and b.conditions:
            a_conds = set(c.lower() for c in a.conditions)
            b_conds = set(c.lower() for c in b.conditions)
            if a_conds or b_conds:
                cond_sim = len(a_conds & b_conds) / len(a_conds | b_conds)

        # Weighted average
        return (desc_sim * 0.5) + (cat_sim * 0.3) + (cond_sim * 0.2)

    # -------------------------------------------------------------------------
    # Zettelkasten Linking
    # -------------------------------------------------------------------------

    def create_zettelkasten_links(
        self,
        pattern: SemanticPattern,
        all_patterns: List[SemanticPattern]
    ) -> List[Link]:
        """
        Create Zettelkasten-style links between patterns.

        Links are created based on:
        - Category relationships (related_to)
        - Source episode overlaps (derived_from)
        - Contradiction detection (contradicts)
        - Support detection (supports)

        Args:
            pattern: Pattern to create links for
            all_patterns: All available patterns

        Returns:
            List of Link objects
        """
        links = []
        existing_link_ids = {link.to_id for link in pattern.links}

        for other in all_patterns:
            if other.id == pattern.id or other.id in existing_link_ids:
                continue

            # Related by category
            if other.category == pattern.category:
                similarity = self._pattern_similarity_score(pattern, other)
                if 0.3 <= similarity < 0.8:
                    links.append(Link(
                        to_id=other.id,
                        relation="related_to",
                        strength=similarity
                    ))

            # Derived from (shared source episodes)
            shared_episodes = set(pattern.source_episodes) & set(other.source_episodes)
            if shared_episodes and len(shared_episodes) >= 1:
                strength = len(shared_episodes) / max(
                    len(pattern.source_episodes), len(other.source_episodes), 1
                )
                links.append(Link(
                    to_id=other.id,
                    relation="derived_from",
                    strength=min(strength, 1.0)
                ))

            # Contradiction detection
            if self._patterns_contradict(pattern, other):
                links.append(Link(
                    to_id=other.id,
                    relation="contradicts",
                    strength=0.8
                ))

            # Support detection
            if self._patterns_support(pattern, other):
                links.append(Link(
                    to_id=other.id,
                    relation="supports",
                    strength=0.7
                ))

        # Deduplicate and limit links
        seen = set()
        unique_links = []
        for link in links:
            key = (link.to_id, link.relation)
            if key not in seen:
                seen.add(key)
                unique_links.append(link)

        return unique_links[:10]  # Limit to 10 links per pattern

    def _patterns_contradict(self, a: SemanticPattern, b: SemanticPattern) -> bool:
        """Check if two patterns contradict each other."""
        # Pattern vs anti-pattern
        if a.category == "anti-pattern" and b.category != "anti-pattern":
            # Check if they're about the same topic
            if self._simple_text_similarity(a.pattern, b.pattern) > 0.4:
                return True

        # Opposite approaches
        if a.correct_approach and b.incorrect_approach:
            if self._simple_text_similarity(a.correct_approach, b.incorrect_approach) > 0.5:
                return True

        if b.correct_approach and a.incorrect_approach:
            if self._simple_text_similarity(b.correct_approach, a.incorrect_approach) > 0.5:
                return True

        return False

    def _patterns_support(self, a: SemanticPattern, b: SemanticPattern) -> bool:
        """Check if two patterns support each other."""
        # Same category and similar approaches
        if a.category == b.category and a.category != "anti-pattern":
            if a.correct_approach and b.correct_approach:
                if self._simple_text_similarity(a.correct_approach, b.correct_approach) > 0.5:
                    return True

        return False


# -----------------------------------------------------------------------------
# Compression Functions
# -----------------------------------------------------------------------------


def compress_episode_to_summary(episode: EpisodeTrace) -> str:
    """
    Compress an episode into a 1-2 sentence summary.

    Args:
        episode: The episode to summarize

    Returns:
        Brief summary string
    """
    outcome = "succeeded" if episode.outcome == "success" else "failed"
    action_count = len(episode.action_log)
    error_count = len(episode.errors_encountered)

    # Guard explicit-null goal (C2): None is not subscriptable.
    summary = f"Task '{(episode.goal or '')[:50]}' {outcome}"

    if action_count > 0:
        summary += f" after {action_count} actions"

    if error_count > 0:
        summary += f" with {error_count} errors encountered"

    if episode.duration_seconds > 0:
        summary += f" in {episode.duration_seconds}s"

    return summary + "."


def compress_episodes_to_pattern_desc(episodes: List[EpisodeTrace]) -> str:
    """
    Compress multiple episodes into a pattern description.

    Finds common elements across episodes and generates a generalized
    description of the pattern.

    Args:
        episodes: List of episodes to compress

    Returns:
        Pattern description string
    """
    if not episodes:
        return "Unknown pattern"

    if len(episodes) == 1:
        # No slice here, so a None goal would f-string as "None" without crashing;
        # normalize to "" for cleaner output (C2).
        return f"Pattern from: {episodes[0].goal or ''}"

    # Find common goal elements
    # Guard explicit-null goal (C2): None has no .lower().
    goals = [(ep.goal or "").lower() for ep in episodes]

    # Find common words
    word_counts: Dict[str, int] = defaultdict(int)
    for goal in goals:
        for word in goal.split():
            if len(word) > 3:
                word_counts[word] += 1

    # Get words appearing in most goals
    common_words = [
        word for word, count in word_counts.items()
        if count >= len(episodes) * 0.5
    ]

    if common_words:
        theme = " ".join(common_words[:5])
        return f"Pattern for {theme} tasks ({len(episodes)} instances)"

    # Fallback to first episode's goal
    # Guard explicit-null goal (C2): None is not subscriptable.
    return f"Pattern: {(episodes[0].goal or '')[:100]} (and {len(episodes)-1} similar)"
