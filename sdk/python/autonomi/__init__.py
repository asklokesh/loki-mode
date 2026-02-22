"""Autonomi -- Python SDK for the Loki Mode Control Plane API.

Zero external dependencies. Uses only Python standard library.
"""

__version__ = "0.1.0"

from .client import AutonomiClient, AutonomiError, AuthenticationError, ForbiddenError, NotFoundError
from .types import (
    ApiKey,
    AuditEntry,
    Project,
    Run,
    RunEvent,
    Task,
    Tenant,
)
from .auth import TokenAuth
from .sessions import SessionManager
from .tasks import TaskManager
from .events import EventStream

__all__ = [
    "__version__",
    "AutonomiClient",
    "AutonomiError",
    "AuthenticationError",
    "ForbiddenError",
    "NotFoundError",
    "TokenAuth",
    "SessionManager",
    "TaskManager",
    "EventStream",
    "ApiKey",
    "AuditEntry",
    "Project",
    "Run",
    "RunEvent",
    "Task",
    "Tenant",
]
