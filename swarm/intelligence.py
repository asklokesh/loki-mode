"""
Loki Mode Swarm Intelligence - Main coordinator for swarm patterns.

This module provides the SwarmCoordinator class that orchestrates
all swarm intelligence patterns:
- Voting: Collective decision making
- Consensus: Agreement on approaches
- Delegation: Task distribution by expertise
- Emergence: Combined insights from multiple agents

See references/agent-types.md for agent definitions.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .registry import (
    AgentRegistry,
    AgentInfo,
    AgentStatus,
    AGENT_TYPES,
    SWARM_CATEGORIES,
)
from .messages import (
    MessageBus,
    SwarmMessage,
    MessageType,
    Vote,
    VoteChoice,
    Proposal,
    TaskAssignment,
)
from .patterns import (
    SwarmPattern,
    VotingPattern,
    VotingResult,
    ConsensusPattern,
    ConsensusResult,
    DelegationPattern,
    DelegationResult,
    EmergencePattern,
    EmergenceResult,
    EmergentInsight,
)


@dataclass
class SwarmConfig:
    """
    Configuration for the swarm coordinator.

    Attributes:
        voting_quorum: Minimum participation for voting (0.0 to 1.0)
        voting_threshold: Approval threshold for voting (0.0 to 1.0)
        consensus_threshold: Support level for consensus (0.0 to 1.0)
        consensus_max_rounds: Maximum consensus rounds
        delegation_capability_threshold: Minimum capability match
        delegation_consider_load: Whether to consider agent load
        emergence_min_contributors: Minimum contributors for emergence
        emergence_confidence_threshold: Minimum insight confidence
        heartbeat_timeout_seconds: Agent heartbeat timeout
        retry_count: Number of retries for failed operations
    """
    voting_quorum: float = 0.5
    voting_threshold: float = 0.5
    consensus_threshold: float = 0.67
    consensus_max_rounds: int = 3
    delegation_capability_threshold: float = 0.5
    delegation_consider_load: bool = True
    emergence_min_contributors: int = 2
    emergence_confidence_threshold: float = 0.6
    heartbeat_timeout_seconds: int = 300
    retry_count: int = 3
    max_agents: int = 20

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "voting_quorum": self.voting_quorum,
            "voting_threshold": self.voting_threshold,
            "consensus_threshold": self.consensus_threshold,
            "consensus_max_rounds": self.consensus_max_rounds,
            "delegation_capability_threshold": self.delegation_capability_threshold,
            "delegation_consider_load": self.delegation_consider_load,
            "emergence_min_contributors": self.emergence_min_contributors,
            "emergence_confidence_threshold": self.emergence_confidence_threshold,
            "heartbeat_timeout_seconds": self.heartbeat_timeout_seconds,
            "retry_count": self.retry_count,
            "max_agents": self.max_agents,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> SwarmConfig:
        """Create from dictionary."""
        return cls(
            voting_quorum=data.get("voting_quorum", 0.5),
            voting_threshold=data.get("voting_threshold", 0.5),
            consensus_threshold=data.get("consensus_threshold", 0.67),
            consensus_max_rounds=data.get("consensus_max_rounds", 3),
            delegation_capability_threshold=data.get("delegation_capability_threshold", 0.5),
            delegation_consider_load=data.get("delegation_consider_load", True),
            emergence_min_contributors=data.get("emergence_min_contributors", 2),
            emergence_confidence_threshold=data.get("emergence_confidence_threshold", 0.6),
            heartbeat_timeout_seconds=data.get("heartbeat_timeout_seconds", 300),
            retry_count=data.get("retry_count", 3),
            max_agents=data.get("max_agents", 20),
        )


class SwarmCoordinator:
    """
    Main coordinator for swarm intelligence patterns.

    Provides high-level APIs for:
    - Agent registration and discovery
    - Voting-based decision making
    - Consensus building
    - Task delegation
    - Emergent insight generation

    Example usage:
        coordinator = SwarmCoordinator()

        # Register agents
        agent1 = coordinator.register_agent("eng-frontend")
        agent2 = coordinator.register_agent("eng-backend")

        # Run a vote
        result = coordinator.vote(
            question="Should we use TypeScript?",
            voters=[agent1.id, agent2.id],
            votes=[
                Vote(voter_id=agent1.id, choice=VoteChoice.APPROVE, confidence=0.9),
                Vote(voter_id=agent2.id, choice=VoteChoice.APPROVE, confidence=0.8),
            ],
        )
        print(result.decision)  # "approved"
    """

    def __init__(
        self,
        loki_dir: Optional[Path] = None,
        config: Optional[SwarmConfig] = None,
    ):
        """
        Initialize the swarm coordinator.

        Args:
            loki_dir: Path to .loki directory. Defaults to ./.loki
            config: Swarm configuration. Uses defaults if not provided.
        """
        self.loki_dir = loki_dir or Path(".loki")
        self.config = config or SwarmConfig()

        # Initialize components
        self.registry = AgentRegistry(self.loki_dir)
        self.message_bus = MessageBus(self.loki_dir)

        # Initialize patterns
        self._voting_pattern = VotingPattern(
            registry=self.registry,
            quorum_percent=self.config.voting_quorum,
            approval_threshold=self.config.voting_threshold,
        )
        self._consensus_pattern = ConsensusPattern(
            registry=self.registry,
            consensus_threshold=self.config.consensus_threshold,
            max_rounds=self.config.consensus_max_rounds,
        )
        self._delegation_pattern = DelegationPattern(
            registry=self.registry,
            capability_match_threshold=self.config.delegation_capability_threshold,
            consider_load=self.config.delegation_consider_load,
        )
        self._emergence_pattern = EmergencePattern(
            registry=self.registry,
            min_contributors=self.config.emergence_min_contributors,
            confidence_threshold=self.config.emergence_confidence_threshold,
        )

        # Storage for active sessions
        self._swarm_dir = self.loki_dir / "swarm"
        self._swarm_dir.mkdir(parents=True, exist_ok=True)

        # Event handlers
        self._event_handlers: Dict[str, List[Callable]] = {}

    # -------------------------------------------------------------------------
    # Agent Management
    # -------------------------------------------------------------------------

    def register_agent(
        self,
        agent_type: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> AgentInfo:
        """
        Register a new agent with the swarm.

        Args:
            agent_type: Type of agent (e.g., "eng-frontend")
            metadata: Optional metadata

        Returns:
            Registered AgentInfo
        """
        if agent_type not in AGENT_TYPES:
            raise ValueError(f"Unknown agent type: {agent_type}. Valid types: {AGENT_TYPES}")

        agent = self.registry.register(agent_type, metadata)
        self._emit_event("agent_registered", {"agent": agent.to_dict()})
        return agent

    def deregister_agent(self, agent_id: str) -> bool:
        """
        Remove an agent from the swarm.

        Args:
            agent_id: Agent ID to remove

        Returns:
            True if agent was found and removed
        """
        result = self.registry.deregister(agent_id)
        if result:
            self._emit_event("agent_deregistered", {"agent_id": agent_id})
        return result

    def get_agent(self, agent_id: str) -> Optional[AgentInfo]:
        """Get agent by ID."""
        return self.registry.get(agent_id)

    def list_agents(
        self,
        agent_type: Optional[str] = None,
        swarm: Optional[str] = None,
        status: Optional[AgentStatus] = None,
    ) -> List[AgentInfo]:
        """
        List agents with optional filters.

        Args:
            agent_type: Filter by agent type
            swarm: Filter by swarm category
            status: Filter by status

        Returns:
            List of matching agents
        """
        agents = self.registry.list_all()

        if agent_type:
            agents = [a for a in agents if a.agent_type == agent_type]
        if swarm:
            agents = [a for a in agents if a.swarm == swarm]
        if status:
            agents = [a for a in agents if a.status == status]

        return agents

    def find_agents_for_task(
        self,
        required_capabilities: List[str],
        count: int = 1,
    ) -> List[AgentInfo]:
        """
        Find the best agents for a task.

        Args:
            required_capabilities: Capabilities needed
            count: Number of agents to return

        Returns:
            List of best matching agents
        """
        results = []
        for _ in range(count):
            # Find best agent not already in results
            candidate = self.registry.find_best_agent(
                required_capabilities=required_capabilities,
            )
            if candidate and candidate not in results:
                results.append(candidate)
            else:
                break
        return results

    # -------------------------------------------------------------------------
    # Voting Pattern
    # -------------------------------------------------------------------------

    def vote(
        self,
        question: str,
        voters: Optional[List[str]] = None,
        votes: Optional[List[Vote]] = None,
        weighted: bool = False,
    ) -> VotingResult:
        """
        Execute a voting decision.

        Args:
            question: The question being voted on
            voters: List of voter agent IDs (uses all available if not specified)
            votes: List of Vote objects
            weighted: Whether to weight votes by confidence

        Returns:
            VotingResult with decision and vote counts
        """
        context = {
            "question": question,
            "voters": voters or [],
            "votes": votes or [],
        }

        if weighted:
            # Create weighted voting pattern
            pattern = VotingPattern(
                registry=self.registry,
                quorum_percent=self.config.voting_quorum,
                approval_threshold=self.config.voting_threshold,
                weighted=True,
            )
            result = pattern.execute(context)
        else:
            result = self._voting_pattern.execute(context)

        self._emit_event("vote_completed", {
            "question": question,
            "decision": result.decision,
            "vote_counts": result.vote_counts,
        })

        return result

    def request_votes(
        self,
        question: str,
        voter_ids: List[str],
        deadline_seconds: Optional[int] = None,
    ) -> str:
        """
        Send vote requests to agents.

        Args:
            question: The question being voted on
            voter_ids: Agent IDs to request votes from
            deadline_seconds: Optional deadline in seconds

        Returns:
            Correlation ID for tracking responses
        """
        correlation_id = f"vote-{uuid.uuid4().hex[:8]}"

        for voter_id in voter_ids:
            message = SwarmMessage.create(
                msg_type=MessageType.VOTE_REQUEST,
                sender_id="coordinator",
                payload={
                    "question": question,
                    "deadline_seconds": deadline_seconds,
                },
                recipient_id=voter_id,
                correlation_id=correlation_id,
            )
            self.message_bus.send(message)

        return correlation_id

    # -------------------------------------------------------------------------
    # Consensus Pattern
    # -------------------------------------------------------------------------

    def propose(
        self,
        proposer_id: str,
        title: str,
        description: str,
        options: Optional[List[str]] = None,
    ) -> Proposal:
        """
        Create a new proposal for consensus.

        Args:
            proposer_id: ID of the proposing agent
            title: Proposal title
            description: Detailed description
            options: Available options

        Returns:
            Created Proposal
        """
        proposal = Proposal.create(
            proposer_id=proposer_id,
            title=title,
            description=description,
            options=options,
        )

        # Save proposal
        proposals_dir = self._swarm_dir / "proposals"
        proposals_dir.mkdir(exist_ok=True)
        proposal_file = proposals_dir / f"{proposal.id}.json"

        with open(proposal_file, "w") as f:
            json.dump(proposal.to_dict(), f, indent=2)

        self._emit_event("proposal_created", {"proposal": proposal.to_dict()})

        return proposal

    def build_consensus(
        self,
        proposal: Proposal,
        participants: Optional[List[str]] = None,
        responses: Optional[Dict[str, str]] = None,
        current_round: int = 1,
    ) -> ConsensusResult:
        """
        Attempt to build consensus on a proposal.

        Args:
            proposal: The proposal to build consensus on
            participants: Participant agent IDs
            responses: Dict mapping agent_id to "support", "oppose", or "abstain"
            current_round: Current consensus round

        Returns:
            ConsensusResult with consensus status
        """
        context = {
            "proposal": proposal,
            "participants": participants or [],
            "responses": responses or {},
            "round": current_round,
        }

        result = self._consensus_pattern.execute(context)

        self._emit_event("consensus_attempt", {
            "proposal_id": proposal.id,
            "reached": result.consensus_reached,
            "support_level": result.support_level,
            "round": current_round,
        })

        return result

    # -------------------------------------------------------------------------
    # Delegation Pattern
    # -------------------------------------------------------------------------

    def delegate_task(
        self,
        task_id: str,
        delegator_id: str,
        task_type: str,
        description: str,
        required_capabilities: Optional[List[str]] = None,
        candidates: Optional[List[str]] = None,
        priority: int = 5,
    ) -> DelegationResult:
        """
        Delegate a task to the best available agent.

        Args:
            task_id: Task identifier
            delegator_id: ID of the delegating agent
            task_type: Type of task
            description: Task description
            required_capabilities: Capabilities needed
            candidates: Optional list of candidate agent IDs
            priority: Task priority (1-10)

        Returns:
            DelegationResult with delegation status
        """
        assignment = TaskAssignment.create(
            task_id=task_id,
            delegator_id=delegator_id,
            task_type=task_type,
            description=description,
            required_capabilities=required_capabilities,
        )
        assignment.priority = priority

        context = {
            "assignment": assignment,
            "candidates": candidates or [],
        }

        result = self._delegation_pattern.execute(context)

        if result.delegated and result.delegate_id:
            # Update agent status
            self.registry.update_status(
                agent_id=result.delegate_id,
                status=AgentStatus.WORKING,
                task_id=task_id,
            )

        self._emit_event("task_delegated", {
            "task_id": task_id,
            "delegated": result.delegated,
            "delegate_id": result.delegate_id,
            "fallback_used": result.fallback_used,
        })

        return result

    def auto_delegate_by_type(
        self,
        task_id: str,
        delegator_id: str,
        agent_type: str,
        description: str,
        priority: int = 5,
    ) -> DelegationResult:
        """
        Delegate a task to an agent of a specific type.

        Args:
            task_id: Task identifier
            delegator_id: ID of the delegating agent
            agent_type: Type of agent to delegate to
            description: Task description
            priority: Task priority (1-10)

        Returns:
            DelegationResult with delegation status
        """
        # Get available agents of this type
        candidates = self.registry.get_available(agent_type)
        candidate_ids = [c.id for c in candidates]

        # Get capabilities for this agent type
        from .registry import AGENT_CAPABILITIES
        required_caps = AGENT_CAPABILITIES.get(agent_type, [])

        return self.delegate_task(
            task_id=task_id,
            delegator_id=delegator_id,
            task_type=agent_type,
            description=description,
            required_capabilities=required_caps,
            candidates=candidate_ids,
            priority=priority,
        )

    def complete_task(
        self,
        agent_id: str,
        task_id: str,
        success: bool,
        result: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        Mark a task as completed.

        Args:
            agent_id: ID of the agent that completed the task
            task_id: Task identifier
            success: Whether the task succeeded
            result: Optional task result

        Returns:
            True if task was marked complete
        """
        agent = self.registry.get(agent_id)
        if not agent:
            return False

        agent.record_task_completion(success)
        self.registry.update_status(agent_id, AgentStatus.IDLE)

        self._emit_event("task_completed", {
            "agent_id": agent_id,
            "task_id": task_id,
            "success": success,
            "result": result,
        })

        return True

    # -------------------------------------------------------------------------
    # Emergence Pattern
    # -------------------------------------------------------------------------

    def share_observation(
        self,
        agent_id: str,
        observation: str,
        category: str = "general",
    ) -> str:
        """
        Share an observation from an agent.

        Args:
            agent_id: ID of the observing agent
            observation: The observation text
            category: Category of observation

        Returns:
            Observation ID
        """
        obs_id = f"obs-{uuid.uuid4().hex[:8]}"

        # Store observation
        obs_dir = self._swarm_dir / "observations"
        obs_dir.mkdir(exist_ok=True)

        obs_data = {
            "id": obs_id,
            "agent_id": agent_id,
            "observation": observation,
            "category": category,
            "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
        }

        obs_file = obs_dir / f"{obs_id}.json"
        with open(obs_file, "w") as f:
            json.dump(obs_data, f, indent=2)

        return obs_id

    def generate_insights(
        self,
        category: Optional[str] = None,
        max_age_hours: int = 24,
    ) -> EmergenceResult:
        """
        Generate emergent insights from recent observations.

        Args:
            category: Filter observations by category
            max_age_hours: Maximum age of observations to consider

        Returns:
            EmergenceResult with generated insights
        """
        # Load recent observations
        obs_dir = self._swarm_dir / "observations"
        if not obs_dir.exists():
            return EmergenceResult(
                success=False,
                pattern_name="emergence",
                duration_ms=0,
                participants=[],
                insights_generated=0,
            )

        observations = []
        now = datetime.now(timezone.utc)

        for obs_file in obs_dir.glob("*.json"):
            try:
                with open(obs_file, "r") as f:
                    obs_data = json.load(f)

                    # Check age
                    ts_str = obs_data.get("timestamp", "")
                    if ts_str:
                        if ts_str.endswith("Z"):
                            ts_str = ts_str[:-1]
                        obs_time = datetime.fromisoformat(ts_str)
                        age_hours = (now - obs_time.replace(tzinfo=timezone.utc)).total_seconds() / 3600
                        if age_hours > max_age_hours:
                            continue

                    # Filter by category
                    if category and obs_data.get("category") != category:
                        continue

                    observations.append(obs_data)
            except (json.JSONDecodeError, IOError):
                continue

        context = {"observations": observations}
        result = self._emergence_pattern.execute(context)

        if result.insights:
            self._emit_event("insights_generated", {
                "count": len(result.insights),
                "categories": list(set(i.category for i in result.insights)),
            })

        return result

    def combine_insights(
        self,
        insight_ids: List[str],
    ) -> Optional[EmergentInsight]:
        """
        Combine multiple insights into a higher-level insight.

        Args:
            insight_ids: IDs of insights to combine

        Returns:
            Combined insight or None
        """
        # This is a placeholder for more sophisticated combination logic
        # In production, this would use LLM-based synthesis
        return None

    # -------------------------------------------------------------------------
    # Dynamic Agent Spawning
    # -------------------------------------------------------------------------

    def spawn_agent(self, agent_config: dict, reason: str = "") -> str:
        """Dynamically add an agent to the running swarm.

        Args:
            agent_config: Agent definition (type, role, subscribes, publishes)
            reason: Why this agent was spawned (logged for audit)

        Returns:
            Agent ID of the spawned agent

        Raises:
            ValueError: If agent config is invalid or breaks topology
            RuntimeError: If max agents exceeded
        """
        from .patterns import TopologyValidator

        current_count = len(self.registry.list_all())
        max_agents = getattr(self.config, "max_agents", 20)
        if current_count >= max_agents:
            raise RuntimeError(
                f"Cannot spawn: max agents ({max_agents}) reached"
            )

        agent_type = agent_config.get("type", "unknown")
        agent_id = f"dynamic_{agent_type}_{current_count}"
        agent_config["id"] = agent_id
        agent_config["spawned_dynamically"] = True
        agent_config["spawn_reason"] = reason
        agent_config["spawned_at"] = datetime.now(timezone.utc).isoformat() + "Z"

        # Validate topology if agent has pub/sub topics
        if agent_config.get("publishes") or agent_config.get("subscribes"):
            existing_agents = []
            for agent in self.registry.list_all():
                existing_agents.append({
                    "id": agent.id,
                    "publishes": agent.metadata.get("publishes", []) if agent.metadata else [],
                    "subscribes": agent.metadata.get("subscribes", []) if agent.metadata else [],
                })
            existing_agents.append({
                "id": agent_id,
                "publishes": agent_config.get("publishes", []),
                "subscribes": agent_config.get("subscribes", []),
            })
            errors = TopologyValidator.validate({"agents": existing_agents})
            if errors:
                raise ValueError(f"Spawning would break topology: {errors}")

        # Register the agent
        if agent_type in AGENT_TYPES:
            registered = self.registry.register(agent_type, metadata={
                **agent_config,
                "spawned_dynamically": True,
                "spawn_reason": reason,
            })
            agent_id = registered.id
        else:
            # For unknown types, store in metadata
            agent_config["_unregistered"] = True

        self._emit_event("agent_spawned", {
            "agent_id": agent_id,
            "type": agent_type,
            "reason": reason,
            "dynamic": True,
        })
        return agent_id

    def despawn_agent(self, agent_id: str) -> bool:
        """Remove a dynamically spawned agent.

        Only agents with spawned_dynamically=True can be removed.
        """
        agent = self.registry.get(agent_id)
        if not agent:
            return False
        if not (agent.metadata or {}).get("spawned_dynamically"):
            raise ValueError(f"Cannot despawn non-dynamic agent: {agent_id}")

        self.registry.deregister(agent_id)
        self._emit_event("agent_despawned", {"agent_id": agent_id})
        return True

    # -------------------------------------------------------------------------
    # Coordination
    # -------------------------------------------------------------------------

    def get_swarm_status(self) -> Dict[str, Any]:
        """Get overall swarm status."""
        registry_stats = self.registry.get_stats()
        pending_messages = self.message_bus.get_pending_count()
        stale_agents = self.registry.get_stale_agents(self.config.heartbeat_timeout_seconds)

        return {
            "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
            "registry": registry_stats,
            "pending_messages": pending_messages,
            "stale_agent_count": len(stale_agents),
            "stale_agents": [a.id for a in stale_agents],
            "config": self.config.to_dict(),
        }

    def cleanup_stale_agents(self) -> int:
        """
        Remove stale agents that haven't sent heartbeats.

        Returns:
            Number of agents removed
        """
        stale_agents = self.registry.get_stale_agents(self.config.heartbeat_timeout_seconds)
        removed = 0

        for agent in stale_agents:
            if self.registry.deregister(agent.id):
                removed += 1
                self._emit_event("agent_removed_stale", {"agent_id": agent.id})

        return removed

    def broadcast(
        self,
        sender_id: str,
        message_type: MessageType,
        payload: Dict[str, Any],
    ) -> str:
        """
        Broadcast a message to all agents.

        Args:
            sender_id: ID of the sending agent
            message_type: Type of message
            payload: Message payload

        Returns:
            Message ID
        """
        message = SwarmMessage.create(
            msg_type=message_type,
            sender_id=sender_id,
            payload=payload,
            recipient_id=None,  # Broadcast
        )
        return self.message_bus.send(message)

    # -------------------------------------------------------------------------
    # Event System
    # -------------------------------------------------------------------------

    def on(self, event_type: str, handler: Callable[[Dict[str, Any]], None]) -> None:
        """
        Register an event handler.

        Args:
            event_type: Type of event to handle
            handler: Handler function
        """
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append(handler)

    def off(self, event_type: str, handler: Callable[[Dict[str, Any]], None]) -> bool:
        """
        Remove an event handler.

        Args:
            event_type: Type of event
            handler: Handler function to remove

        Returns:
            True if handler was found and removed
        """
        if event_type in self._event_handlers:
            try:
                self._event_handlers[event_type].remove(handler)
                return True
            except ValueError:
                pass
        return False

    def _emit_event(self, event_type: str, data: Dict[str, Any]) -> None:
        """Emit an event to all registered handlers."""
        if event_type in self._event_handlers:
            for handler in self._event_handlers[event_type]:
                try:
                    handler(data)
                except Exception:
                    pass  # Don't let handler errors break the system

    # -------------------------------------------------------------------------
    # Persistence
    # -------------------------------------------------------------------------

    def save_config(self) -> None:
        """Save current configuration to disk."""
        config_file = self._swarm_dir / "config.json"
        with open(config_file, "w") as f:
            json.dump(self.config.to_dict(), f, indent=2)

    def load_config(self) -> bool:
        """
        Load configuration from disk.

        Returns:
            True if config was loaded
        """
        config_file = self._swarm_dir / "config.json"
        if config_file.exists():
            try:
                with open(config_file, "r") as f:
                    data = json.load(f)
                    self.config = SwarmConfig.from_dict(data)
                    return True
            except (json.JSONDecodeError, IOError):
                pass
        return False
