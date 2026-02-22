"""
Tests for dashboard/runs.py -- Run lifecycle management.

Covers:
- Run CRUD (create, get, list, update status)
- Cancel (status transition, sets ended_at, idempotent)
- Replay (creates new run with parent_run_id, inherits config)
- Timeline (add events, get ordered timeline)
- List filtering (by project_id, by status)
- Edge cases (non-existent runs, multiple projects)

Uses in-memory SQLite with async support.
"""

import json
import os
import sys

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dashboard.models import Base, Project, Run, RunEvent
from dashboard.runs import (
    RunCreate,
    RunEventResponse,
    RunResponse,
    RunTimelineResponse,
    add_run_event,
    cancel_run,
    create_run,
    get_run,
    get_run_timeline,
    list_runs,
    replay_run,
    update_run_status,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def engine():
    """Create an in-memory async SQLite engine."""
    eng = create_async_engine("sqlite+aiosqlite://", echo=False)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db(engine):
    """Provide an async session for each test."""
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session
        await session.rollback()


@pytest_asyncio.fixture
async def project(db: AsyncSession):
    """Create a test project and return it."""
    proj = Project(name="Test Project", description="For run tests")
    db.add(proj)
    await db.flush()
    await db.refresh(proj)
    return proj


@pytest_asyncio.fixture
async def second_project(db: AsyncSession):
    """Create a second test project."""
    proj = Project(name="Second Project", description="Another project")
    db.add(proj)
    await db.flush()
    await db.refresh(proj)
    return proj


# ---------------------------------------------------------------------------
# Test: Run CRUD
# ---------------------------------------------------------------------------

class TestCreateRun:
    @pytest.mark.asyncio
    async def test_create_run_defaults(self, db, project):
        result = await create_run(db, project_id=project.id)
        assert isinstance(result, RunResponse)
        assert result.project_id == project.id
        assert result.status == "running"
        assert result.trigger == "manual"
        assert result.config is None
        assert result.events == []
        assert result.parent_run_id is None

    @pytest.mark.asyncio
    async def test_create_run_with_config(self, db, project):
        cfg = {"provider": "claude", "model": "opus", "flags": ["--verbose"]}
        result = await create_run(db, project_id=project.id, trigger="api", config=cfg)
        assert result.trigger == "api"
        assert result.config == cfg

    @pytest.mark.asyncio
    async def test_create_run_schedule_trigger(self, db, project):
        result = await create_run(db, project_id=project.id, trigger="schedule")
        assert result.trigger == "schedule"


class TestGetRun:
    @pytest.mark.asyncio
    async def test_get_existing_run(self, db, project):
        created = await create_run(db, project_id=project.id)
        fetched = await get_run(db, created.id)
        assert fetched is not None
        assert fetched.id == created.id
        assert fetched.project_id == project.id

    @pytest.mark.asyncio
    async def test_get_nonexistent_run(self, db):
        result = await get_run(db, 99999)
        assert result is None

    @pytest.mark.asyncio
    async def test_get_run_includes_events(self, db, project):
        created = await create_run(db, project_id=project.id)
        await add_run_event(db, created.id, "phase_start", phase="reason")
        fetched = await get_run(db, created.id)
        assert len(fetched.events) == 1
        assert fetched.events[0].event_type == "phase_start"


# ---------------------------------------------------------------------------
# Test: List Runs
# ---------------------------------------------------------------------------

class TestListRuns:
    @pytest.mark.asyncio
    async def test_list_all_runs(self, db, project):
        await create_run(db, project_id=project.id)
        await create_run(db, project_id=project.id)
        runs = await list_runs(db)
        assert len(runs) == 2

    @pytest.mark.asyncio
    async def test_list_filter_by_project(self, db, project, second_project):
        await create_run(db, project_id=project.id)
        await create_run(db, project_id=second_project.id)
        runs = await list_runs(db, project_id=project.id)
        assert len(runs) == 1
        assert runs[0].project_id == project.id

    @pytest.mark.asyncio
    async def test_list_filter_by_status(self, db, project):
        r1 = await create_run(db, project_id=project.id)
        await create_run(db, project_id=project.id)
        await update_run_status(db, r1.id, "completed")
        runs = await list_runs(db, status="completed")
        assert len(runs) == 1
        assert runs[0].status == "completed"

    @pytest.mark.asyncio
    async def test_list_with_limit_and_offset(self, db, project):
        for _ in range(5):
            await create_run(db, project_id=project.id)
        runs = await list_runs(db, limit=2, offset=0)
        assert len(runs) == 2
        runs_offset = await list_runs(db, limit=2, offset=3)
        assert len(runs_offset) == 2

    @pytest.mark.asyncio
    async def test_list_empty(self, db):
        runs = await list_runs(db)
        assert runs == []


# ---------------------------------------------------------------------------
# Test: Update Status
# ---------------------------------------------------------------------------

class TestUpdateRunStatus:
    @pytest.mark.asyncio
    async def test_update_to_completed(self, db, project):
        created = await create_run(db, project_id=project.id)
        updated = await update_run_status(db, created.id, "completed")
        assert updated.status == "completed"
        assert updated.ended_at is not None

    @pytest.mark.asyncio
    async def test_update_with_result_summary(self, db, project):
        created = await create_run(db, project_id=project.id)
        summary = {"tasks_completed": 5, "errors": 0}
        updated = await update_run_status(db, created.id, "completed", result_summary=summary)
        assert updated.result_summary == summary

    @pytest.mark.asyncio
    async def test_update_nonexistent_run(self, db):
        result = await update_run_status(db, 99999, "completed")
        assert result is None

    @pytest.mark.asyncio
    async def test_update_to_failed_sets_ended_at(self, db, project):
        created = await create_run(db, project_id=project.id)
        updated = await update_run_status(db, created.id, "failed")
        assert updated.status == "failed"
        assert updated.ended_at is not None


# ---------------------------------------------------------------------------
# Test: Cancel Run
# ---------------------------------------------------------------------------

class TestCancelRun:
    @pytest.mark.asyncio
    async def test_cancel_running_run(self, db, project):
        created = await create_run(db, project_id=project.id)
        cancelled = await cancel_run(db, created.id)
        assert cancelled.status == "cancelled"
        assert cancelled.ended_at is not None

    @pytest.mark.asyncio
    async def test_cancel_already_cancelled_returns_none(self, db, project):
        created = await create_run(db, project_id=project.id)
        first_cancel = await cancel_run(db, created.id)
        assert first_cancel.status == "cancelled"
        # Second cancel returns None because status is already terminal
        second_cancel = await cancel_run(db, created.id)
        assert second_cancel is None

    @pytest.mark.asyncio
    async def test_cancel_completed_run_returns_none(self, db, project):
        created = await create_run(db, project_id=project.id)
        await update_run_status(db, created.id, "completed")
        result = await cancel_run(db, created.id)
        assert result is None

    @pytest.mark.asyncio
    async def test_cancel_failed_run_returns_none(self, db, project):
        created = await create_run(db, project_id=project.id)
        await update_run_status(db, created.id, "failed")
        result = await cancel_run(db, created.id)
        assert result is None

    @pytest.mark.asyncio
    async def test_cancel_nonexistent_run(self, db):
        result = await cancel_run(db, 99999)
        assert result is None


# ---------------------------------------------------------------------------
# Test: Replay Run
# ---------------------------------------------------------------------------

class TestReplayRun:
    @pytest.mark.asyncio
    async def test_replay_creates_new_run(self, db, project):
        original = await create_run(
            db, project_id=project.id, config={"provider": "claude"}
        )
        # Must complete the run before replaying (only terminal runs can be replayed)
        await update_run_status(db, original.id, "completed")
        replayed = await replay_run(db, original.id)
        assert replayed is not None
        assert replayed.id != original.id
        assert replayed.parent_run_id == original.id
        assert replayed.trigger == "replay"
        assert replayed.status == "replaying"
        assert replayed.project_id == original.project_id

    @pytest.mark.asyncio
    async def test_replay_inherits_config(self, db, project):
        original = await create_run(
            db, project_id=project.id, config={"provider": "claude", "model": "opus"}
        )
        await update_run_status(db, original.id, "completed")
        replayed = await replay_run(db, original.id)
        assert replayed.config["provider"] == "claude"
        assert replayed.config["model"] == "opus"

    @pytest.mark.asyncio
    async def test_replay_with_config_overrides(self, db, project):
        original = await create_run(
            db, project_id=project.id, config={"provider": "claude", "model": "opus"}
        )
        await update_run_status(db, original.id, "failed")
        replayed = await replay_run(db, original.id, config_overrides={"model": "sonnet"})
        assert replayed.config["provider"] == "claude"
        assert replayed.config["model"] == "sonnet"

    @pytest.mark.asyncio
    async def test_replay_nonexistent_run(self, db):
        result = await replay_run(db, 99999)
        assert result is None

    @pytest.mark.asyncio
    async def test_replay_running_run_returns_none(self, db, project):
        original = await create_run(db, project_id=project.id)
        # Run is "running" -- replay should be blocked
        result = await replay_run(db, original.id)
        assert result is None

    @pytest.mark.asyncio
    async def test_replay_run_without_config(self, db, project):
        original = await create_run(db, project_id=project.id)
        await update_run_status(db, original.id, "cancelled")
        replayed = await replay_run(db, original.id, config_overrides={"model": "haiku"})
        assert replayed.config["model"] == "haiku"


# ---------------------------------------------------------------------------
# Test: Timeline Events
# ---------------------------------------------------------------------------

class TestTimeline:
    @pytest.mark.asyncio
    async def test_add_event(self, db, project):
        run = await create_run(db, project_id=project.id)
        event = await add_run_event(db, run.id, "phase_start", phase="reason")
        assert isinstance(event, RunEventResponse)
        assert event.event_type == "phase_start"
        assert event.phase == "reason"
        assert event.run_id == run.id

    @pytest.mark.asyncio
    async def test_add_event_with_details(self, db, project):
        run = await create_run(db, project_id=project.id)
        details = {"agent_id": 1, "task": "analyze requirements"}
        event = await add_run_event(
            db, run.id, "agent_spawn", phase="act", details=details
        )
        assert event.details == details

    @pytest.mark.asyncio
    async def test_get_timeline_ordered(self, db, project):
        run = await create_run(db, project_id=project.id)
        await add_run_event(db, run.id, "phase_start", phase="reason")
        await add_run_event(db, run.id, "phase_end", phase="reason")
        await add_run_event(db, run.id, "phase_start", phase="act")
        timeline = await get_run_timeline(db, run.id)
        assert isinstance(timeline, RunTimelineResponse)
        assert timeline.run_id == run.id
        assert len(timeline.events) == 3
        # Events should be in insertion order (timestamp order)
        assert timeline.events[0].event_type == "phase_start"
        assert timeline.events[0].phase == "reason"
        assert timeline.events[1].phase == "reason"
        assert timeline.events[2].phase == "act"

    @pytest.mark.asyncio
    async def test_get_timeline_nonexistent_run(self, db):
        result = await get_run_timeline(db, 99999)
        assert result is None

    @pytest.mark.asyncio
    async def test_timeline_duration_when_ended(self, db, project):
        run = await create_run(db, project_id=project.id)
        await update_run_status(db, run.id, "completed")
        timeline = await get_run_timeline(db, run.id)
        # Duration should be set since ended_at is populated
        assert timeline.duration_seconds is not None
        assert timeline.duration_seconds >= 0

    @pytest.mark.asyncio
    async def test_timeline_no_duration_when_running(self, db, project):
        run = await create_run(db, project_id=project.id)
        timeline = await get_run_timeline(db, run.id)
        assert timeline.duration_seconds is None

    @pytest.mark.asyncio
    async def test_add_multiple_event_types(self, db, project):
        run = await create_run(db, project_id=project.id)
        await add_run_event(db, run.id, "phase_start", phase="reason")
        await add_run_event(db, run.id, "agent_spawn", details={"name": "planner"})
        await add_run_event(db, run.id, "error", details={"msg": "timeout"})
        await add_run_event(db, run.id, "checkpoint")
        await add_run_event(db, run.id, "council_review", phase="verify")
        timeline = await get_run_timeline(db, run.id)
        assert len(timeline.events) == 5
        types = [e.event_type for e in timeline.events]
        assert "phase_start" in types
        assert "agent_spawn" in types
        assert "error" in types
        assert "checkpoint" in types
        assert "council_review" in types
