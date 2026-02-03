"""
Loki Mode Memory System - Episodic to Semantic Consolidation

This module handles the transformation of episodic memories into semantic patterns.
Implements clustering, pattern extraction, anti-pattern detection, and Zettelkasten linking.

See references/memory-system.md for full documentation.
"""

from __future__ import annotations

import uuid
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
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
    """
    patterns_created: int = 0
    patterns_merged: int = 0
    anti_patterns_created: int = 0
    links_created: int = 0
    episodes_processed: int = 0
    duration_seconds: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "patterns_created": self.patterns_created,
            "patterns_merged": self.patterns_merged,
            "anti_patterns_created": self.anti_patterns_created,
            "links_created": self.links_created,
            "episodes_processed": self.episodes_processed,
            "duration_seconds": self.duration_seconds,
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
            "episode_ids": [ep.id if hasattr(ep, 'id') else ep.get('id', '') for ep in self.episodes],
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

        Args:
            since_hours: Only process episodes from the last N hours

        Returns:
            ConsolidationResult with statistics about the consolidation run
        """
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
                    for existing in existing_patterns:
                        if self._patterns_similar(new_pattern, existing):
                            merged_pattern = self.merge_with_existing(new_pattern, [existing])
                            self.storage.update_pattern(merged_pattern)
                            result.patterns_merged += 1
                            merged = True
                            break

                    if not merged:
                        self.storage.save_pattern(new_pattern)
                        new_patterns.append(new_pattern)
                        all_patterns.append(new_pattern)
                        result.patterns_created += 1

        # 6. Extract anti-patterns from failures
        anti_patterns = self.extract_anti_patterns(failed_episodes)
        for anti_pattern in anti_patterns:
            # Check if similar anti-pattern already exists
            merged = False
            for existing in existing_patterns:
                if (existing.incorrect_approach and
                    self._patterns_similar(anti_pattern, existing, threshold=0.6)):
                    merged_pattern = self.merge_with_existing(anti_pattern, [existing])
                    self.storage.update_pattern(merged_pattern)
                    result.patterns_merged += 1
                    merged = True
                    break

            if not merged:
                self.storage.save_pattern(anti_pattern)
                all_patterns.append(anti_pattern)
                result.anti_patterns_created += 1

        # 7. Create Zettelkasten links
        for pattern in new_patterns + anti_patterns:
            links = self.create_zettelkasten_links(pattern, all_patterns)
            if links:
                pattern.links.extend(links)
                self.storage.update_pattern(pattern)
                result.links_created += len(links)

        result.duration_seconds = time.time() - start_time
        return result

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

            # Find similar episodes
            for j, other_episode in enumerate(episodes):
                if j in used:
                    continue

                similarity = self._cosine_similarity(embeddings[i], embeddings[j])
                if similarity >= threshold:
                    cluster.episodes.append(other_episode)
                    used.add(j)

            # Update centroid
            if len(cluster.episodes) > 1:
                cluster_embeddings = [embeddings[episodes.index(ep)] for ep in cluster.episodes]
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
        parts = [episode.goal]

        # Add action summaries
        for action in episode.action_log[:5]:  # Limit to first 5 actions
            parts.append(f"{action.tool}: {action.input[:100]}")

        # Add error types
        for error in episode.errors_encountered:
            parts.append(f"Error: {error.error_type}")

        return " ".join(parts)

    def _generate_cluster_label(self, episodes: List[EpisodeTrace]) -> str:
        """Generate a human-readable label for a cluster."""
        if not episodes:
            return "empty"

        # Find common words in goals
        all_words: Dict[str, int] = defaultdict(int)
        for episode in episodes:
            for word in episode.goal.lower().split():
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

        # Group failures by error type
        error_groups: Dict[str, List[EpisodeTrace]] = defaultdict(list)
        for episode in failed_episodes:
            for error in episode.errors_encountered:
                error_groups[error.error_type].append(episode)

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
                    pre_error_actions.extend(
                        [a.tool for a in episode.action_log[-3:]]  # Last 3 actions
                    )

                # Collect resolutions
                for error in episode.errors_encountered:
                    if error.error_type == error_type and error.resolution:
                        resolutions.append(error.resolution)

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

        return "; ".join(steps) if steps else f"Use: {', '.join(common_tools)}"

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

        # Merge patterns
        merged = SemanticPattern(
            id=best_match.id,
            pattern=best_match.pattern,  # Keep existing description
            category=best_match.category,
            conditions=list(set(best_match.conditions + new_pattern.conditions)),
            correct_approach=best_match.correct_approach or new_pattern.correct_approach,
            incorrect_approach=best_match.incorrect_approach or new_pattern.incorrect_approach,
            confidence=min(best_match.confidence + 0.05, 0.99),
            source_episodes=list(set(best_match.source_episodes + new_pattern.source_episodes)),
            usage_count=best_match.usage_count,
            last_used=best_match.last_used,
            links=best_match.links.copy(),
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

    summary = f"Task '{episode.goal[:50]}' {outcome}"

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
        return f"Pattern from: {episodes[0].goal}"

    # Find common goal elements
    goals = [ep.goal.lower() for ep in episodes]

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
    return f"Pattern: {episodes[0].goal[:100]} (and {len(episodes)-1} similar)"
