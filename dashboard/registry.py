"""
Project Registry for Loki Mode Dashboard.

Manages cross-project registration, discovery, and tracking.
Projects are stored in ~/.loki/dashboard/projects.json
"""

from __future__ import annotations

import json
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional
import hashlib


# Registry file location
REGISTRY_DIR = Path.home() / ".loki" / "dashboard"
REGISTRY_FILE = REGISTRY_DIR / "projects.json"


def _ensure_registry_dir() -> None:
    """Ensure the registry directory exists."""
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)


@contextmanager
def _registry_lock() -> Iterator[None]:
    """
    Best-effort advisory lock around a read-modify-write of the registry.

    Two concurrent writers (e.g. two `loki docker start` in different repos, or
    a docker run racing a host `loki start`) would otherwise both load the old
    registry, mutate, and save, dropping one writer's entry (lost update). This
    serializes the leaf mutators so they take turns.

    Degrades gracefully: if fcntl is unavailable (Windows) or the lock cannot
    be acquired for any reason, execution proceeds without a lock rather than
    blocking a build. The atomic write in _save_registry still guarantees no
    reader ever sees a torn file; only the lost-update protection is
    best-effort.

    The lock path is derived from the current REGISTRY_DIR at call time (not a
    module-level constant) so tests that monkeypatch REGISTRY_DIR stay
    hermetic. Not reentrant: do not nest this around another leaf mutator (the
    leaf mutators do not call one another).
    """
    _ensure_registry_dir()
    lock_fd = None
    locked = False
    try:
        import fcntl  # POSIX only; absent on Windows

        lock_path = REGISTRY_DIR / ".registry.lock"
        try:
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            locked = True
        except OSError:
            # Could not open or lock the file; proceed without the lock.
            locked = False
    except ImportError:
        # fcntl not available (e.g. Windows); proceed without the lock.
        lock_fd = None

    try:
        yield
    finally:
        if lock_fd is not None:
            try:
                if locked:
                    import fcntl

                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except (OSError, ImportError):
                pass
            try:
                os.close(lock_fd)
            except OSError:
                pass


def _load_registry() -> dict:
    """Load the project registry from disk."""
    _ensure_registry_dir()
    if REGISTRY_FILE.exists():
        try:
            with open(REGISTRY_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {"version": "1.0", "projects": {}}
    return {"version": "1.0", "projects": {}}


def _save_registry(registry: dict) -> None:
    """
    Save the project registry to disk atomically.

    Writes to a temp file in the SAME directory as REGISTRY_FILE (so os.replace
    is an atomic rename on the same filesystem), flushes and fsyncs it, then
    os.replace()s it over the destination. Every reader therefore sees either
    the complete old file or the complete new file, never a half-written (torn)
    one. The temp file is removed on any error path so partial files never
    leak.

    Note: atomic write alone eliminates torn reads but does not by itself
    prevent lost updates under true simultaneity. The leaf mutators wrap their
    load->mutate->save in _registry_lock() to serialize concurrent writers and
    reduce that window; when locking is unavailable the degradation is honest
    (torn reads still impossible, lost-update still possible).
    """
    _ensure_registry_dir()
    tmp_fd, tmp_path = tempfile.mkstemp(
        dir=str(REGISTRY_DIR), prefix=".projects.", suffix=".tmp"
    )
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(registry, f, indent=2, default=str)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, str(REGISTRY_FILE))
    except BaseException:
        # Clean up the temp file on any failure so we never leak partial files.
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _generate_project_id(path: str) -> str:
    """Generate a unique project ID from path."""
    return hashlib.sha256(path.encode()).hexdigest()[:12]


def register_project(
    path: str,
    name: Optional[str] = None,
    alias: Optional[str] = None,
) -> dict:
    """
    Register a project in the registry.

    Args:
        path: Absolute path to the project directory
        name: Display name (defaults to directory name)
        alias: Short alias for CLI usage

    Returns:
        The registered project entry
    """
    path = os.path.abspath(os.path.expanduser(path))

    if not os.path.isdir(path):
        raise ValueError(f"Path does not exist: {path}")

    project_id = _generate_project_id(path)

    # Lock the load->mutate->save so concurrent registrations serialize and do
    # not lost-update each other (the multi-repo `loki docker` happy path).
    with _registry_lock():
        registry = _load_registry()

        # Check if already registered
        if project_id in registry["projects"]:
            # Update existing entry
            project = registry["projects"][project_id]
            if name:
                project["name"] = name
            if alias:
                project["alias"] = alias
            project["updated_at"] = datetime.now(timezone.utc).isoformat()
        else:
            # Create new entry
            project = {
                "id": project_id,
                "path": path,
                "name": name or os.path.basename(path),
                "alias": alias,
                "registered_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "last_accessed": None,
                "has_loki_dir": os.path.isdir(os.path.join(path, ".loki")),
                "status": "active",
            }
            registry["projects"][project_id] = project

        _save_registry(registry)
    return project


def unregister_project(identifier: str) -> bool:
    """
    Remove a project from the registry.

    Args:
        identifier: Project ID, path, or alias

    Returns:
        True if removed, False if not found
    """
    with _registry_lock():
        registry = _load_registry()

        # Find by ID, path, or alias
        project_id = None
        for pid, project in registry["projects"].items():
            if pid == identifier or project["path"] == identifier or project.get("alias") == identifier:
                project_id = pid
                break

        if project_id:
            del registry["projects"][project_id]
            _save_registry(registry)
            return True
    return False


def get_project(identifier: str) -> Optional[dict]:
    """
    Get a project by ID, path, or alias.

    Args:
        identifier: Project ID, path, or alias

    Returns:
        Project entry or None
    """
    registry = _load_registry()

    for pid, project in registry["projects"].items():
        if pid == identifier or project["path"] == identifier or project.get("alias") == identifier:
            return project
    return None


def list_projects(include_inactive: bool = False) -> list[dict]:
    """
    List all registered projects.

    Args:
        include_inactive: Whether to include inactive projects

    Returns:
        List of project entries
    """
    registry = _load_registry()
    projects = list(registry["projects"].values())

    if not include_inactive:
        projects = [p for p in projects if p.get("status") == "active"]

    # Sort by last accessed (most recent first)
    projects.sort(
        key=lambda p: p.get("last_accessed") or p.get("registered_at") or "",
        reverse=True
    )
    return projects


def update_last_accessed(identifier: str) -> Optional[dict]:
    """
    Update the last accessed timestamp for a project.

    Args:
        identifier: Project ID, path, or alias

    Returns:
        Updated project entry or None
    """
    with _registry_lock():
        registry = _load_registry()

        for pid, project in registry["projects"].items():
            if pid == identifier or project["path"] == identifier or project.get("alias") == identifier:
                project["last_accessed"] = datetime.now(timezone.utc).isoformat()
                _save_registry(registry)
                return project
    return None


def mark_project_stopped(identifier: str) -> Optional[dict]:
    """
    Mark a project's runtime status as stopped and clear its live pid.

    Used when a session ends (loki stop, dashboard per-project stop, or a
    graceful Ctrl+C teardown) so the multi-project switcher reflects the
    project as not-running immediately, without waiting for pid-liveness to
    catch up. The entry is intentionally kept (not unregistered) so the
    project stays selectable and re-registers cleanly on the next loki start.

    Args:
        identifier: Project ID, path, or alias

    Returns:
        The updated project entry, or None if no matching project was found.
        Idempotent: marking an already-stopped project is a no-op that still
        returns the entry.
    """
    with _registry_lock():
        registry = _load_registry()

        for pid_key, project in registry["projects"].items():
            if (
                pid_key == identifier
                or project["path"] == identifier
                or project.get("alias") == identifier
            ):
                project["status"] = "stopped"
                project["pid"] = None
                project["updated_at"] = datetime.now(timezone.utc).isoformat()
                _save_registry(registry)
                return project
    return None


def check_project_health(identifier: str) -> dict:
    """
    Check the health status of a project.

    Args:
        identifier: Project ID, path, or alias

    Returns:
        Health status dict with checks
    """
    project = get_project(identifier)
    if not project:
        return {"status": "not_found", "checks": {}}

    path = project["path"]
    checks = {
        "path_exists": os.path.isdir(path),
        "loki_dir_exists": os.path.isdir(os.path.join(path, ".loki")),
        "state_exists": os.path.isfile(os.path.join(path, ".loki", "state", "session.json")),
        "prd_exists": any(
            os.path.isfile(os.path.join(path, f))
            for f in ["PRD.md", "prd.md", "docs/PRD.md", "docs/prd.md"]
        ),
    }

    # Determine overall status
    if not checks["path_exists"]:
        status = "missing"
    elif not checks["loki_dir_exists"]:
        status = "uninitialized"
    elif checks["state_exists"]:
        status = "active"
    else:
        status = "idle"

    return {
        "status": status,
        "checks": checks,
        "project": project,
    }


def discover_projects(
    search_paths: Optional[list[str]] = None,
    max_depth: int = 3,
) -> list[dict]:
    """
    Auto-discover projects with .loki directories.

    Args:
        search_paths: Paths to search (defaults to home and common dev dirs)
        max_depth: Maximum directory depth to search

    Returns:
        List of discovered project paths with metadata
    """
    if search_paths is None:
        home = Path.home()
        search_paths = [
            str(home / "git"),
            str(home / "projects"),
            str(home / "code"),
            str(home / "dev"),
            str(home / "workspace"),
            str(home / "src"),
        ]

    discovered = []
    visited = set()

    def search_dir(path: Path, depth: int) -> None:
        if depth > max_depth:
            return

        path_str = str(path.resolve())
        if path_str in visited:
            return
        visited.add(path_str)

        try:
            if not path.is_dir():
                return

            # Check for .loki directory
            loki_dir = path / ".loki"
            if loki_dir.is_dir():
                discovered.append({
                    "path": path_str,
                    "name": path.name,
                    "has_state": (loki_dir / "state" / "session.json").exists(),
                    "has_prd": any(
                        (path / f).exists()
                        for f in ["PRD.md", "prd.md", "docs/PRD.md"]
                    ),
                })
                return  # Don't search subdirectories of loki projects

            # Search subdirectories
            for child in path.iterdir():
                # Skip symlinks to avoid following into unexpected directories
                if child.is_dir() and not child.name.startswith(".") and not child.is_symlink():
                    search_dir(child, depth + 1)

        except (PermissionError, OSError):
            pass

    for search_path in search_paths:
        path = Path(search_path)
        if path.exists():
            search_dir(path, 0)

    return discovered


def sync_registry_with_discovery() -> dict:
    """
    Sync the registry with discovered projects.

    Returns:
        Summary of sync results
    """
    registry = _load_registry()
    discovered = discover_projects()

    # Track results
    added = []
    updated = []
    missing = []

    # Add/update discovered projects
    discovered_paths = set()
    for project_info in discovered:
        path = project_info["path"]
        discovered_paths.add(path)
        project_id = _generate_project_id(path)

        if project_id not in registry["projects"]:
            # New project
            project = register_project(path)
            added.append(project)
        else:
            # Update existing
            project = registry["projects"][project_id]
            project["has_loki_dir"] = True
            project["updated_at"] = datetime.now(timezone.utc).isoformat()
            updated.append(project)

    # Check for missing projects
    for project_id, project in registry["projects"].items():
        if not os.path.isdir(project["path"]):
            project["status"] = "missing"
            missing.append(project)

    _save_registry(registry)

    return {
        "added": len(added),
        "updated": len(updated),
        "missing": len(missing),
        "total": len(registry["projects"]),
        "details": {
            "added": added,
            "updated": updated,
            "missing": missing,
        }
    }


def get_cross_project_tasks(project_ids: Optional[list[str]] = None) -> list[dict]:
    """
    Get tasks from multiple projects (for unified view).

    This reads from .loki/state/tasks.json in each project.

    Args:
        project_ids: List of project IDs (None = all active projects)

    Returns:
        List of tasks with project metadata
    """
    if project_ids is None:
        projects = list_projects()
    else:
        projects = [get_project(pid) for pid in project_ids if get_project(pid)]

    all_tasks = []

    for project in projects:
        tasks_file = Path(project["path"]) / ".loki" / "state" / "tasks.json"
        if tasks_file.exists():
            try:
                with open(tasks_file, "r") as f:
                    tasks_data = json.load(f)
                    tasks = tasks_data.get("tasks", [])

                    # Add project metadata to each task
                    for task in tasks:
                        task["_project_id"] = project["id"]
                        task["_project_name"] = project["name"]
                        task["_project_path"] = project["path"]

                    all_tasks.extend(tasks)
            except (json.JSONDecodeError, IOError):
                pass

    return all_tasks


def _pid_alive(pid) -> bool:
    """Return True if pid is a positive int naming a live process.

    Mirrors the liveness probe used by the dashboard's running-projects view:
    signal 0 delivered -> alive; EPERM (owned by another user) -> alive; ESRCH
    -> dead. Never raises.
    """
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (ProcessLookupError, OSError):
        return False


def _read_project_run_snapshot(path: str) -> dict:
    """Read a single project's live run snapshot from its .loki/ state files.

    HONEST SCOPE: this polls the shared on-disk metadata that `loki start`
    already writes per project (no new store, no controller). It reads:
      - .loki/dashboard-state.json (phase, iteration; written ~every 2s)
      - .loki/session.json         (status, startedAt fallback)
      - .loki/metrics/efficiency/*.json (summed cost_usd) with a
        .loki/context/tracking.json fallback (totals.total_cost_usd)

    Returns a dict with phase, iteration, cost_usd, started_at, and ended_at
    (best-effort; missing values default to None/0). Never raises: any file
    problem degrades the affected field to its default.
    """
    snap = {
        "phase": "",
        "iteration": 0,
        "cost_usd": 0.0,
        "started_at": None,
        "ended_at": None,
    }
    if not path:
        return snap
    loki_dir = Path(path) / ".loki"

    # Phase + iteration from dashboard-state.json (the live writer).
    state_file = loki_dir / "dashboard-state.json"
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
            if isinstance(state, dict):
                _p = state.get("phase", "")
                snap["phase"] = _p if isinstance(_p, str) else ""
                _i = state.get("iteration", 0)
                snap["iteration"] = _i if isinstance(_i, int) else 0
        except (json.JSONDecodeError, OSError, ValueError):
            pass

    # Timestamps from session.json (startedAt; endedAt when present).
    session_file = loki_dir / "session.json"
    if session_file.exists():
        try:
            sd = json.loads(session_file.read_text())
            if isinstance(sd, dict):
                _sa = sd.get("startedAt") or sd.get("started_at")
                snap["started_at"] = _sa if isinstance(_sa, str) else None
                _ea = sd.get("endedAt") or sd.get("ended_at")
                snap["ended_at"] = _ea if isinstance(_ea, str) else None
        except (json.JSONDecodeError, OSError, ValueError):
            pass

    # Cost: sum per-iteration efficiency files; fall back to context tracking.
    cost = 0.0
    found_cost = False
    eff_dir = loki_dir / "metrics" / "efficiency"
    if eff_dir.is_dir():
        try:
            for eff_file in eff_dir.glob("*.json"):
                try:
                    data = json.loads(eff_file.read_text())
                    if not isinstance(data, dict):
                        continue
                    c = data.get("cost_usd")
                    if isinstance(c, (int, float)):
                        cost += float(c)
                        found_cost = True
                except (json.JSONDecodeError, OSError, ValueError):
                    continue
        except OSError:
            pass
    if not found_cost:
        ctx_file = loki_dir / "context" / "tracking.json"
        if ctx_file.exists():
            try:
                ctx = json.loads(ctx_file.read_text())
                if isinstance(ctx, dict):
                    totals = ctx.get("totals", {})
                    if isinstance(totals, dict):
                        tc = totals.get("total_cost_usd")
                        if isinstance(tc, (int, float)):
                            cost = float(tc)
            except (json.JSONDecodeError, OSError, ValueError):
                pass
    snap["cost_usd"] = round(cost, 6)
    return snap


def get_fleet_runs(include_inactive: bool = True) -> list[dict]:
    """Build a fleet-wide view of builds across ALL registered projects.

    v1 SCOPE (honest): this polls the shared metadata store that `loki start`
    already maintains -- the machine-global registry (~/.loki/dashboard/
    projects.json) plus each project's own .loki/ state files. There is NO
    controller, CRD, or Job-watcher here; a real k8s operator watching Jobs is
    future work. One registered project maps to one "run" entry (its current /
    most-recent build), which is the granularity the registry tracks.

    Each entry carries: id, name, path, status (running|stopped|<registry
    status>), running (live pid probe), phase, iteration, cost_usd, started_at,
    duration_seconds, port. Never raises: registry problems degrade to an empty
    list and per-project read problems degrade that entry's fields.
    """
    try:
        projects = list_projects(include_inactive=include_inactive)
    except Exception:
        return []

    out = []
    for p in projects:
        path = p.get("path", "")
        pid = p.get("pid")
        running = _pid_alive(pid)
        snap = _read_project_run_snapshot(path)

        # A live pid is authoritative for "running"; otherwise reflect the
        # registry status (stopped/active/missing). This mirrors the
        # running-projects endpoint's pid-first precedence.
        if running:
            status = "running"
        else:
            status = p.get("status") or "unknown"

        # Duration: wall time from started_at to ended_at (or now if running).
        duration_seconds = None
        started_at = snap.get("started_at")
        if started_at:
            try:
                st = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
                if st.tzinfo is None:
                    st = st.replace(tzinfo=timezone.utc)
                end_ref = None
                ended_at = snap.get("ended_at")
                if ended_at and not running:
                    try:
                        end_ref = datetime.fromisoformat(
                            str(ended_at).replace("Z", "+00:00")
                        )
                        if end_ref.tzinfo is None:
                            end_ref = end_ref.replace(tzinfo=timezone.utc)
                    except (ValueError, TypeError):
                        end_ref = None
                if end_ref is None:
                    end_ref = datetime.now(timezone.utc)
                duration_seconds = max(0, int((end_ref - st).total_seconds()))
            except (ValueError, TypeError):
                duration_seconds = None

        out.append({
            "id": p.get("id"),
            "name": p.get("name") or (os.path.basename(path) if path else "project"),
            "path": path,
            "status": status,
            "running": running,
            "phase": snap.get("phase", ""),
            "iteration": snap.get("iteration", 0),
            "cost_usd": snap.get("cost_usd", 0.0),
            "started_at": started_at,
            "duration_seconds": duration_seconds,
            "port": p.get("port"),
        })

    # Running builds first, then by most-recent start time.
    out.sort(
        key=lambda r: (
            0 if r.get("running") else 1,
            r.get("started_at") or "",
        ),
        reverse=False,
    )
    # Within the same running-group, most recent start first.
    out.sort(key=lambda r: r.get("started_at") or "", reverse=True)
    out.sort(key=lambda r: 0 if r.get("running") else 1)
    return out


def get_fleet_summary(include_inactive: bool = True) -> dict:
    """Aggregate fleet-wide totals from get_fleet_runs().

    Returns counts (total / running / stopped) and a summed cost across all
    registered projects. v1 polls the shared metadata store (see
    get_fleet_runs); not a controller. Never raises.
    """
    runs = get_fleet_runs(include_inactive=include_inactive)
    total = len(runs)
    running = sum(1 for r in runs if r.get("running"))
    total_cost = round(sum(float(r.get("cost_usd") or 0.0) for r in runs), 6)
    return {
        "total_runs": total,
        "running_runs": running,
        "stopped_runs": total - running,
        "total_cost_usd": total_cost,
    }


def get_cross_project_learnings() -> dict:
    """
    Get learnings from the global learnings database.

    Returns:
        Dict with patterns, mistakes, successes
    """
    learnings_dir = Path.home() / ".loki" / "learnings"
    result = {
        "patterns": [],
        "mistakes": [],
        "successes": [],
    }

    for learning_type in ["patterns", "mistakes", "successes"]:
        file_path = learnings_dir / f"{learning_type}.jsonl"
        if file_path.exists():
            try:
                with open(file_path, "r") as f:
                    for line in f:
                        try:
                            entry = json.loads(line.strip())
                            if "description" in entry:  # Skip header
                                result[learning_type].append(entry)
                        except json.JSONDecodeError:
                            pass
            except IOError:
                pass

    return result
