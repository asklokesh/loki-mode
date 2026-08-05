#!/usr/bin/env python3
"""Deterministic digest of the source tree verified by a Loki proof."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path
from typing import Any


MANIFEST_VERSION = 3
_EXCLUDED_TOP_LEVEL = {".git", ".loki"}
_EXCLUDED_TOP_LEVEL_GENERATED = {".next", ".nuxt", "target"}
_EXCLUDED_WALK_DIRS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "node_modules",
    "venv",
}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git_paths(root: Path) -> list[str] | None:
    """Return tracked paths, or None when root is not the repository root."""
    try:
        inside = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            timeout=10,
        )
        if inside.returncode != 0 or inside.stdout.strip() != b"true":
            return None
        top = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
            capture_output=True,
            timeout=10,
        )
        if top.returncode != 0:
            return None
        top_path = Path(os.fsdecode(top.stdout.rstrip(b"\n"))).resolve()
        if top_path != root.resolve():
            return None
        result = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "ls-files",
                "-z",
                "--cached",
            ],
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return [
        raw.decode("utf-8", errors="surrogateescape")
        for raw in result.stdout.split(b"\0")
        if raw
    ]


def _filesystem_paths(root: Path, gitlinks: set[str]) -> list[str]:
    """Enumerate nondependency worktree bytes without consulting Git ignores."""
    paths: list[str] = []

    def visit(directory: Path, prefix: str) -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda item: item.name)
        except OSError:
            return
        for entry in entries:
            relative = f"{prefix}/{entry.name}" if prefix else entry.name
            normalized = relative.replace(os.sep, "/")
            if not prefix and entry.name in (
                _EXCLUDED_TOP_LEVEL | _EXCLUDED_TOP_LEVEL_GENERATED
            ):
                continue
            if normalized in gitlinks:
                paths.append(relative)
                continue
            try:
                is_directory = entry.is_dir(follow_symlinks=False)
            except OSError:
                paths.append(relative)
                continue
            if is_directory:
                if entry.name in _EXCLUDED_WALK_DIRS:
                    continue
                visit(Path(entry.path), relative)
            else:
                paths.append(relative)

    visit(root, "")
    return paths


def _gitlinks(root: Path) -> dict[str, list[dict[str, str]]]:
    """Return staged gitlink identities keyed by their repository path."""
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--stage", "-z"],
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    links: dict[str, list[dict[str, str]]] = {}
    for record in result.stdout.split(b"\0"):
        if not record or b"\t" not in record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        fields = metadata.split()
        if len(fields) != 3 or fields[0] != b"160000":
            continue
        relative = raw_path.decode("utf-8", errors="surrogateescape")
        links.setdefault(relative, []).append(
            {
                "stage": fields[2].decode("ascii", errors="replace"),
                "oid": fields[1].decode("ascii", errors="replace"),
            }
        )
    for values in links.values():
        values.sort(key=lambda item: (item["stage"], item["oid"]))
    return links


def _gitlink_entry(
    root: Path, relative: str, index_entries: list[dict[str, str]]
) -> dict[str, Any]:
    """Bind both the staged gitlink and the checked-out submodule contents."""
    normalized = relative.replace(os.sep, "/")
    path = root / relative
    head_oid = ""
    try:
        head = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--verify", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if head.returncode == 0:
            head_oid = (head.stdout or "").strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return {
        "path": normalized,
        "kind": "gitlink",
        "index": index_entries,
        "head_oid": head_oid,
        "worktree_sha256": compute_tree_digest(path),
    }


def _entry(
    root: Path,
    relative: str,
    gitlink_entries: list[dict[str, str]] | None = None,
) -> dict[str, Any] | None:
    normalized = relative.replace(os.sep, "/")
    top = normalized.split("/", 1)[0]
    if top in _EXCLUDED_TOP_LEVEL:
        return None
    if gitlink_entries is not None:
        return _gitlink_entry(root, relative, gitlink_entries)

    path = root / relative
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {"path": normalized, "kind": "missing"}
    except OSError:
        return {"path": normalized, "kind": "unreadable"}

    executable = bool(info.st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
    if stat.S_ISLNK(info.st_mode):
        try:
            target = os.readlink(path)
        except OSError:
            target = ""
        target_bytes = os.fsencode(target)
        return {
            "path": normalized,
            "kind": "symlink",
            "executable": executable,
            "size": len(target_bytes),
            "sha256": hashlib.sha256(target_bytes).hexdigest(),
        }
    if stat.S_ISREG(info.st_mode):
        try:
            content_hash = _sha256_file(path)
        except OSError:
            return {"path": normalized, "kind": "unreadable"}
        return {
            "path": normalized,
            "kind": "file",
            "executable": executable,
            "size": info.st_size,
            "sha256": content_hash,
        }
    return {
        "path": normalized,
        "kind": "other",
        "executable": executable,
        "size": info.st_size,
    }


def build_manifest(root: str | os.PathLike[str]) -> dict[str, Any] | None:
    """Build the canonical Git worktree manifest used by proof binding."""
    resolved = Path(root).resolve()
    tracked_paths = _git_paths(resolved)
    if tracked_paths is None:
        return None
    gitlinks = _gitlinks(resolved)
    paths = set(tracked_paths)
    paths.update(_filesystem_paths(resolved, set(gitlinks)))
    entries = []
    for relative in sorted(paths):
        item = _entry(resolved, relative, gitlinks.get(relative))
        if item is not None:
            entries.append(item)
    return {
        "version": MANIFEST_VERSION,
        "filesystem_walk_excluded_top_level_directories": sorted(
            _EXCLUDED_TOP_LEVEL | _EXCLUDED_TOP_LEVEL_GENERATED
        ),
        "excluded_walk_directories": sorted(_EXCLUDED_WALK_DIRS),
        "entries": entries,
    }


def compute_tree_digest(root: str | os.PathLike[str]) -> str:
    """Return a SHA-256 digest, or an empty string when it cannot be derived."""
    manifest = build_manifest(root)
    if manifest is None:
        return ""
    encoded = json.dumps(
        manifest,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


__all__ = ["MANIFEST_VERSION", "build_manifest", "compute_tree_digest"]
