"""
Project Registry for Loki Mode Dashboard.

Manages cross-project registration, discovery, and tracking.
Projects are stored in ~/.loki/dashboard/projects.json
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
import hashlib


# Registry file location
REGISTRY_DIR = Path.home() / ".loki" / "dashboard"
REGISTRY_FILE = REGISTRY_DIR / "projects.json"


def _ensure_registry_dir() -> None:
    """Ensure the registry directory exists."""
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)


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
    """Save the project registry to disk."""
    _ensure_registry_dir()
    with open(REGISTRY_FILE, "w") as f:
        json.dump(registry, f, indent=2, default=str)


def _generate_project_id(path: str) -> str:
    """Generate a unique project ID from path."""
    return hashlib.md5(path.encode()).hexdigest()[:12]


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

    registry = _load_registry()
    project_id = _generate_project_id(path)

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
    registry = _load_registry()

    for pid, project in registry["projects"].items():
        if pid == identifier or project["path"] == identifier or project.get("alias") == identifier:
            project["last_accessed"] = datetime.now(timezone.utc).isoformat()
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
                if child.is_dir() and not child.name.startswith("."):
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
