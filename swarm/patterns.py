"""
Loki Mode Swarm Patterns - Coordination pattern implementations.

This module implements the four core swarm patterns:
1. Voting: Agents vote on decisions
2. Consensus: Agents reach agreement on approaches
3. Delegation: Tasks distributed based on expertise
4. Emergence: Combined insights create new knowledge
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from .messages import (
    Vote,
    VoteChoice,
    Proposal,
    TaskAssignment,
    SwarmMessage,
    MessageType,
)
from .registry import AgentInfo, AgentRegistry


@dataclass
class PatternResult:
    """Base result class for swarm patterns."""
    success: bool
    pattern_name: str
    duration_ms: int
    participants: List[str]
    metadata: Dict[str, Any] = field(default_factory=dict)


class SwarmPattern(ABC):
    """Abstract base class for swarm coordination patterns."""

    @abstractmethod
    def execute(self, context: Dict[str, Any]) -> PatternResult:
        """Execute the pattern with the given context."""
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        """Name of the pattern."""
        pass


@dataclass
class VotingResult(PatternResult):
    """Result of a voting pattern execution."""
    decision: str = ""
    vote_counts: Dict[str, int] = field(default_factory=dict)
    votes: List[Vote] = field(default_factory=list)
    quorum_reached: bool = True
    unanimous: bool = False


class VotingPattern(SwarmPattern):
    """
    Voting pattern for collective decision making.

    Agents vote on proposals/decisions and the outcome is determined
    by the voting rules (majority, supermajority, unanimous).
    """

    def __init__(
        self,
        registry: AgentRegistry,
        quorum_percent: float = 0.5,
        approval_threshold: float = 0.5,
        weighted: bool = False,
    ):
        """
        Initialize voting pattern.

        Args:
            registry: Agent registry for looking up voters
            quorum_percent: Minimum participation required (0.0 to 1.0)
            approval_threshold: Votes needed to approve (0.0 to 1.0)
            weighted: Whether to weight votes by agent proficiency
        """
        self.registry = registry
        self.quorum_percent = quorum_percent
        self.approval_threshold = approval_threshold
        self.weighted = weighted

    @property
    def name(self) -> str:
        return "voting"

    def execute(self, context: Dict[str, Any]) -> VotingResult:
        """
        Execute voting pattern.

        Context should include:
        - question: The question being voted on
        - voters: List of voter IDs (optional, uses all available if not specified)
        - votes: List of Vote objects

        Returns:
            VotingResult with decision and vote counts
        """
        start_time = datetime.now(timezone.utc)

        question = context.get("question", "")
        voter_ids = context.get("voters", [])
        votes: List[Vote] = context.get("votes", [])

        # Get eligible voters
        if not voter_ids:
            available_agents = self.registry.get_available()
            voter_ids = [a.id for a in available_agents]

        total_voters = len(voter_ids)
        if total_voters == 0:
            return VotingResult(
                success=False,
                pattern_name=self.name,
                duration_ms=0,
                participants=[],
                decision="no_voters",
                quorum_reached=False,
            )

        # Count votes
        vote_counts = {
            VoteChoice.APPROVE.value: 0,
            VoteChoice.REJECT.value: 0,
            VoteChoice.ABSTAIN.value: 0,
        }

        weighted_approve = 0.0
        weighted_reject = 0.0
        total_weight = 0.0

        participants = []
        for vote in votes:
            participants.append(vote.voter_id)
            vote_counts[vote.choice.value] += 1

            if self.weighted:
                # Weight by confidence
                weight = vote.confidence
                total_weight += weight
                if vote.choice == VoteChoice.APPROVE:
                    weighted_approve += weight
                elif vote.choice == VoteChoice.REJECT:
                    weighted_reject += weight

        # Check quorum
        participation_rate = len(votes) / total_voters
        quorum_reached = participation_rate >= self.quorum_percent

        # Determine decision
        if self.weighted and total_weight > 0:
            approve_ratio = weighted_approve / total_weight
        else:
            # Non-weighted: count only approve/reject (not abstain)
            voting_count = vote_counts[VoteChoice.APPROVE.value] + vote_counts[VoteChoice.REJECT.value]
            if voting_count > 0:
                approve_ratio = vote_counts[VoteChoice.APPROVE.value] / voting_count
            else:
                approve_ratio = 0.0

        if quorum_reached and approve_ratio >= self.approval_threshold:
            decision = "approved"
        elif quorum_reached:
            decision = "rejected"
        else:
            decision = "no_quorum"

        # Check if unanimous
        unanimous = (
            vote_counts[VoteChoice.APPROVE.value] == len(votes) or
            vote_counts[VoteChoice.REJECT.value] == len(votes)
        )

        end_time = datetime.now(timezone.utc)
        duration_ms = int((end_time - start_time).total_seconds() * 1000)

        return VotingResult(
            success=quorum_reached,
            pattern_name=self.name,
            duration_ms=duration_ms,
            participants=participants,
            decision=decision,
            vote_counts=vote_counts,
            votes=votes,
            quorum_reached=quorum_reached,
            unanimous=unanimous,
            metadata={
                "question": question,
                "total_voters": total_voters,
                "participation_rate": participation_rate,
                "approve_ratio": approve_ratio,
                "weighted": self.weighted,
            },
        )


@dataclass
class ConsensusResult(PatternResult):
    """Result of a consensus pattern execution."""
    consensus_reached: bool = False
    agreed_option: Optional[str] = None
    support_level: float = 0.0
    rounds: int = 1
    proposal: Optional[Proposal] = None


class ConsensusPattern(SwarmPattern):
    """
    Consensus pattern for reaching agreement.

    Agents propose and discuss options until consensus is reached
    or the pattern times out.
    """

    def __init__(
        self,
        registry: AgentRegistry,
        consensus_threshold: float = 0.67,
        max_rounds: int = 3,
        allow_abstentions: bool = True,
    ):
        """
        Initialize consensus pattern.

        Args:
            registry: Agent registry
            consensus_threshold: Support level needed for consensus (0.0 to 1.0)
            max_rounds: Maximum discussion rounds
            allow_abstentions: Whether to allow abstentions
        """
        self.registry = registry
        self.consensus_threshold = consensus_threshold
        self.max_rounds = max_rounds
        self.allow_abstentions = allow_abstentions

    @property
    def name(self) -> str:
        return "consensus"

    def execute(self, context: Dict[str, Any]) -> ConsensusResult:
        """
        Execute consensus pattern.

        Context should include:
        - proposal: Proposal object
        - participants: List of participant IDs
        - responses: Dict mapping agent_id to "support", "oppose", or "abstain"

        Returns:
            ConsensusResult with consensus status
        """
        start_time = datetime.now(timezone.utc)

        proposal: Optional[Proposal] = context.get("proposal")
        participant_ids = context.get("participants", [])
        responses: Dict[str, str] = context.get("responses", {})
        current_round = context.get("round", 1)

        if not proposal:
            return ConsensusResult(
                success=False,
                pattern_name=self.name,
                duration_ms=0,
                participants=[],
                consensus_reached=False,
            )

        if not participant_ids:
            available_agents = self.registry.get_available()
            participant_ids = [a.id for a in available_agents]

        total_participants = len(participant_ids)
        if total_participants == 0:
            return ConsensusResult(
                success=False,
                pattern_name=self.name,
                duration_ms=0,
                participants=[],
                consensus_reached=False,
                proposal=proposal,
            )

        # Process responses
        for agent_id, response in responses.items():
            if response == "support":
                proposal.add_support(agent_id)
            elif response == "oppose":
                proposal.add_opposition(agent_id)
            elif response == "abstain" and self.allow_abstentions:
                proposal.add_abstention(agent_id)

        # Calculate support level
        responding_count = len(proposal.supporters) + len(proposal.opposers)
        if not self.allow_abstentions:
            responding_count = total_participants

        if responding_count > 0:
            support_level = len(proposal.supporters) / responding_count
        else:
            support_level = 0.0

        # Check if consensus reached
        consensus_reached = support_level >= self.consensus_threshold

        # Determine agreed option
        agreed_option = None
        if consensus_reached and proposal.options:
            # Select first option by default (could be extended for ranked choice)
            agreed_option = proposal.options[0] if proposal.options else proposal.title

        # Update proposal status
        if consensus_reached:
            proposal.status = "consensus_reached"
        elif current_round >= self.max_rounds:
            proposal.status = "failed"
        else:
            proposal.status = "in_progress"

        end_time = datetime.now(timezone.utc)
        duration_ms = int((end_time - start_time).total_seconds() * 1000)

        return ConsensusResult(
            success=consensus_reached,
            pattern_name=self.name,
            duration_ms=duration_ms,
            participants=participant_ids,
            consensus_reached=consensus_reached,
            agreed_option=agreed_option,
            support_level=support_level,
            rounds=current_round,
            proposal=proposal,
            metadata={
                "supporters": len(proposal.supporters),
                "opposers": len(proposal.opposers),
                "abstainers": len(proposal.abstainers),
                "threshold": self.consensus_threshold,
                "max_rounds": self.max_rounds,
            },
        )


@dataclass
class DelegationResult(PatternResult):
    """Result of a delegation pattern execution."""
    delegated: bool = False
    delegate_id: Optional[str] = None
    assignment: Optional[TaskAssignment] = None
    fallback_used: bool = False
    candidates_evaluated: int = 0


class DelegationPattern(SwarmPattern):
    """
    Delegation pattern for task distribution.

    Matches tasks to agents based on capabilities and load,
    with fallback strategies for no-match scenarios.
    """

    def __init__(
        self,
        registry: AgentRegistry,
        capability_match_threshold: float = 0.5,
        consider_load: bool = True,
        allow_fallback: bool = True,
    ):
        """
        Initialize delegation pattern.

        Args:
            registry: Agent registry
            capability_match_threshold: Minimum capability match score
            consider_load: Whether to consider agent workload
            allow_fallback: Whether to use fallback strategies
        """
        self.registry = registry
        self.capability_match_threshold = capability_match_threshold
        self.consider_load = consider_load
        self.allow_fallback = allow_fallback

    @property
    def name(self) -> str:
        return "delegation"

    def execute(self, context: Dict[str, Any]) -> DelegationResult:
        """
        Execute delegation pattern.

        Context should include:
        - assignment: TaskAssignment object
        - candidates: List of candidate agent IDs (optional)

        Returns:
            DelegationResult with delegation status
        """
        start_time = datetime.now(timezone.utc)

        assignment: Optional[TaskAssignment] = context.get("assignment")
        candidate_ids = context.get("candidates", [])

        if not assignment:
            return DelegationResult(
                success=False,
                pattern_name=self.name,
                duration_ms=0,
                participants=[],
                delegated=False,
            )

        # Get candidates
        if candidate_ids:
            candidates = [self.registry.get(cid) for cid in candidate_ids]
            candidates = [c for c in candidates if c is not None]
        else:
            candidates = self.registry.get_available()

        if not candidates:
            return DelegationResult(
                success=False,
                pattern_name=self.name,
                duration_ms=0,
                participants=[],
                delegated=False,
                assignment=assignment,
            )

        # Score candidates
        scored_candidates: List[Tuple[AgentInfo, float]] = []

        for candidate in candidates:
            score = self._score_candidate(candidate, assignment.required_capabilities)
            if score >= self.capability_match_threshold:
                scored_candidates.append((candidate, score))

        # Sort by score descending
        scored_candidates.sort(key=lambda x: x[1], reverse=True)

        # Select best candidate
        delegate = None
        fallback_used = False

        if scored_candidates:
            delegate = scored_candidates[0][0]
        elif self.allow_fallback and candidates:
            # Fallback: select least busy agent
            delegate = min(candidates, key=lambda a: a.tasks_completed + a.tasks_failed)
            fallback_used = True

        # Update assignment
        if delegate:
            assignment.delegate_id = delegate.id
            assignment.status = "assigned"
        else:
            assignment.status = "unassigned"

        end_time = datetime.now(timezone.utc)
        duration_ms = int((end_time - start_time).total_seconds() * 1000)

        return DelegationResult(
            success=delegate is not None,
            pattern_name=self.name,
            duration_ms=duration_ms,
            participants=[c.id for c in candidates],
            delegated=delegate is not None,
            delegate_id=delegate.id if delegate else None,
            assignment=assignment,
            fallback_used=fallback_used,
            candidates_evaluated=len(candidates),
            metadata={
                "required_capabilities": assignment.required_capabilities,
                "scored_candidates_count": len(scored_candidates),
                "threshold": self.capability_match_threshold,
            },
        )

    def _score_candidate(self, candidate: AgentInfo, required_capabilities: List[str]) -> float:
        """Score a candidate agent for a task."""
        if not required_capabilities:
            return 0.5  # Neutral score if no requirements

        matched_proficiency = 0.0
        matched_count = 0

        for cap_name in required_capabilities:
            cap = candidate.get_capability(cap_name)
            if cap:
                matched_proficiency += cap.proficiency
                matched_count += 1

        if matched_count == 0:
            return 0.0

        # Average proficiency * coverage ratio
        avg_proficiency = matched_proficiency / matched_count
        coverage = matched_count / len(required_capabilities)

        # Consider load if enabled
        load_factor = 1.0
        if self.consider_load:
            total_tasks = candidate.tasks_completed + candidate.tasks_failed + 1
            load_factor = 1.0 - (0.1 * min(10, total_tasks))  # Reduce score for busy agents

        return avg_proficiency * coverage * load_factor


@dataclass
class EmergentInsight:
    """
    An insight that emerged from combined agent observations.

    Attributes:
        id: Unique identifier
        insight: The emergent insight
        contributors: Agents that contributed
        confidence: Confidence level (0.0 to 1.0)
        supporting_observations: Raw observations that led to this insight
        category: Category of insight
    """
    id: str
    insight: str
    contributors: List[str]
    confidence: float
    supporting_observations: List[str]
    category: str = "general"
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "insight": self.insight,
            "contributors": self.contributors,
            "confidence": self.confidence,
            "supporting_observations": self.supporting_observations,
            "category": self.category,
            "created_at": self.created_at.isoformat() + "Z",
        }


@dataclass
class EmergenceResult(PatternResult):
    """Result of an emergence pattern execution."""
    insights_generated: int = 0
    insights: List[EmergentInsight] = field(default_factory=list)
    observations_processed: int = 0


class EmergencePattern(SwarmPattern):
    """
    Emergence pattern for combining individual insights.

    Collects observations from multiple agents and synthesizes
    them into higher-level emergent insights.
    """

    def __init__(
        self,
        registry: AgentRegistry,
        min_contributors: int = 2,
        confidence_threshold: float = 0.6,
    ):
        """
        Initialize emergence pattern.

        Args:
            registry: Agent registry
            min_contributors: Minimum contributors for an insight
            confidence_threshold: Minimum confidence for insight
        """
        self.registry = registry
        self.min_contributors = min_contributors
        self.confidence_threshold = confidence_threshold

    @property
    def name(self) -> str:
        return "emergence"

    def execute(self, context: Dict[str, Any]) -> EmergenceResult:
        """
        Execute emergence pattern.

        Context should include:
        - observations: List of dicts with "agent_id", "observation", "category"

        Returns:
            EmergenceResult with generated insights
        """
        start_time = datetime.now(timezone.utc)

        observations: List[Dict[str, Any]] = context.get("observations", [])

        if not observations:
            return EmergenceResult(
                success=False,
                pattern_name=self.name,
                duration_ms=0,
                participants=[],
                insights_generated=0,
            )

        # Group observations by category
        by_category: Dict[str, List[Dict[str, Any]]] = {}
        for obs in observations:
            category = obs.get("category", "general")
            if category not in by_category:
                by_category[category] = []
            by_category[category].append(obs)

        # Generate insights for each category with enough observations
        insights: List[EmergentInsight] = []
        participants: List[str] = []

        for category, cat_observations in by_category.items():
            if len(cat_observations) >= self.min_contributors:
                insight = self._synthesize_insight(category, cat_observations)
                if insight and insight.confidence >= self.confidence_threshold:
                    insights.append(insight)
                    participants.extend(insight.contributors)

        # Deduplicate participants
        participants = list(set(participants))

        end_time = datetime.now(timezone.utc)
        duration_ms = int((end_time - start_time).total_seconds() * 1000)

        return EmergenceResult(
            success=len(insights) > 0,
            pattern_name=self.name,
            duration_ms=duration_ms,
            participants=participants,
            insights_generated=len(insights),
            insights=insights,
            observations_processed=len(observations),
            metadata={
                "categories_processed": len(by_category),
                "min_contributors": self.min_contributors,
                "confidence_threshold": self.confidence_threshold,
            },
        )

    def _synthesize_insight(
        self,
        category: str,
        observations: List[Dict[str, Any]],
    ) -> Optional[EmergentInsight]:
        """
        Synthesize an insight from multiple observations.

        This is a simplified implementation. In production, this could use
        LLM-based synthesis for more sophisticated insight generation.
        """
        import uuid

        # Extract observation texts and contributors
        obs_texts = [obs.get("observation", "") for obs in observations]
        contributors = list(set(obs.get("agent_id", "") for obs in observations))

        # Simple pattern detection: find common themes
        # In production, this would use more sophisticated NLP/LLM
        word_counts: Dict[str, int] = {}
        for text in obs_texts:
            for word in text.lower().split():
                if len(word) > 4:  # Skip short words
                    word_counts[word] = word_counts.get(word, 0) + 1

        # Find words that appear in multiple observations
        common_themes = [
            word for word, count in word_counts.items()
            if count >= self.min_contributors
        ]

        if not common_themes:
            return None

        # Generate insight text
        insight_text = (
            f"Pattern detected in {category}: Multiple agents observed themes "
            f"related to {', '.join(common_themes[:5])}."
        )

        # Calculate confidence based on contributor agreement
        confidence = min(1.0, len(contributors) / 5.0)  # More contributors = higher confidence

        insight_id = f"insight-{uuid.uuid4().hex[:8]}"

        return EmergentInsight(
            id=insight_id,
            insight=insight_text,
            contributors=contributors,
            confidence=confidence,
            supporting_observations=obs_texts,
            category=category,
        )


class TopologyValidator:
    """Validates cluster/workflow topologies for common configuration errors.

    Checks for:
    - Orphan subscribers (subscribing to topic nobody publishes)
    - Dead publishers (publishing to topic nobody subscribes)
    - Missing terminal agent (nobody publishes task.complete)
    - Missing start agent (nobody subscribes to task.start)
    - Self-loops (agent subscribes to its own publish topic)
    """

    SYSTEM_PUBLISH_TOPICS = {"task.start"}  # Published by the system
    SYSTEM_SUBSCRIBE_TOPICS = {"task.complete"}  # Consumed by the system

    @staticmethod
    def validate(cluster_config: Dict[str, Any]) -> List[str]:
        """Validate a cluster topology. Returns list of errors (empty = valid)."""
        errors: List[str] = []
        agents = cluster_config.get("agents", [])

        if not agents:
            errors.append("Cluster has no agents defined.")
            return errors

        all_publishes: set = set()
        all_subscribes: set = set()
        agent_ids: set = set()

        for agent in agents:
            agent_id = agent.get("id", "unknown")
            if agent_id in agent_ids:
                errors.append(f"Duplicate agent ID: '{agent_id}'")
            agent_ids.add(agent_id)

            for topic in agent.get("publishes", []):
                all_publishes.add(topic)
            for topic in agent.get("subscribes", []):
                all_subscribes.add(topic)

        # Check 1: Orphan subscribers (topics subscribed but not published by any agent or system)
        orphan_subs = all_subscribes - all_publishes - TopologyValidator.SYSTEM_PUBLISH_TOPICS
        if orphan_subs:
            errors.append(f"Topics subscribed but never published: {sorted(orphan_subs)}")

        # Check 2: Dead publishers (topics published but not subscribed by any agent or system)
        dead_pubs = all_publishes - all_subscribes - TopologyValidator.SYSTEM_SUBSCRIBE_TOPICS
        if dead_pubs:
            errors.append(f"Topics published but nobody subscribes: {sorted(dead_pubs)}")

        # Check 3: No terminal agent
        if "task.complete" not in all_publishes:
            errors.append("No agent publishes 'task.complete'. Workflow may never finish.")

        # Check 4: No start agent
        if "task.start" not in all_subscribes:
            errors.append("No agent subscribes to 'task.start'. Workflow cannot begin.")

        # Check 5: Self-loops
        for agent in agents:
            pubs = set(agent.get("publishes", []))
            subs = set(agent.get("subscribes", []))
            overlap = pubs & subs
            if overlap:
                errors.append(
                    f"Agent '{agent.get('id', 'unknown')}' subscribes to its own topic: {sorted(overlap)}"
                )

        return errors

    @staticmethod
    def validate_file(path: str) -> List[str]:
        """Validate a cluster template JSON file."""
        import json
        try:
            with open(path, "r", encoding="utf-8") as f:
                config = json.load(f)
            return TopologyValidator.validate(config)
        except json.JSONDecodeError as e:
            return [f"Invalid JSON: {e}"]
        except FileNotFoundError:
            return [f"File not found: {path}"]
        except Exception as e:
            return [f"Error reading file: {e}"]
