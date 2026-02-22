"""
Run lifecycle management for the Loki Mode Dashboard Control Plane.

Provides listing, canceling, replaying, and timeline visualization
of RARV execution runs. A "run" wraps a Session with run-specific
operations and timeline event tracking.
"""

import json
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .models import Run, RunEvent


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------

class RunCreate(BaseModel):
    """Schema for creating a new run."""
    project_id: int
    trigger: str = "manual"
    config: Optional[dict] = None


class RunEventResponse(BaseModel):
    """Schema for a single run event."""
    id: int
    run_id: int
    event_type: str
    phase: Optional[str] = None
    details: Optional[dict] = None
    timestamp: datetime

    model_config = {"from_attributes": True}


class RunResponse(BaseModel):
    """Schema for a run response."""
    id: int
    session_id: Optional[int] = None
    project_id: int
    status: str
    trigger: str
    config: Optional[dict] = None
    result_summary: Optional[dict] = None
    parent_run_id: Optional[int] = None
    started_at: datetime
    ended_at: Optional[datetime] = None
    created_at: datetime
    events: list[RunEventResponse] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class RunTimelineResponse(BaseModel):
    """Schema for a run timeline response."""
    run_id: int
    events: list[RunEventResponse]
    duration_seconds: Optional[float] = None


# ---------------------------------------------------------------------------
# Helper: convert model to response, parsing JSON text fields
# ---------------------------------------------------------------------------

def _run_to_response(run: Run, include_events: bool = True) -> RunResponse:
    """Convert a Run ORM object to a RunResponse, parsing JSON text fields."""
    config_dict = None
    if run.config:
        try:
            config_dict = json.loads(run.config)
        except (json.JSONDecodeError, TypeError):
            config_dict = None

    result_dict = None
    if run.result_summary:
        try:
            result_dict = json.loads(run.result_summary)
        except (json.JSONDecodeError, TypeError):
            result_dict = None

    events = []
    if include_events and run.events:
        for ev in run.events:
            ev_details = None
            if ev.details:
                try:
                    ev_details = json.loads(ev.details)
                except (json.JSONDecodeError, TypeError):
                    ev_details = None
            events.append(RunEventResponse(
                id=ev.id,
                run_id=ev.run_id,
                event_type=ev.event_type,
                phase=ev.phase,
                details=ev_details,
                timestamp=ev.timestamp,
            ))

    return RunResponse(
        id=run.id,
        session_id=run.session_id,
        project_id=run.project_id,
        status=run.status,
        trigger=run.trigger,
        config=config_dict,
        result_summary=result_dict,
        parent_run_id=run.parent_run_id,
        started_at=run.started_at,
        ended_at=run.ended_at,
        created_at=run.created_at,
        events=events,
    )


# ---------------------------------------------------------------------------
# CRUD Functions
# ---------------------------------------------------------------------------

async def create_run(
    db: AsyncSession,
    project_id: int,
    trigger: str = "manual",
    config: Optional[dict] = None,
) -> RunResponse:
    """Create a new run for a project."""
    config_str = json.dumps(config) if config else None
    run = Run(
        project_id=project_id,
        trigger=trigger,
        config=config_str,
        status="running",
    )
    db.add(run)
    await db.flush()
    # Re-fetch with eager loading to avoid lazy-load in async context
    stmt = (
        select(Run)
        .options(selectinload(Run.events))
        .where(Run.id == run.id)
    )
    result = await db.execute(stmt)
    run = result.scalar_one()
    return _run_to_response(run, include_events=True)


async def get_run(db: AsyncSession, run_id: int) -> Optional[RunResponse]:
    """Get a run by ID, including its events."""
    stmt = (
        select(Run)
        .options(selectinload(Run.events))
        .where(Run.id == run_id)
    )
    result = await db.execute(stmt)
    run = result.scalar_one_or_none()
    if run is None:
        return None
    return _run_to_response(run, include_events=True)


async def list_runs(
    db: AsyncSession,
    project_id: Optional[int] = None,
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[RunResponse]:
    """List runs with optional filters."""
    stmt = select(Run).options(selectinload(Run.events))
    if project_id is not None:
        stmt = stmt.where(Run.project_id == project_id)
    if status is not None:
        stmt = stmt.where(Run.status == status)
    stmt = stmt.order_by(Run.created_at.desc()).limit(limit).offset(offset)
    result = await db.execute(stmt)
    runs = result.scalars().all()
    return [_run_to_response(r, include_events=False) for r in runs]


async def cancel_run(db: AsyncSession, run_id: int) -> Optional[RunResponse]:
    """Cancel a run. Idempotent -- cancelling an already-cancelled run is a no-op."""
    stmt = (
        select(Run)
        .options(selectinload(Run.events))
        .where(Run.id == run_id)
    )
    result = await db.execute(stmt)
    run = result.scalar_one_or_none()
    if run is None:
        return None

    # Only allow cancellation of active runs
    if run.status in ("completed", "failed", "cancelled"):
        return None

    if run.status != "cancelled":
        run.status = "cancelled"
        run.ended_at = datetime.now(timezone.utc)
        await db.flush()
        # Re-fetch with eager loading after mutation
        stmt = (
            select(Run)
            .options(selectinload(Run.events))
            .where(Run.id == run_id)
        )
        result = await db.execute(stmt)
        run = result.scalar_one()

    return _run_to_response(run, include_events=True)


async def replay_run(
    db: AsyncSession,
    run_id: int,
    config_overrides: Optional[dict] = None,
) -> Optional[RunResponse]:
    """Create a new run as a replay of an existing run.

    The new run inherits the parent's config (merged with any overrides)
    and records the parent_run_id for lineage tracking.
    """
    stmt = select(Run).where(Run.id == run_id)
    result = await db.execute(stmt)
    parent = result.scalar_one_or_none()
    if parent is None:
        return None

    # Only allow replay of terminal runs
    if parent.status in ("running", "replaying"):
        return None

    # Merge parent config with overrides
    parent_config = {}
    if parent.config:
        try:
            parent_config = json.loads(parent.config)
        except (json.JSONDecodeError, TypeError):
            parent_config = {}
    if config_overrides:
        parent_config.update(config_overrides)

    config_str = json.dumps(parent_config) if parent_config else None

    new_run = Run(
        project_id=parent.project_id,
        trigger="replay",
        config=config_str,
        status="replaying",
        parent_run_id=parent.id,
    )
    db.add(new_run)
    await db.flush()
    # Re-fetch with eager loading to avoid lazy-load in async context
    stmt2 = (
        select(Run)
        .options(selectinload(Run.events))
        .where(Run.id == new_run.id)
    )
    result2 = await db.execute(stmt2)
    new_run = result2.scalar_one()
    return _run_to_response(new_run, include_events=True)


async def get_run_timeline(
    db: AsyncSession,
    run_id: int,
) -> Optional[RunTimelineResponse]:
    """Get the ordered timeline of events for a run."""
    stmt = (
        select(Run)
        .options(selectinload(Run.events))
        .where(Run.id == run_id)
    )
    result = await db.execute(stmt)
    run = result.scalar_one_or_none()
    if run is None:
        return None

    events = []
    for ev in run.events:
        ev_details = None
        if ev.details:
            try:
                ev_details = json.loads(ev.details)
            except (json.JSONDecodeError, TypeError):
                ev_details = None
        events.append(RunEventResponse(
            id=ev.id,
            run_id=ev.run_id,
            event_type=ev.event_type,
            phase=ev.phase,
            details=ev_details,
            timestamp=ev.timestamp,
        ))

    duration = None
    if run.started_at and run.ended_at:
        duration = (run.ended_at - run.started_at).total_seconds()

    return RunTimelineResponse(
        run_id=run.id,
        events=events,
        duration_seconds=duration,
    )


async def add_run_event(
    db: AsyncSession,
    run_id: int,
    event_type: str,
    phase: Optional[str] = None,
    details: Optional[dict] = None,
) -> RunEventResponse:
    """Add a timeline event to a run."""
    details_str = json.dumps(details) if details else None
    event = RunEvent(
        run_id=run_id,
        event_type=event_type,
        phase=phase,
        details=details_str,
    )
    db.add(event)
    await db.flush()
    await db.refresh(event)

    ev_details = None
    if event.details:
        try:
            ev_details = json.loads(event.details)
        except (json.JSONDecodeError, TypeError):
            ev_details = None

    return RunEventResponse(
        id=event.id,
        run_id=event.run_id,
        event_type=event.event_type,
        phase=event.phase,
        details=ev_details,
        timestamp=event.timestamp,
    )


async def update_run_status(
    db: AsyncSession,
    run_id: int,
    status: str,
    result_summary: Optional[dict] = None,
) -> Optional[RunResponse]:
    """Update a run's status and optionally set result_summary."""
    stmt = (
        select(Run)
        .options(selectinload(Run.events))
        .where(Run.id == run_id)
    )
    result = await db.execute(stmt)
    run = result.scalar_one_or_none()
    if run is None:
        return None

    run.status = status
    if result_summary is not None:
        run.result_summary = json.dumps(result_summary)

    # Auto-set ended_at for terminal statuses
    if status in ("completed", "failed", "cancelled") and run.ended_at is None:
        run.ended_at = datetime.now(timezone.utc)

    await db.flush()
    # Re-fetch with eager loading after mutation
    stmt = (
        select(Run)
        .options(selectinload(Run.events))
        .where(Run.id == run_id)
    )
    result = await db.execute(stmt)
    run = result.scalar_one()
    return _run_to_response(run, include_events=True)
