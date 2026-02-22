"""Type definitions for the Autonomi SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Project:
    """Represents a project in the control plane."""

    id: str
    name: str
    description: Optional[str] = None
    status: str = "active"
    tenant_id: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Project:
        return cls(
            id=data["id"],
            name=data["name"],
            description=data.get("description"),
            status=data.get("status", "active"),
            tenant_id=data.get("tenant_id"),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
        )


@dataclass
class Task:
    """Represents a task within a project."""

    id: str
    project_id: str
    title: str
    description: Optional[str] = None
    status: str = "pending"
    priority: str = "medium"
    assigned_agent_id: Optional[str] = None
    created_at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Task:
        return cls(
            id=data["id"],
            project_id=data.get("project_id", ""),
            title=data.get("title", ""),
            description=data.get("description"),
            status=data.get("status", "pending"),
            priority=data.get("priority", "medium"),
            assigned_agent_id=data.get("assigned_agent_id"),
            created_at=data.get("created_at"),
        )


@dataclass
class Run:
    """Represents an execution run."""

    id: str
    project_id: str
    status: str = "pending"
    trigger: Optional[str] = None
    config: Optional[Dict[str, Any]] = field(default_factory=dict)
    started_at: Optional[str] = None
    ended_at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Run:
        return cls(
            id=data["id"],
            project_id=data.get("project_id", ""),
            status=data.get("status", "pending"),
            trigger=data.get("trigger"),
            config=data.get("config", {}),
            started_at=data.get("started_at"),
            ended_at=data.get("ended_at"),
        )


@dataclass
class RunEvent:
    """Represents an event within a run."""

    id: str
    run_id: str
    event_type: str
    phase: Optional[str] = None
    details: Optional[Dict[str, Any]] = field(default_factory=dict)
    timestamp: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> RunEvent:
        return cls(
            id=data["id"],
            run_id=data.get("run_id", ""),
            event_type=data.get("event_type", ""),
            phase=data.get("phase"),
            details=data.get("details", {}),
            timestamp=data.get("timestamp"),
        )


@dataclass
class Tenant:
    """Represents a tenant (organization)."""

    id: str
    name: str
    slug: Optional[str] = None
    description: Optional[str] = None
    created_at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Tenant:
        return cls(
            id=data["id"],
            name=data["name"],
            slug=data.get("slug"),
            description=data.get("description"),
            created_at=data.get("created_at"),
        )


@dataclass
class ApiKey:
    """Represents an API key."""

    id: str
    name: str
    scopes: Optional[List[str]] = field(default_factory=list)
    role: str = "viewer"
    created_at: Optional[str] = None
    expires_at: Optional[str] = None
    last_used: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ApiKey:
        return cls(
            id=data["id"],
            name=data["name"],
            scopes=data.get("scopes", []),
            role=data.get("role", "viewer"),
            created_at=data.get("created_at"),
            expires_at=data.get("expires_at"),
            last_used=data.get("last_used"),
        )


@dataclass
class AuditEntry:
    """Represents an audit log entry."""

    timestamp: str
    action: str
    resource_type: str
    resource_id: str
    user_id: Optional[str] = None
    success: bool = True

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> AuditEntry:
        return cls(
            timestamp=data["timestamp"],
            action=data["action"],
            resource_type=data.get("resource_type", ""),
            resource_id=data.get("resource_id", ""),
            user_id=data.get("user_id"),
            success=data.get("success", True),
        )
