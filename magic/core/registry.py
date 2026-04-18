"""Component registry for Magic Modules.

Tracks every generated component with: name, version (semver), spec hash,
file paths, tags, creation/update timestamps, debate results, deprecation.

Storage: JSON at .loki/magic/registry.json (atomic writes via tmp + rename).
Standard library only.
"""

import json
import re
import time
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional

SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")


def _utcnow() -> str:
    """Return current UTC timestamp in ISO 8601 format."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@dataclass
class ComponentEntry:
    name: str
    version: str = "1.0.0"
    spec_path: str = ""
    react_path: str = ""
    webcomponent_path: str = ""
    test_path: str = ""
    spec_hash: str = ""
    created_at: str = ""
    updated_at: str = ""
    tags: list = field(default_factory=list)
    description: str = ""
    targets: list = field(default_factory=lambda: ["react"])
    debate_passed: bool = False
    debate_result: dict = field(default_factory=dict)
    deprecated: bool = False
    replaces: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> "ComponentEntry":
        """Construct from a dict, ignoring unknown keys."""
        known = {f for f in cls.__dataclass_fields__}
        filtered = {k: v for k, v in data.items() if k in known}
        return cls(**filtered)


class ComponentRegistry:
    def __init__(self, project_dir: str = "."):
        self.project_dir = Path(project_dir)
        self.registry_path = self.project_dir / ".loki" / "magic" / "registry.json"
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------
    def load(self) -> dict:
        """Load registry from disk, return empty structure if missing."""
        if not self.registry_path.exists():
            return {"version": "1", "updated_at": "", "components": []}
        try:
            data = json.loads(self.registry_path.read_text())
        except (json.JSONDecodeError, OSError):
            # Back up corrupted registry and start fresh
            try:
                backup = self.registry_path.with_suffix(".json.corrupt")
                self.registry_path.rename(backup)
            except OSError:
                pass
            return {"version": "1", "updated_at": "", "components": []}

        # Ensure required fields exist
        if not isinstance(data, dict):
            return {"version": "1", "updated_at": "", "components": []}
        data.setdefault("version", "1")
        data.setdefault("updated_at", "")
        data.setdefault("components", [])
        if not isinstance(data["components"], list):
            data["components"] = []
        return data

    def save(self, data: dict) -> None:
        """Atomic write via temp + rename."""
        data["updated_at"] = _utcnow()
        tmp = self.registry_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=False))
        tmp.replace(self.registry_path)

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------
    def register(self, entry: ComponentEntry) -> ComponentEntry:
        """Add or update a component entry.

        If name exists, bump version (patch) when version matches existing.
        Validates name format and semver.
        """
        if not NAME_RE.match(entry.name):
            raise ValueError(f"Invalid component name: {entry.name}")
        if not SEMVER_RE.match(entry.version):
            raise ValueError(f"Invalid semver: {entry.version}")

        now = _utcnow()
        data = self.load()
        existing_idx = next(
            (i for i, c in enumerate(data["components"]) if c.get("name") == entry.name),
            None,
        )

        if existing_idx is not None:
            existing = data["components"][existing_idx]
            entry.created_at = existing.get("created_at") or now
            entry.updated_at = now
            # Auto-bump patch if same version as existing
            if entry.version == existing.get("version"):
                entry.version = self._bump_patch(existing.get("version", "1.0.0"))
            data["components"][existing_idx] = asdict(entry)
        else:
            entry.created_at = entry.created_at or now
            entry.updated_at = now
            data["components"].append(asdict(entry))

        self.save(data)
        return entry

    def get(self, name: str) -> Optional[ComponentEntry]:
        """Fetch component by name. Returns None if not found."""
        data = self.load()
        for c in data["components"]:
            if c.get("name") == name:
                return ComponentEntry.from_dict(c)
        return None

    def remove(self, name: str) -> bool:
        """Remove component entry (does not delete files). Returns True if removed."""
        data = self.load()
        original_count = len(data["components"])
        data["components"] = [c for c in data["components"] if c.get("name") != name]
        if len(data["components"]) == original_count:
            return False
        self.save(data)
        return True

    def search(
        self,
        query: str = "",
        tags: list = None,
        target: str = None,
    ) -> list:
        """Search by name/description substring, tags, or target framework.

        - query: case-insensitive substring against name and description.
        - tags: all tags must be present on the component.
        - target: match when target appears in component's targets list (or
          component targets includes "both").
        """
        data = self.load()
        results = []
        q = (query or "").lower().strip()
        tag_set = set(tags or [])

        for c in data["components"]:
            name = c.get("name", "")
            description = c.get("description", "")
            ctags = set(c.get("tags") or [])
            ctargets = c.get("targets") or []

            if q and q not in name.lower() and q not in description.lower():
                continue
            if tag_set and not tag_set.issubset(ctags):
                continue
            if target:
                if target not in ctargets and "both" not in ctargets:
                    continue
            results.append(ComponentEntry.from_dict(c))
        return results

    def list_all(self, include_deprecated: bool = False) -> list:
        """List all components. Excludes deprecated by default."""
        data = self.load()
        results = []
        for c in data["components"]:
            if not include_deprecated and c.get("deprecated"):
                continue
            results.append(ComponentEntry.from_dict(c))
        return results

    def deprecate(self, name: str, replaces: str = "") -> bool:
        """Mark component as deprecated. `replaces` points to newer component."""
        data = self.load()
        for c in data["components"]:
            if c.get("name") == name:
                c["deprecated"] = True
                if replaces:
                    c["replaces"] = replaces
                c["updated_at"] = _utcnow()
                self.save(data)
                return True
        return False

    # ------------------------------------------------------------------
    # Stats & maintenance
    # ------------------------------------------------------------------
    def stats(self) -> dict:
        """Return registry stats: count, per-target counts, avg debate score, etc."""
        data = self.load()
        components = data["components"]
        total = len(components)
        deprecated = sum(1 for c in components if c.get("deprecated"))
        active = total - deprecated

        target_counts = {"react": 0, "webcomponent": 0, "both": 0}
        for c in components:
            for t in c.get("targets") or []:
                if t in target_counts:
                    target_counts[t] += 1

        debate_passed = sum(1 for c in components if c.get("debate_passed"))
        scores = []
        for c in components:
            res = c.get("debate_result") or {}
            score = res.get("score")
            if isinstance(score, (int, float)):
                scores.append(float(score))
        avg_debate_score = sum(scores) / len(scores) if scores else 0.0

        tag_counts: dict = {}
        for c in components:
            for t in c.get("tags") or []:
                tag_counts[t] = tag_counts.get(t, 0) + 1

        return {
            "total": total,
            "active": active,
            "deprecated": deprecated,
            "targets": target_counts,
            "debate_passed": debate_passed,
            "avg_debate_score": avg_debate_score,
            "tags": tag_counts,
            "updated_at": data.get("updated_at", ""),
        }

    def prune(self, days_unused: int = 90) -> int:
        """Remove deprecated entries whose updated_at is older than N days.

        Returns the number of entries removed.
        """
        if days_unused < 0:
            return 0
        data = self.load()
        cutoff = time.time() - (days_unused * 86400)
        kept = []
        removed = 0
        for c in data["components"]:
            if c.get("deprecated"):
                ts = self._parse_ts(c.get("updated_at", ""))
                if ts is not None and ts < cutoff:
                    removed += 1
                    continue
            kept.append(c)
        if removed:
            data["components"] = kept
            self.save(data)
        return removed

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _bump_patch(version: str) -> str:
        """1.2.3 -> 1.2.4"""
        m = SEMVER_RE.match(version or "")
        if not m:
            return "1.0.0"
        major, minor, patch = m.groups()
        return f"{major}.{minor}.{int(patch) + 1}"

    @staticmethod
    def _parse_ts(value: str) -> Optional[float]:
        """Parse an ISO 8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ) to epoch seconds."""
        if not value:
            return None
        try:
            t = time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
            return time.mktime(t) - time.timezone
        except (ValueError, TypeError):
            return None


# ---------------------------------------------------------------------------
# Module-level convenience API (called by autonomy/loki cmd_magic)
# ---------------------------------------------------------------------------

def register_component(
    registry_path: str = ".loki/magic/registry.json",
    name: str = "",
    spec_path: str = "",
    target: str = "react",
    react_path: str = "",
    webcomponent_path: str = "",
    test_path: str = "",
    spec_hash: str = "",
    description: str = "",
    tags=None,
    placement=None,
    **extra,
) -> dict:
    """Register or update a component entry. Returns the stored entry as dict."""
    tags = list(tags) if tags else []
    if placement:
        tags.append(f"placement:{placement}")
    from pathlib import Path as _P
    project_dir = str(_P(registry_path).parent.parent.parent)
    reg = ComponentRegistry(project_dir)
    entry = ComponentEntry(
        name=name,
        spec_path=spec_path,
        react_path=react_path,
        webcomponent_path=webcomponent_path,
        test_path=test_path,
        spec_hash=spec_hash,
        description=description,
        tags=tags,
        targets=[target] if target != "both" else ["react", "webcomponent"],
    )
    stored = reg.register(entry)
    from dataclasses import asdict as _asdict
    return _asdict(stored)


def prune_registry(registry_path: str = ".loki/magic/registry.json", days_unused: int = 90) -> int:
    """Remove deprecated entries older than N days. Returns count removed."""
    from pathlib import Path as _P
    project_dir = str(_P(registry_path).parent.parent.parent)
    return ComponentRegistry(project_dir).prune(days_unused)
