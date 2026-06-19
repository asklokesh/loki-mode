"""
LokiStore: pluggable, local-first storage abstraction for Loki Mode.

This package is the consolidation spine for durable artifacts (state,
checkpoints, memory blobs, healing artifacts, etc.). Features should bind to
this abstraction instead of hardcoding `.loki/` paths or embedding their own
cloud SDK clients.

Design goals
------------
- Local-first by default. With nothing configured, LocalStore writes to the
  project `.loki/` directory with byte-identical behavior to today's direct
  file writes (atomic temp+rename, fcntl advisory locking, path-traversal
  guard). Zero new dependencies, zero behavior change for local users.
- Optional cloud backends (S3, GCS, Azure Blob) behind lazy imports. The
  cloud SDK is imported ONLY inside the backend's __init__, so a missing
  dependency raises a clear, actionable error ONLY when that backend is
  explicitly selected -- never at import time, never for local users.
- One interface (put/get/get_to/exists/list/delete) so callers are backend
  agnostic.

Quick start
-----------
    from lokistore import get_store

    store = get_store()  # local by default, honors LOKI_DIR/TARGET_DIR
    store.put("state/checkpoints/cp-1/metadata.json", b"{...}")
    data = store.get("state/checkpoints/cp-1/metadata.json")
    for key in store.list("state/checkpoints/"):
        ...

Configuration (env or config dict)
----------------------------------
- LOKI_STORAGE_BACKEND : local | s3 | gcs | azure-blob   (default: local)
- LOKI_STORAGE_BUCKET  : bucket / container name          (cloud backends)
- LOKI_STORAGE_PREFIX  : key prefix within the bucket      (optional)
- LOKI_STORAGE_REGION  : region                            (s3, optional)

The metadata backend (sqlite default, postgres later) is selected separately;
see get_metadata_backend() / METADATA notes below. For this release the blob
backends are the core deliverable and the metadata selector is a thin,
documented stub that defaults to the existing sqlite path.
"""

from .base import LokiStore, StoreError, BackendNotAvailableError
from .local import LocalStore
from .factory import (
    get_store,
    build_store,
    get_metadata_backend,
    resolve_local_base,
)

__all__ = [
    "LokiStore",
    "StoreError",
    "BackendNotAvailableError",
    "LocalStore",
    "get_store",
    "build_store",
    "get_metadata_backend",
    "resolve_local_base",
]

__version__ = "1.0.0"
