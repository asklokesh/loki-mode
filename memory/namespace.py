"""
Loki Mode Memory System - Namespace Management

Provides project isolation via namespaces, allowing memories to be scoped
to specific projects/workspaces while supporting cross-namespace access.

Features:
- Auto-detection from git repo, package.json, or directory name
- Namespace inheritance (child namespaces can access parent)
- Cross-namespace search for global patterns
- Default namespace based on current directory

Based on competitor analysis (claude-mem project isolation patterns).
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import subprocess
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Set


# Default namespace when none can be detected
DEFAULT_NAMESPACE = "default"

# Global namespace for cross-project patterns
GLOBAL_NAMESPACE = "global"


@dataclass
class NamespaceInfo:
    """
    Information about a memory namespace.

    Attributes:
        name: Unique namespace identifier
        display_name: Human-readable name
        path: Base path for the namespace
        parent: Optional parent namespace for inheritance
        created_at: When the namespace was created
        description: Optional description
        metadata: Additional namespace metadata
    """
    name: str
    display_name: str
    path: str
    parent: Optional[str] = None
    created_at: Optional[datetime] = None
    description: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "name": self.name,
            "display_name": self.display_name,
            "path": self.path,
            "parent": self.parent,
            "description": self.description,
            "metadata": self.metadata,
        }
        if self.created_at:
            iso = self.created_at.isoformat()
            if iso.endswith("+00:00"):
                iso = iso[:-6] + "Z"
            elif not iso.endswith("Z"):
                iso = iso + "Z"
            result["created_at"] = iso
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "NamespaceInfo":
        """Create from dictionary."""
        created_at = None
        if data.get("created_at"):
            created_str = data["created_at"]
            if isinstance(created_str, str):
                if created_str.endswith("Z"):
                    created_str = created_str[:-1]
                created_at = datetime.fromisoformat(created_str)

        return cls(
            name=data.get("name", ""),
            display_name=data.get("display_name", ""),
            path=data.get("path", ""),
            parent=data.get("parent"),
            created_at=created_at,
            description=data.get("description", ""),
            metadata=data.get("metadata", {}),
        )


class NamespaceManager:
    """
    Manages memory namespaces for project isolation.

    Provides:
    - Namespace auto-detection from project files
    - Namespace creation, listing, and deletion
    - Inheritance chain resolution
    - Path computation for namespaced storage
    """

    # Global registry path for all namespaces
    REGISTRY_FILE = "namespaces.json"

    def __init__(self, base_path: str = ".loki/memory"):
        """
        Initialize the namespace manager.

        Args:
            base_path: Base path for memory storage
        """
        self.base_path = Path(base_path)
        self._ensure_registry()

    def _ensure_registry(self) -> None:
        """Ensure the namespace registry file exists."""
        registry_path = self.base_path / self.REGISTRY_FILE
        if not registry_path.exists():
            self.base_path.mkdir(parents=True, exist_ok=True)
            initial_registry = {
                "version": "1.0.0",
                "created_at": datetime.now(timezone.utc).isoformat() + "Z",
                "namespaces": {},
            }
            with open(registry_path, "w") as f:
                json.dump(initial_registry, f, indent=2)

    @contextmanager
    def _file_lock(self, path: Path, exclusive: bool = True) -> Generator[None, None, None]:
        """Acquire a file lock for safe concurrent access."""
        lock_path = Path(str(path) + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)

        lock_file = None
        try:
            lock_file = open(lock_path, "w")
            lock_type = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            fcntl.flock(lock_file.fileno(), lock_type)
            yield
        finally:
            if lock_file is not None:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                lock_file.close()
                try:
                    os.remove(lock_path)
                except OSError:
                    pass

    def _load_registry(self) -> Dict[str, Any]:
        """Load the namespace registry with shared file lock."""
        registry_path = self.base_path / self.REGISTRY_FILE
        if not registry_path.exists():
            return {"version": "1.0.0", "namespaces": {}}

        with self._file_lock(registry_path, exclusive=False):
            with open(registry_path, "r") as f:
                return json.load(f)

    def _save_registry(self, registry: Dict[str, Any]) -> None:
        """Save the namespace registry with exclusive file lock."""
        registry_path = self.base_path / self.REGISTRY_FILE
        self.base_path.mkdir(parents=True, exist_ok=True)
        with self._file_lock(registry_path, exclusive=True):
            with open(registry_path, "w") as f:
                json.dump(registry, f, indent=2)

    # -------------------------------------------------------------------------
    # Auto-Detection
    # -------------------------------------------------------------------------

    def detect_namespace(self, working_dir: Optional[str] = None) -> str:
        """
        Auto-detect namespace from the current project context.

        Detection order:
        1. Git repository name
        2. package.json name
        3. Directory name

        Args:
            working_dir: Working directory to detect from (defaults to cwd)

        Returns:
            Detected namespace name
        """
        working_dir = working_dir or os.getcwd()

        # Try git repo name first
        git_name = self._detect_from_git(working_dir)
        if git_name:
            return self._sanitize_namespace(git_name)

        # Try package.json
        package_name = self._detect_from_package_json(working_dir)
        if package_name:
            return self._sanitize_namespace(package_name)

        # Fallback to directory name
        dir_name = os.path.basename(os.path.abspath(working_dir))
        if dir_name:
            return self._sanitize_namespace(dir_name)

        return DEFAULT_NAMESPACE

    def _detect_from_git(self, working_dir: str) -> Optional[str]:
        """Detect namespace from git repository."""
        try:
            # Get the repository root
            result = subprocess.run(
                ["git", "rev-parse", "--show-toplevel"],
                cwd=working_dir,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode != 0:
                return None

            repo_root = result.stdout.strip()
            if not repo_root:
                return None

            # Get the repo name from the directory
            repo_name = os.path.basename(repo_root)

            # Also try to get remote origin URL for better naming
            result = subprocess.run(
                ["git", "config", "--get", "remote.origin.url"],
                cwd=working_dir,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0 and result.stdout.strip():
                url = result.stdout.strip()
                # Extract repo name from URL
                # Handle: https://github.com/user/repo.git or git@github.com:user/repo.git
                match = re.search(r"[/:]([^/]+?)(?:\.git)?$", url)
                if match:
                    repo_name = match.group(1)

            return repo_name

        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            return None

    def _detect_from_package_json(self, working_dir: str) -> Optional[str]:
        """Detect namespace from package.json."""
        package_path = Path(working_dir) / "package.json"
        if not package_path.exists():
            # Check parent directories
            current = Path(working_dir)
            for _ in range(5):  # Max 5 levels up
                parent = current.parent
                if parent == current:
                    break
                package_path = parent / "package.json"
                if package_path.exists():
                    break
                current = parent
            else:
                return None

        if not package_path.exists():
            return None

        try:
            with open(package_path, "r") as f:
                package_data = json.load(f)
                name = package_data.get("name", "")
                if name:
                    # Handle scoped packages: @scope/name -> scope-name
                    if name.startswith("@"):
                        name = name[1:].replace("/", "-")
                    return name
        except (json.JSONDecodeError, IOError):
            pass

        return None

    def _sanitize_namespace(self, name: str) -> str:
        """
        Sanitize a namespace name to be filesystem-safe.

        - Lowercase
        - Replace spaces and special chars with hyphens
        - Remove consecutive hyphens
        - Max 64 characters
        """
        # Lowercase and replace problematic characters
        sanitized = name.lower()
        sanitized = re.sub(r"[^a-z0-9-]", "-", sanitized)
        # Remove consecutive hyphens
        sanitized = re.sub(r"-+", "-", sanitized)
        # Remove leading/trailing hyphens
        sanitized = sanitized.strip("-")
        # Limit length
        sanitized = sanitized[:64]

        return sanitized or DEFAULT_NAMESPACE

    # -------------------------------------------------------------------------
    # Namespace CRUD Operations
    # -------------------------------------------------------------------------

    def create_namespace(
        self,
        name: str,
        display_name: Optional[str] = None,
        parent: Optional[str] = None,
        description: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> NamespaceInfo:
        """
        Create a new namespace.

        Args:
            name: Unique namespace identifier
            display_name: Human-readable name (defaults to name)
            parent: Optional parent namespace for inheritance
            description: Optional description
            metadata: Additional metadata

        Returns:
            Created NamespaceInfo

        Raises:
            ValueError: If namespace already exists or parent doesn't exist
        """
        name = self._sanitize_namespace(name)
        display_name = display_name or name

        registry = self._load_registry()
        namespaces = registry.get("namespaces", {})

        if name in namespaces:
            raise ValueError(f"Namespace '{name}' already exists")

        if parent and parent not in namespaces and parent != GLOBAL_NAMESPACE:
            raise ValueError(f"Parent namespace '{parent}' does not exist")

        # Create namespace directory
        namespace_path = self.base_path / name
        namespace_path.mkdir(parents=True, exist_ok=True)

        # Create subdirectories
        for subdir in ["episodic", "semantic", "skills", "vectors"]:
            (namespace_path / subdir).mkdir(exist_ok=True)

        # Create namespace info
        info = NamespaceInfo(
            name=name,
            display_name=display_name,
            path=str(namespace_path),
            parent=parent,
            created_at=datetime.now(timezone.utc),
            description=description,
            metadata=metadata or {},
        )

        # Save to registry
        namespaces[name] = info.to_dict()
        registry["namespaces"] = namespaces
        self._save_registry(registry)

        return info

    def get_namespace(self, name: str) -> Optional[NamespaceInfo]:
        """
        Get namespace information by name.

        Args:
            name: Namespace identifier

        Returns:
            NamespaceInfo or None if not found
        """
        registry = self._load_registry()
        namespaces = registry.get("namespaces", {})

        if name not in namespaces:
            return None

        return NamespaceInfo.from_dict(namespaces[name])

    def list_namespaces(self) -> List[NamespaceInfo]:
        """
        List all registered namespaces.

        Returns:
            List of NamespaceInfo objects
        """
        registry = self._load_registry()
        namespaces = registry.get("namespaces", {})

        return [
            NamespaceInfo.from_dict(data)
            for data in namespaces.values()
        ]

    def delete_namespace(self, name: str, delete_data: bool = False) -> bool:
        """
        Delete a namespace.

        Args:
            name: Namespace identifier
            delete_data: If True, also delete the namespace's data

        Returns:
            True if deleted, False if not found
        """
        registry = self._load_registry()
        namespaces = registry.get("namespaces", {})

        if name not in namespaces:
            return False

        # Check for child namespaces
        children = [ns for ns, data in namespaces.items() if data.get("parent") == name]
        if children:
            raise ValueError(
                f"Cannot delete namespace '{name}': has child namespaces: {children}"
            )

        # Optionally delete data
        if delete_data:
            namespace_path = self.base_path / name
            if namespace_path.exists():
                import shutil
                shutil.rmtree(namespace_path)

        # Remove from registry
        del namespaces[name]
        registry["namespaces"] = namespaces
        self._save_registry(registry)

        return True

    # -------------------------------------------------------------------------
    # Namespace Path Resolution
    # -------------------------------------------------------------------------

    def get_namespace_path(self, namespace: str) -> Path:
        """
        Get the storage path for a namespace.

        Args:
            namespace: Namespace identifier

        Returns:
            Path to the namespace's storage directory
        """
        if namespace == DEFAULT_NAMESPACE:
            return self.base_path
        return self.base_path / namespace

    def ensure_namespace_exists(self, namespace: str) -> Path:
        """
        Ensure a namespace directory exists, creating if needed.

        Args:
            namespace: Namespace identifier

        Returns:
            Path to the namespace's storage directory
        """
        namespace_path = self.get_namespace_path(namespace)

        # Create directory structure
        namespace_path.mkdir(parents=True, exist_ok=True)
        for subdir in ["episodic", "semantic", "skills", "vectors"]:
            (namespace_path / subdir).mkdir(exist_ok=True)

        # Auto-register if not in registry
        registry = self._load_registry()
        namespaces = registry.get("namespaces", {})
        if namespace not in namespaces and namespace != DEFAULT_NAMESPACE:
            info = NamespaceInfo(
                name=namespace,
                display_name=namespace,
                path=str(namespace_path),
                created_at=datetime.now(timezone.utc),
            )
            namespaces[namespace] = info.to_dict()
            registry["namespaces"] = namespaces
            self._save_registry(registry)

        return namespace_path

    # -------------------------------------------------------------------------
    # Inheritance Chain
    # -------------------------------------------------------------------------

    def get_inheritance_chain(self, namespace: str) -> List[str]:
        """
        Get the inheritance chain for a namespace.

        Returns namespaces from most specific to most general,
        always ending with the global namespace.

        Args:
            namespace: Starting namespace

        Returns:
            List of namespace names in inheritance order
        """
        chain = [namespace]
        registry = self._load_registry()
        namespaces = registry.get("namespaces", {})

        current = namespace
        seen: Set[str] = {namespace}

        while current in namespaces:
            parent = namespaces[current].get("parent")
            if not parent or parent in seen:
                break
            chain.append(parent)
            seen.add(parent)
            current = parent

        # Always include global at the end if not already present
        if GLOBAL_NAMESPACE not in chain:
            chain.append(GLOBAL_NAMESPACE)

        return chain

    def get_searchable_namespaces(
        self,
        namespace: str,
        include_global: bool = True,
        include_parents: bool = True,
    ) -> List[str]:
        """
        Get all namespaces that should be searched for a given namespace.

        Args:
            namespace: Primary namespace
            include_global: Include global namespace
            include_parents: Include parent namespaces

        Returns:
            List of namespace names to search
        """
        if include_parents:
            namespaces = self.get_inheritance_chain(namespace)
        else:
            namespaces = [namespace]

        if include_global and GLOBAL_NAMESPACE not in namespaces:
            namespaces.append(GLOBAL_NAMESPACE)
        elif not include_global and GLOBAL_NAMESPACE in namespaces:
            namespaces = [ns for ns in namespaces if ns != GLOBAL_NAMESPACE]

        return namespaces


# Convenience function for quick namespace detection
def detect_namespace(working_dir: Optional[str] = None) -> str:
    """
    Detect namespace from the current directory.

    This is a convenience function that creates a temporary NamespaceManager
    and detects the namespace.

    Args:
        working_dir: Working directory (defaults to cwd)

    Returns:
        Detected namespace name
    """
    manager = NamespaceManager()
    return manager.detect_namespace(working_dir)
