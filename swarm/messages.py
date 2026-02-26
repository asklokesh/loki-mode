"""
Loki Mode Swarm Messages - Inter-agent communication protocol.

This module defines the message format and types for swarm communication:
- Votes for decision making
- Proposals for consensus
- Task assignments for delegation
- Insight sharing for emergence
"""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional


class MessageType(str, Enum):
    """Types of swarm messages."""
    # Voting
    VOTE_REQUEST = "vote_request"
    VOTE_RESPONSE = "vote_response"
    VOTE_RESULT = "vote_result"

    # Consensus
    PROPOSAL = "proposal"
    PROPOSAL_SUPPORT = "proposal_support"
    PROPOSAL_OPPOSE = "proposal_oppose"
    CONSENSUS_REACHED = "consensus_reached"
    CONSENSUS_FAILED = "consensus_failed"

    # Delegation
    TASK_OFFER = "task_offer"
    TASK_ACCEPT = "task_accept"
    TASK_REJECT = "task_reject"
    TASK_COMPLETE = "task_complete"
    TASK_FAILED = "task_failed"

    # Emergence
    INSIGHT_SHARE = "insight_share"
    INSIGHT_COMBINE = "insight_combine"
    INSIGHT_VALIDATE = "insight_validate"

    # Coordination
    HEARTBEAT = "heartbeat"
    STATUS_UPDATE = "status_update"
    ESCALATE = "escalate"


class VoteChoice(str, Enum):
    """Possible vote choices."""
    APPROVE = "approve"
    REJECT = "reject"
    ABSTAIN = "abstain"


@dataclass
class Vote:
    """
    A vote from an agent.

    Attributes:
        voter_id: ID of the voting agent
        choice: The vote choice
        confidence: How confident the voter is (0.0 to 1.0)
        reasoning: Optional reasoning for the vote
        timestamp: When the vote was cast
    """
    voter_id: str
    choice: VoteChoice
    confidence: float = 0.8
    reasoning: Optional[str] = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "voter_id": self.voter_id,
            "choice": self.choice.value,
            "confidence": self.confidence,
            "reasoning": self.reasoning,
            "timestamp": self.timestamp.isoformat() + "Z",
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Vote:
        """Create from dictionary."""
        timestamp = datetime.now(timezone.utc)
        if data.get("timestamp"):
            ts_str = data["timestamp"]
            if isinstance(ts_str, str):
                if ts_str.endswith("Z"):
                    ts_str = ts_str[:-1]
                timestamp = datetime.fromisoformat(ts_str)

        return cls(
            voter_id=data.get("voter_id", ""),
            choice=VoteChoice(data.get("choice", "abstain")),
            confidence=data.get("confidence", 0.8),
            reasoning=data.get("reasoning"),
            timestamp=timestamp,
        )


@dataclass
class Proposal:
    """
    A proposal for consensus.

    Attributes:
        id: Unique proposal identifier
        proposer_id: ID of the proposing agent
        title: Short title for the proposal
        description: Detailed description
        options: Available options to choose from
        context: Additional context for the decision
        deadline: Deadline for responses
        supporters: IDs of agents supporting
        opposers: IDs of agents opposing
        abstainers: IDs of agents abstaining
        status: Current proposal status
    """
    id: str
    proposer_id: str
    title: str
    description: str
    options: List[str] = field(default_factory=list)
    context: Dict[str, Any] = field(default_factory=dict)
    deadline: Optional[datetime] = None
    supporters: List[str] = field(default_factory=list)
    opposers: List[str] = field(default_factory=list)
    abstainers: List[str] = field(default_factory=list)
    status: str = "open"
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = {
            "id": self.id,
            "proposer_id": self.proposer_id,
            "title": self.title,
            "description": self.description,
            "options": self.options,
            "context": self.context,
            "supporters": self.supporters,
            "opposers": self.opposers,
            "abstainers": self.abstainers,
            "status": self.status,
            "created_at": self.created_at.isoformat() + "Z",
        }
        if self.deadline:
            result["deadline"] = self.deadline.isoformat() + "Z"
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Proposal:
        """Create from dictionary."""
        created_at = datetime.now(timezone.utc)
        if data.get("created_at"):
            ts_str = data["created_at"]
            if isinstance(ts_str, str):
                if ts_str.endswith("Z"):
                    ts_str = ts_str[:-1]
                created_at = datetime.fromisoformat(ts_str)

        deadline = None
        if data.get("deadline"):
            dl_str = data["deadline"]
            if isinstance(dl_str, str):
                if dl_str.endswith("Z"):
                    dl_str = dl_str[:-1]
                deadline = datetime.fromisoformat(dl_str)

        return cls(
            id=data.get("id", ""),
            proposer_id=data.get("proposer_id", ""),
            title=data.get("title", ""),
            description=data.get("description", ""),
            options=data.get("options", []),
            context=data.get("context", {}),
            deadline=deadline,
            supporters=data.get("supporters", []),
            opposers=data.get("opposers", []),
            abstainers=data.get("abstainers", []),
            status=data.get("status", "open"),
            created_at=created_at,
        )

    @classmethod
    def create(
        cls,
        proposer_id: str,
        title: str,
        description: str,
        options: Optional[List[str]] = None,
    ) -> Proposal:
        """Factory method to create a new proposal."""
        proposal_id = f"prop-{uuid.uuid4().hex[:8]}"
        return cls(
            id=proposal_id,
            proposer_id=proposer_id,
            title=title,
            description=description,
            options=options or [],
        )

    def add_support(self, agent_id: str) -> None:
        """Add support for this proposal."""
        if agent_id not in self.supporters:
            self.supporters.append(agent_id)
        # Remove from other lists
        if agent_id in self.opposers:
            self.opposers.remove(agent_id)
        if agent_id in self.abstainers:
            self.abstainers.remove(agent_id)

    def add_opposition(self, agent_id: str) -> None:
        """Add opposition to this proposal."""
        if agent_id not in self.opposers:
            self.opposers.append(agent_id)
        # Remove from other lists
        if agent_id in self.supporters:
            self.supporters.remove(agent_id)
        if agent_id in self.abstainers:
            self.abstainers.remove(agent_id)

    def add_abstention(self, agent_id: str) -> None:
        """Add abstention for this proposal."""
        if agent_id not in self.abstainers:
            self.abstainers.append(agent_id)
        # Remove from other lists
        if agent_id in self.supporters:
            self.supporters.remove(agent_id)
        if agent_id in self.opposers:
            self.opposers.remove(agent_id)

    def get_support_ratio(self, total_voters: int) -> float:
        """Get ratio of supporters to total voters."""
        if total_voters == 0:
            return 0.0
        return len(self.supporters) / total_voters


@dataclass
class TaskAssignment:
    """
    A task assignment for delegation.

    Attributes:
        id: Unique assignment identifier
        task_id: ID of the task being assigned
        delegator_id: ID of the delegating agent
        delegate_id: ID of the agent receiving the task
        task_type: Type of task
        description: Task description
        required_capabilities: Capabilities needed
        priority: Task priority (1-10)
        deadline: Optional deadline
        status: Current assignment status
    """
    id: str
    task_id: str
    delegator_id: str
    delegate_id: Optional[str]
    task_type: str
    description: str
    required_capabilities: List[str] = field(default_factory=list)
    priority: int = 5
    deadline: Optional[datetime] = None
    status: str = "pending"
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: Optional[datetime] = None
    result: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = {
            "id": self.id,
            "task_id": self.task_id,
            "delegator_id": self.delegator_id,
            "delegate_id": self.delegate_id,
            "task_type": self.task_type,
            "description": self.description,
            "required_capabilities": self.required_capabilities,
            "priority": self.priority,
            "status": self.status,
            "created_at": self.created_at.isoformat() + "Z",
        }
        if self.deadline:
            result["deadline"] = self.deadline.isoformat() + "Z"
        if self.completed_at:
            result["completed_at"] = self.completed_at.isoformat() + "Z"
        if self.result:
            result["result"] = self.result
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> TaskAssignment:
        """Create from dictionary."""
        created_at = datetime.now(timezone.utc)
        if data.get("created_at"):
            ts_str = data["created_at"]
            if isinstance(ts_str, str):
                if ts_str.endswith("Z"):
                    ts_str = ts_str[:-1]
                created_at = datetime.fromisoformat(ts_str)

        deadline = None
        if data.get("deadline"):
            dl_str = data["deadline"]
            if isinstance(dl_str, str):
                if dl_str.endswith("Z"):
                    dl_str = dl_str[:-1]
                deadline = datetime.fromisoformat(dl_str)

        completed_at = None
        if data.get("completed_at"):
            ca_str = data["completed_at"]
            if isinstance(ca_str, str):
                if ca_str.endswith("Z"):
                    ca_str = ca_str[:-1]
                completed_at = datetime.fromisoformat(ca_str)

        return cls(
            id=data.get("id", ""),
            task_id=data.get("task_id", ""),
            delegator_id=data.get("delegator_id", ""),
            delegate_id=data.get("delegate_id"),
            task_type=data.get("task_type", ""),
            description=data.get("description", ""),
            required_capabilities=data.get("required_capabilities", []),
            priority=data.get("priority", 5),
            deadline=deadline,
            status=data.get("status", "pending"),
            created_at=created_at,
            completed_at=completed_at,
            result=data.get("result"),
        )

    @classmethod
    def create(
        cls,
        task_id: str,
        delegator_id: str,
        task_type: str,
        description: str,
        required_capabilities: Optional[List[str]] = None,
    ) -> TaskAssignment:
        """Factory method to create a new task assignment."""
        assignment_id = f"assign-{uuid.uuid4().hex[:8]}"
        return cls(
            id=assignment_id,
            task_id=task_id,
            delegator_id=delegator_id,
            delegate_id=None,
            task_type=task_type,
            description=description,
            required_capabilities=required_capabilities or [],
        )


@dataclass
class SwarmMessage:
    """
    A message in the swarm communication protocol.

    Attributes:
        id: Unique message identifier
        type: Type of message
        sender_id: ID of the sending agent
        recipient_id: ID of the recipient (None for broadcast)
        payload: Message payload
        timestamp: When the message was sent
        correlation_id: ID for correlating related messages
        metadata: Additional metadata
    """
    id: str
    type: MessageType
    sender_id: str
    recipient_id: Optional[str]
    payload: Dict[str, Any]
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    correlation_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "type": self.type.value,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "payload": self.payload,
            "timestamp": self.timestamp.isoformat() + "Z",
            "correlation_id": self.correlation_id,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> SwarmMessage:
        """Create from dictionary."""
        timestamp = datetime.now(timezone.utc)
        if data.get("timestamp"):
            ts_str = data["timestamp"]
            if isinstance(ts_str, str):
                if ts_str.endswith("Z"):
                    ts_str = ts_str[:-1]
                timestamp = datetime.fromisoformat(ts_str)

        return cls(
            id=data.get("id", ""),
            type=MessageType(data.get("type", "status_update")),
            sender_id=data.get("sender_id", ""),
            recipient_id=data.get("recipient_id"),
            payload=data.get("payload", {}),
            timestamp=timestamp,
            correlation_id=data.get("correlation_id"),
            metadata=data.get("metadata", {}),
        )

    @classmethod
    def create(
        cls,
        msg_type: MessageType,
        sender_id: str,
        payload: Dict[str, Any],
        recipient_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> SwarmMessage:
        """Factory method to create a new message."""
        msg_id = f"msg-{uuid.uuid4().hex[:8]}"
        return cls(
            id=msg_id,
            type=msg_type,
            sender_id=sender_id,
            recipient_id=recipient_id,
            payload=payload,
            correlation_id=correlation_id,
        )

    def is_broadcast(self) -> bool:
        """Check if this is a broadcast message."""
        return self.recipient_id is None


class MessageBus:
    """
    File-based message bus for swarm communication.

    Messages are stored in:
    - .loki/swarm/messages/pending/   - Messages waiting to be processed
    - .loki/swarm/messages/archive/   - Processed messages
    """

    def __init__(self, loki_dir: Optional[Path] = None):
        """
        Initialize the message bus.

        Args:
            loki_dir: Path to .loki directory. Defaults to ./.loki
        """
        self.loki_dir = loki_dir or Path(".loki")
        self.messages_dir = self.loki_dir / "swarm" / "messages"
        self.pending_dir = self.messages_dir / "pending"
        self.archive_dir = self.messages_dir / "archive"

        self.pending_dir.mkdir(parents=True, exist_ok=True)
        self.archive_dir.mkdir(parents=True, exist_ok=True)

    def send(self, message: SwarmMessage) -> str:
        """
        Send a message.

        Args:
            message: The message to send

        Returns:
            The message ID
        """
        msg_file = self.pending_dir / f"{message.timestamp.isoformat().replace(':', '-')}_{message.id}.json"

        try:
            with open(msg_file, "w") as f:
                json.dump(message.to_dict(), f, indent=2)
        except IOError as e:
            raise RuntimeError(f"Failed to send message: {e}")

        return message.id

    def receive(
        self,
        recipient_id: str,
        msg_types: Optional[List[MessageType]] = None,
    ) -> List[SwarmMessage]:
        """
        Receive messages for a recipient.

        Args:
            recipient_id: ID of the recipient agent
            msg_types: Filter by message types (optional)

        Returns:
            List of messages for the recipient
        """
        messages = []

        for msg_file in sorted(self.pending_dir.glob("*.json")):
            try:
                with open(msg_file, "r") as f:
                    data = json.load(f)
                    msg = SwarmMessage.from_dict(data)

                    # Check recipient (None = broadcast)
                    if msg.recipient_id is not None and msg.recipient_id != recipient_id:
                        continue

                    # Filter by type
                    if msg_types and msg.type not in msg_types:
                        continue

                    messages.append(msg)
            except (json.JSONDecodeError, IOError):
                continue

        return messages

    def acknowledge(self, message_id: str) -> bool:
        """
        Acknowledge and archive a message.

        Args:
            message_id: ID of the message to acknowledge

        Returns:
            True if message was found and archived
        """
        for msg_file in self.pending_dir.glob(f"*_{message_id}.json"):
            archive_file = self.archive_dir / msg_file.name
            try:
                msg_file.rename(archive_file)
                return True
            except IOError:
                pass
        return False

    def get_pending_count(self) -> int:
        """Get count of pending messages."""
        return len(list(self.pending_dir.glob("*.json")))

    def clear_pending(self) -> int:
        """Clear all pending messages."""
        count = 0
        for msg_file in self.pending_dir.glob("*.json"):
            try:
                msg_file.unlink()
                count += 1
            except IOError:
                pass
        return count


class PubSubMessageBus:
    """Pub/sub message bus for agent communication.

    Enables custom agent topologies beyond the default swarm patterns.
    Agents subscribe to topics and publish messages. The bus routes messages
    to all subscribers of a topic.

    Topics follow hierarchical naming: agent.engineering.*, task.completed, etc.
    Wildcard matching supported: "task.*" matches "task.completed".
    """

    def __init__(self):
        self._subscribers: Dict[str, List[Dict[str, Any]]] = {}
        self._message_log: List[Dict[str, Any]] = []
        self._dead_letter: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._sub_counter: int = 0

    def subscribe(self, topic: str, handler) -> str:
        """Subscribe to a topic. Returns subscription ID."""
        with self._lock:
            if topic not in self._subscribers:
                self._subscribers[topic] = []
            self._sub_counter += 1
            sub_id = f"sub_{self._sub_counter}_{topic}"
            self._subscribers[topic].append({"id": sub_id, "handler": handler})
            return sub_id

    def unsubscribe(self, sub_id: str) -> bool:
        """Remove a subscription by ID."""
        with self._lock:
            for topic in self._subscribers:
                original_len = len(self._subscribers[topic])
                self._subscribers[topic] = [s for s in self._subscribers[topic] if s["id"] != sub_id]
                if len(self._subscribers[topic]) != original_len:
                    return True
            return False

    def publish(self, topic: str, message: Dict[str, Any], sender: str = "") -> int:
        """Publish a message to a topic. Returns number of deliveries."""
        with self._lock:
            envelope = {
                "topic": topic,
                "message": message,
                "sender": sender,
                "timestamp": datetime.now(timezone.utc).isoformat() + "Z",
                "delivered_to": [],
            }
            self._message_log.append(envelope)

            delivered = 0
            matched_subs = []

            # Collect exact match subscribers
            for sub in self._subscribers.get(topic, []):
                matched_subs.append(sub)

            # Collect wildcard subscribers
            for pattern, subs in self._subscribers.items():
                if pattern == topic:
                    continue  # already collected via exact match
                if "*" in pattern and self._matches_wildcard(pattern, topic):
                    matched_subs.extend(subs)

            # Deliver to all matched subscribers
            for sub in matched_subs:
                try:
                    sub["handler"](message, topic, sender)
                    envelope["delivered_to"].append(sub["id"])
                    delivered += 1
                except Exception as e:
                    self._dead_letter.append({
                        **envelope,
                        "error": str(e),
                        "subscriber": sub["id"],
                    })

            return delivered

    @staticmethod
    def _matches_wildcard(pattern: str, topic: str) -> bool:
        """Check if topic matches a wildcard pattern (fnmatch-style)."""
        import fnmatch
        return fnmatch.fnmatch(topic, pattern)

    def get_log(self, topic: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
        """Get message history, optionally filtered by topic."""
        msgs = self._message_log
        if topic:
            msgs = [m for m in msgs if m["topic"] == topic]
        return msgs[-limit:]

    def get_dead_letters(self) -> List[Dict[str, Any]]:
        """Get undeliverable messages."""
        return list(self._dead_letter)

    def clear(self) -> None:
        """Clear all subscriptions and message history."""
        with self._lock:
            self._subscribers.clear()
            self._message_log.clear()
            self._dead_letter.clear()

    @property
    def subscriber_count(self) -> int:
        """Total number of active subscriptions."""
        return sum(len(subs) for subs in self._subscribers.values())

    @property
    def topics(self) -> List[str]:
        """List of all topics with subscribers."""
        return list(self._subscribers.keys())
