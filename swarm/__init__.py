# Loki Mode Swarm Intelligence System
# Implements swarm coordination patterns for multi-agent collaboration.
#
# Features:
# - Agent registry with capability tracking
# - Voting-based decision making
# - Consensus mechanisms
# - Task delegation based on expertise
# - Emergent intelligence from combined insights
# - Byzantine fault tolerance (BFT)

from .intelligence import (
    SwarmCoordinator,
    SwarmConfig,
    VotingResult,
    ConsensusResult,
    DelegationResult,
    EmergentInsight,
)

from .registry import (
    AgentRegistry,
    AgentCapability,
    AgentInfo,
    AGENT_TYPES,
    SWARM_CATEGORIES,
)

from .messages import (
    SwarmMessage,
    MessageType,
    Vote,
    VoteChoice,
    Proposal,
    TaskAssignment,
    MessageBus,
)

from .patterns import (
    SwarmPattern,
    VotingPattern,
    ConsensusPattern,
    DelegationPattern,
    EmergencePattern,
    ClusterLifecycleHooks,
)

from .bft import (
    ByzantineFaultTolerance,
    BFTConfig,
    BFTResult,
    AgentReputation,
    FaultRecord,
    FaultType,
    ConsensusPhase,
    ConsensusRound,
    AuthenticatedMessage,
)

__all__ = [
    # Core
    "SwarmCoordinator",
    "SwarmConfig",
    "VotingResult",
    "ConsensusResult",
    "DelegationResult",
    "EmergentInsight",
    # Registry
    "AgentRegistry",
    "AgentCapability",
    "AgentInfo",
    "AGENT_TYPES",
    "SWARM_CATEGORIES",
    # Messages
    "SwarmMessage",
    "MessageType",
    "Vote",
    "VoteChoice",
    "Proposal",
    "TaskAssignment",
    "MessageBus",
    # Patterns
    "SwarmPattern",
    "VotingPattern",
    "ConsensusPattern",
    "DelegationPattern",
    "EmergencePattern",
    "ClusterLifecycleHooks",
    # Byzantine Fault Tolerance
    "ByzantineFaultTolerance",
    "BFTConfig",
    "BFTResult",
    "AgentReputation",
    "FaultRecord",
    "FaultType",
    "ConsensusPhase",
    "ConsensusRound",
    "AuthenticatedMessage",
]
