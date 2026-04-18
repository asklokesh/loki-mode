"""Snapshot utilities for Magic components.

Stores snapshots at ``.loki/magic/snapshots/<component>/<variant>.html``
alongside a matching ``<variant>.meta.json`` that records the content
hash and metadata. Used for regression detection: if a snapshot changes
unexpectedly, the debate system can flag it.
"""

import difflib
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


class SnapshotManager:
    """Manage on-disk HTML snapshots for Magic components."""

    def __init__(self, project_dir: str = "."):
        self.project_dir = Path(project_dir)
        self.snapshots_dir = self.project_dir / ".loki" / "magic" / "snapshots"
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)

    # ----- Public API --------------------------------------------------

    def save(
        self, component_name: str, variant: str, content: str
    ) -> Path:
        """Save a rendered snapshot and its metadata.

        Returns the path to the saved HTML file.
        """
        safe_component = self._safe(component_name)
        safe_variant = self._safe(variant or "default")

        comp_dir = self.snapshots_dir / safe_component
        comp_dir.mkdir(parents=True, exist_ok=True)

        html_path = comp_dir / f"{safe_variant}.html"
        meta_path = comp_dir / f"{safe_variant}.meta.json"

        html_path.write_text(content, encoding="utf-8")
        metadata = {
            "component": component_name,
            "variant": variant or "default",
            "hash": self.content_hash(content),
            "bytes": len(content.encode("utf-8")),
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }
        meta_path.write_text(
            json.dumps(metadata, indent=2, sort_keys=True), encoding="utf-8"
        )
        return html_path

    def load(
        self, component_name: str, variant: str = "default"
    ) -> Optional[str]:
        """Load a stored snapshot. Returns None if missing."""
        safe_component = self._safe(component_name)
        safe_variant = self._safe(variant or "default")
        path = self.snapshots_dir / safe_component / f"{safe_variant}.html"
        if not path.exists():
            return None
        try:
            return path.read_text(encoding="utf-8")
        except OSError:
            return None

    def load_metadata(
        self, component_name: str, variant: str = "default"
    ) -> Optional[dict]:
        """Load the metadata sidecar for a snapshot, if present."""
        safe_component = self._safe(component_name)
        safe_variant = self._safe(variant or "default")
        path = self.snapshots_dir / safe_component / f"{safe_variant}.meta.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def list_variants(self, component_name: str) -> list:
        """Return the sorted list of variant names for a component."""
        safe_component = self._safe(component_name)
        comp_dir = self.snapshots_dir / safe_component
        if not comp_dir.is_dir():
            return []
        variants = sorted(
            p.stem for p in comp_dir.glob("*.html") if p.is_file()
        )
        return variants

    def list_components(self) -> list:
        """Return the sorted list of components with any snapshot."""
        if not self.snapshots_dir.is_dir():
            return []
        return sorted(
            p.name for p in self.snapshots_dir.iterdir() if p.is_dir()
        )

    def diff(
        self, component_name: str, variant: str, new_content: str
    ) -> dict:
        """Compare new content against stored snapshot.

        Returns a summary dict with:
        - ``status``: ``"missing"``, ``"match"``, or ``"changed"``
        - ``old_hash`` / ``new_hash``: SHA-256 hashes (old may be None)
        - ``added`` / ``removed``: line counts
        - ``diff``: unified diff (first 200 lines) when changed
        """
        new_hash = self.content_hash(new_content)
        existing = self.load(component_name, variant)
        if existing is None:
            return {
                "status": "missing",
                "component": component_name,
                "variant": variant,
                "old_hash": None,
                "new_hash": new_hash,
                "added": len(new_content.splitlines()),
                "removed": 0,
                "diff": "",
            }
        old_hash = self.content_hash(existing)
        if old_hash == new_hash:
            return {
                "status": "match",
                "component": component_name,
                "variant": variant,
                "old_hash": old_hash,
                "new_hash": new_hash,
                "added": 0,
                "removed": 0,
                "diff": "",
            }
        old_lines = existing.splitlines(keepends=True)
        new_lines = new_content.splitlines(keepends=True)
        udiff_iter = difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile=f"{component_name}/{variant}.old",
            tofile=f"{component_name}/{variant}.new",
            n=3,
        )
        udiff_lines = list(udiff_iter)
        added = sum(
            1
            for ln in udiff_lines
            if ln.startswith("+") and not ln.startswith("+++")
        )
        removed = sum(
            1
            for ln in udiff_lines
            if ln.startswith("-") and not ln.startswith("---")
        )
        trimmed = "".join(udiff_lines[:200])
        return {
            "status": "changed",
            "component": component_name,
            "variant": variant,
            "old_hash": old_hash,
            "new_hash": new_hash,
            "added": added,
            "removed": removed,
            "diff": trimmed,
        }

    def delete(
        self, component_name: str, variant: Optional[str] = None
    ) -> int:
        """Delete a single variant or all variants of a component.

        Returns the number of files removed.
        """
        safe_component = self._safe(component_name)
        comp_dir = self.snapshots_dir / safe_component
        if not comp_dir.is_dir():
            return 0

        removed = 0
        if variant is None:
            for entry in comp_dir.iterdir():
                if entry.is_file():
                    try:
                        entry.unlink()
                        removed += 1
                    except OSError:
                        pass
            try:
                comp_dir.rmdir()
            except OSError:
                pass
            return removed

        safe_variant = self._safe(variant)
        for suffix in (".html", ".meta.json"):
            path = comp_dir / f"{safe_variant}{suffix}"
            if path.exists():
                try:
                    path.unlink()
                    removed += 1
                except OSError:
                    pass
        return removed

    # ----- Hashing -----------------------------------------------------

    def content_hash(self, content: str) -> str:
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    # ----- Internals ---------------------------------------------------

    @staticmethod
    def _safe(name: str) -> str:
        """Sanitize a path fragment to avoid traversal and odd chars."""
        cleaned = re.sub(r"[^\w.-]+", "-", (name or "").strip())
        cleaned = cleaned.strip("-.") or "unnamed"
        if cleaned in {"..", "."}:
            cleaned = "unnamed"
        return cleaned[:100]
