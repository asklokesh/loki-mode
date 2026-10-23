"""
Loki Managed Agents Memory - FakeManagedClient for CI tests (v6.83.0 Phase 1).

Implements the same surface as ManagedClient but keeps state in memory and
returns deterministic responses keyed on input path. Used by
tests/managed_memory/test_*_mock.py so CI does not call the real API.

This file is importable without the `anthropic` SDK installed.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, List, Optional


class _Conflict(Exception):
    """Simulated 409: existing path on create, or stale sha on update."""

    status_code = 409


class FakeManagedClient:
    """In-memory fake matching ManagedClient's public interface."""

    def __init__(self) -> None:
        self.stores: Dict[str, Dict[str, Any]] = {}
        # memories keyed by (store_id, path) -> dict(content, sha, version)
        self.memories: Dict[tuple, Dict[str, Any]] = {}
        self.calls: List[Dict[str, Any]] = []

    # ---------- stores --------------------------------------------------

    def stores_list(self) -> List[Dict[str, Any]]:
        self.calls.append({"op": "stores_list"})
        return list(self.stores.values())

    def stores_get_or_create(
        self, name: str, description: str = "", scope: str = "project"
    ) -> Dict[str, Any]:
        self.calls.append({"op": "stores_get_or_create", "name": name})
        for s in self.stores.values():
            if s.get("name") == name:
                return s
        store_id = f"store_{len(self.stores) + 1:04d}"
        store = {
            "id": store_id,
            "name": name,
            "description": description,
            "scope": scope,
        }
        self.stores[store_id] = store
        return store

    # ---------- memories ------------------------------------------------

    def memory_create(
        self,
        store_id: str,
        path: str,
        content: str,
        sha256_precondition: Optional[str] = None,
    ) -> Dict[str, Any]:
        self.calls.append(
            {
                "op": "memory_create",
                "store_id": store_id,
                "path": path,
                "sha256_precondition": sha256_precondition,
            }
        )
        # SDK 2.x semantics: paths are unique per store and absolute, and
        # create() has no precondition, so an existing path is a 409.
        key = (store_id, path)
        if not path.startswith("/"):
            raise ValueError(f"memory path must start with '/': {path}")
        if key in self.memories:
            raise _Conflict(f"path already exists: {path}")
        sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
        entry = {
            "id": f"mem_{abs(hash(key)) % 10**8:08d}",
            "type": "memory",
            "store_id": store_id,
            "path": path,
            "content": content,
            "sha": sha,
            "content_sha256": sha,
            "version": 1,
        }
        self.memories[key] = entry
        return entry

    def memory_update(
        self,
        store_id: str,
        memory_id: str,
        content: str,
        sha256_precondition: str,
    ) -> Dict[str, Any]:
        self.calls.append(
            {
                "op": "memory_update",
                "store_id": store_id,
                "memory_id": memory_id,
                "sha256_precondition": sha256_precondition,
            }
        )
        for key, entry in self.memories.items():
            if key[0] == store_id and entry["id"] == memory_id:
                if entry["sha"] != sha256_precondition:
                    raise _Conflict(
                        f"content_sha256 mismatch for {entry['path']}: "
                        f"have={entry['sha']}, want={sha256_precondition}"
                    )
                sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
                entry.update(
                    content=content,
                    sha=sha,
                    content_sha256=sha,
                    version=entry["version"] + 1,
                )
                return entry
        raise KeyError(memory_id)

    def memory_read(self, store_id: str, memory_id: str) -> Dict[str, Any]:
        self.calls.append({"op": "memory_read", "memory_id": memory_id})
        for entry in self.memories.values():
            if entry.get("id") == memory_id:
                return entry
        raise KeyError(memory_id)

    def memories_list(
        self, store_id: str, path_prefix: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        self.calls.append(
            {"op": "memories_list", "store_id": store_id, "path_prefix": path_prefix}
        )
        out = []
        for (sid, path), entry in self.memories.items():
            if sid != store_id:
                continue
            if path_prefix and not path.startswith(path_prefix):
                continue
            out.append(entry)
        return out


# Helper exported for tests that need to simulate the 409 without
# importing the private _Conflict class directly.
def make_conflict_error() -> Exception:
    return _Conflict("forced conflict for tests")
