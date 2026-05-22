"""App graph -- shared memory + CLAUDE.md across sibling project members.

Phase F cross-project context. Reads `.loki/app.json` manifests written by
the bash route (or the Bun route in `loki-ts/src/project_graph.ts`) and
exposes the resulting graph to Python consumers. The graph is informational:
the actual shared-memory plumbing happens via the `LOKI_MEMORY_BASE_PATH`
env override which `MemoryStorage` honors transparently.

Scope: only CLAUDE.md + memory are shared. State, queue, and checkpoints
stay per-member. No symlinks are created. Wraps `CrossProjectIndex` so
existing cross-project memory lookups remain available within an app
graph.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import List, Optional

from .cross_project import CrossProjectIndex


APP_ID_REGEX = re.compile(r"^[a-z0-9-]{3,40}$")
SUPPORTED_SCHEMA_VERSION = 1


class AppGraph:
    """An application graph composed of sibling project members.

    Constructed either from env vars (set by the bash/Bun discovery routine)
    or directly from a `.loki/app.json` manifest. Holds the canonical view
    of which directories share memory + CLAUDE.md.
    """

    def __init__(
        self,
        app_id: str,
        root: Path,
        members: List[Path],
        shared_memory_dir: Optional[Path] = None,
    ) -> None:
        if not APP_ID_REGEX.match(app_id):
            raise ValueError(
                f"invalid app_id '{app_id}': must match {APP_ID_REGEX.pattern}"
            )
        self.app_id = app_id
        self.root = Path(root)
        self._members = [Path(m) for m in members]
        # Note: shared_memory_dir is a 4th param beyond the documented spec
        # (architect deviation -- see report). The spec lets app.json declare
        # `shared_memory_dir`, but the documented constructor signature has
        # no slot for it. Without this field, manifests that set the field
        # would silently lose it on round-trip through from_app_json().
        self._shared_memory_dir = (
            Path(shared_memory_dir) if shared_memory_dir is not None else None
        )

    def get_shared_memory_path(self) -> Path:
        """Return the shared memory directory for this app graph.

        Defaults to `<root>/.loki-shared/memory/`. If the manifest declared
        a `shared_memory_dir`, that value is honored verbatim (treated as
        an absolute path or resolved against the graph root if relative).
        """
        if self._shared_memory_dir is not None:
            p = self._shared_memory_dir
            if not p.is_absolute():
                p = self.root / p
            return p
        return self.root / ".loki-shared" / "memory"

    def get_members(self) -> List[Path]:
        """Return absolute member directory paths."""
        return [m.resolve() if not m.is_absolute() else m for m in self._members]

    def cross_project_index(self) -> CrossProjectIndex:
        """Return a CrossProjectIndex scoped to this app's member dirs.

        Lets callers reuse the existing cross-project discovery code over
        just the members of the current app graph instead of the global
        home/git/projects search dirs.
        """
        return CrossProjectIndex(search_dirs=[m.parent for m in self.get_members()])

    @classmethod
    def from_env(cls) -> Optional["AppGraph"]:
        """Build from LOKI_PROJECT_GRAPH_* env vars set by discovery.

        Returns None when LOKI_PROJECT_GRAPH_ROOT is not in the environment.
        """
        root = os.environ.get("LOKI_PROJECT_GRAPH_ROOT")
        app_id = os.environ.get("LOKI_PROJECT_GRAPH_APP_ID")
        members_raw = os.environ.get("LOKI_PROJECT_GRAPH_MEMBERS", "")
        shared_mem_raw = os.environ.get("LOKI_PROJECT_GRAPH_SHARED_MEMORY_DIR")
        if not root or not app_id:
            return None
        members = [Path(p) for p in members_raw.split(":") if p]
        shared_memory_dir = Path(shared_mem_raw) if shared_mem_raw else None
        return cls(
            app_id=app_id,
            root=Path(root),
            members=members,
            shared_memory_dir=shared_memory_dir,
        )

    @classmethod
    def from_app_json(cls, path: Path) -> "AppGraph":
        """Parse a `.loki/app.json` manifest. Raises on schema mismatch.

        `path` may point at the manifest file itself or at a directory that
        contains `.loki/app.json`. The graph root is the directory that
        contains `.loki/`.
        """
        path = Path(path)
        if path.is_dir():
            manifest_path = path / ".loki" / "app.json"
        else:
            manifest_path = path
        if not manifest_path.is_file():
            raise FileNotFoundError(f"app.json not found at {manifest_path}")
        with open(manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        schema_version = data.get("schema_version")
        if schema_version != SUPPORTED_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported schema_version {schema_version!r} in {manifest_path}; "
                f"expected {SUPPORTED_SCHEMA_VERSION}"
            )
        app_id = data.get("app_id", "")
        if not isinstance(app_id, str) or not APP_ID_REGEX.match(app_id):
            raise ValueError(f"invalid app_id {app_id!r} in {manifest_path}")
        # Root is the parent of .loki/
        root = manifest_path.parent.parent
        declared = data.get("members", []) or []
        members: List[Path] = []
        if isinstance(declared, list):
            for name in declared:
                if not isinstance(name, str):
                    continue
                candidate = root / name
                if candidate.is_dir():
                    members.append(candidate.resolve())
        shared_raw = data.get("shared_memory_dir")
        shared_memory_dir = Path(shared_raw) if isinstance(shared_raw, str) else None
        return cls(
            app_id=app_id,
            root=root.resolve(),
            members=members,
            shared_memory_dir=shared_memory_dir,
        )
