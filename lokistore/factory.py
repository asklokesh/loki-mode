"""
LokiStore factory: select and construct a backend from config or env.

Defaults to local. With nothing configured, get_store() returns a LocalStore
rooted at the project `.loki/` directory, honoring LOKI_DIR / TARGET_DIR
exactly like the rest of the codebase. Cloud backends are constructed only when
explicitly selected, and only then is their SDK imported.

Config precedence: an explicit config dict overrides env, env overrides the
local default. Recognized config keys mirror the env vars (without the
LOKI_STORAGE_ prefix): backend, bucket, prefix, region, base_dir.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from .base import LokiStore, StoreError
from .local import LocalStore


def resolve_local_base(explicit_base: Optional[str] = None) -> str:
    """
    Resolve the local `.loki/` base directory exactly like run.sh and the
    dashboard do.

    Resolution order, matching autonomy/run.sh
    (`${LOKI_DIR:-${TARGET_DIR:-.}/.loki}`):
      1. explicit_base argument, if given
      2. $LOKI_DIR, if set (used verbatim, like the shell)
      3. $TARGET_DIR/.loki, if TARGET_DIR is set
      4. ./.loki  (current working directory)

    Returns:
        The resolved base directory as a string path. It is NOT created here;
        LocalStore creates parents lazily on first write.
    """
    if explicit_base:
        return explicit_base
    loki_dir = os.environ.get("LOKI_DIR")
    if loki_dir:
        return loki_dir
    target_dir = os.environ.get("TARGET_DIR", ".")
    return os.path.join(target_dir, ".loki")


def _config_from_env() -> Dict[str, Any]:
    """Read the LOKI_STORAGE_* env vars into a config dict (omitting unset)."""
    cfg: Dict[str, Any] = {}
    backend = os.environ.get("LOKI_STORAGE_BACKEND")
    if backend:
        cfg["backend"] = backend
    bucket = os.environ.get("LOKI_STORAGE_BUCKET")
    if bucket:
        cfg["bucket"] = bucket
    prefix = os.environ.get("LOKI_STORAGE_PREFIX")
    if prefix:
        cfg["prefix"] = prefix
    region = os.environ.get("LOKI_STORAGE_REGION")
    if region:
        cfg["region"] = region
    endpoint = os.environ.get("LOKI_STORAGE_ENDPOINT")
    if endpoint:
        cfg["endpoint"] = endpoint
    return cfg


def build_store(config: Optional[Dict[str, Any]] = None) -> LokiStore:
    """
    Construct a LokiStore from an explicit config dict (no env fallback).

    Use this when a caller has already assembled config from its own source.
    Prefer get_store() for the standard env-aware path.

    Recognized keys:
      backend : "local" (default) | "s3" | "gcs" | "azure-blob"
      bucket  : bucket/container name (cloud backends)
      prefix  : key prefix within the bucket (optional)
      region  : region (s3, optional)
      endpoint: custom S3-compatible endpoint URL (s3 only; e.g. MinIO/Ceph/R2)
      base_dir: local base directory (local backend only; overrides resolution)
    """
    config = dict(config or {})
    backend = (config.get("backend") or "local").strip().lower()

    if backend in ("local", "", "file", "filesystem"):
        return LocalStore(resolve_local_base(config.get("base_dir")))

    bucket = config.get("bucket")
    prefix = config.get("prefix")
    region = config.get("region")
    endpoint = config.get("endpoint")

    if backend in ("s3", "aws", "aws-s3"):
        from .cloud import S3Store

        return S3Store(bucket=bucket, prefix=prefix, region=region, endpoint=endpoint)

    if backend in ("gcs", "gcp", "google", "google-cloud-storage"):
        from .cloud import GCSStore

        return GCSStore(bucket=bucket, prefix=prefix, region=region)

    if backend in ("azure-blob", "azure", "azureblob", "azure_blob"):
        from .cloud import AzureBlobStore

        return AzureBlobStore(bucket=bucket, prefix=prefix, region=region)

    raise StoreError(
        f"unknown storage backend: {backend!r} "
        "(expected one of: local, s3, gcs, azure-blob)"
    )


def get_store(config: Optional[Dict[str, Any]] = None) -> LokiStore:
    """
    Return a LokiStore, defaulting to local.

    Resolution:
      1. Start from the LOKI_STORAGE_* env vars.
      2. Overlay any explicit config dict (config keys win over env).
      3. If no backend is selected, default to local.

    With a clean environment and no config, this returns a LocalStore rooted at
    the project `.loki/` -- zero new deps, zero behavior change.
    """
    merged = _config_from_env()
    if config:
        merged.update({k: v for k, v in config.items() if v is not None})
    return build_store(merged)


# ---------------------------------------------------------------------------
# Metadata backend selector (stub for this release).
#
# Blobs (state, checkpoints, artifacts) go through LokiStore above. Structured
# metadata (the dashboard's task/run index) lives in a relational store. Today
# that is the existing async-SQLite database in dashboard/database.py at
# $LOKI_DATA_DIR/dashboard.db. A postgres backend can be added later for shared
# multi-instance fleets; the selector below is the seam for that, defaulting to
# sqlite so there is no behavior change now.
# ---------------------------------------------------------------------------

def get_metadata_backend(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Resolve the metadata (relational) backend selection.

    This is intentionally a thin, documented descriptor rather than a live
    connection: the existing dashboard/database.py owns the sqlite engine, and
    a postgres implementation is deferred. Returning a descriptor lets future
    callers branch on the choice without this module importing SQLAlchemy or
    any database driver.

    Selection (config["metadata_backend"] overrides
    $LOKI_METADATA_BACKEND; default "sqlite"):
      sqlite   -> reuse $LOKI_DATA_DIR/dashboard.db (default, implemented today
                  in dashboard/database.py)
      postgres -> read $LOKI_METADATA_URL (NOT YET IMPLEMENTED; selecting it
                  returns the descriptor with implemented=False so callers can
                  fail with a clear message until the impl lands)

    Returns:
        A descriptor dict: {backend, implemented, dsn, note}.
    """
    config = dict(config or {})
    backend = (
        config.get("metadata_backend")
        or os.environ.get("LOKI_METADATA_BACKEND")
        or "sqlite"
    ).strip().lower()

    if backend in ("sqlite", "", "default"):
        data_dir = os.environ.get("LOKI_DATA_DIR", os.path.expanduser("~/.loki"))
        return {
            "backend": "sqlite",
            "implemented": True,
            "dsn": os.path.join(data_dir, "dashboard.db"),
            "note": "reuses dashboard/database.py async-sqlite engine",
        }

    if backend in ("postgres", "postgresql", "pg"):
        return {
            "backend": "postgres",
            "implemented": False,
            "dsn": config.get("metadata_url") or os.environ.get("LOKI_METADATA_URL"),
            "note": "postgres metadata backend is planned, not yet implemented",
        }

    raise StoreError(
        f"unknown metadata backend: {backend!r} (expected: sqlite, postgres)"
    )
