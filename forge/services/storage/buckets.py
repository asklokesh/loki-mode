"""Bucket CRUD + object upload/download backed by the local FS.

Each bucket has a manifest at <forge_dir>/storage/<bucket>/_manifest.json
describing public/private + size cap + content-type allowlist. Objects
are stored content-addressed (sha256-of-bytes -> 2-char shard ->
remaining hex). A separate object index records the user-visible path
-> hash mapping so re-uploads dedupe automatically.

Object index format (one record per visible path):
    <forge_dir>/storage/<bucket>/_index/<sha256(path)>.json
    {"path": "...", "sha": "...", "size": N, "ctype": "...",
     "uploaded_at": "ISO"}
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shutil
import time
from typing import Any, Dict, List, Optional, Tuple


class BucketError(Exception):
    pass


# Matches S3-style bucket naming: 3-63 chars, lowercase alnum and hyphens,
# must start and end with an alnum.
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
_DEFAULT_MAX_FILE = 50 * 1024 * 1024  # 50MB


def _bucket_root(forge_dir: str, name: str) -> str:
    return os.path.join(forge_dir, "storage", name)


def _validate_name(name: str) -> None:
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise BucketError(
            "bucket name must be lowercase alphanumeric + hyphen, "
            "1-63 chars, starting/ending with alnum"
        )


def _validate_object_path(path: str) -> None:
    """Refuse anything that could escape the bucket directory."""
    if not isinstance(path, str) or not path or path.startswith("/"):
        raise BucketError("object path must be relative and non-empty")
    if ".." in path.split("/"):
        raise BucketError("object path may not contain '..'")
    if any(ord(c) < 32 for c in path):
        raise BucketError("object path contains control characters")
    if len(path) > 1024:
        raise BucketError("object path too long")


def create_bucket(forge_dir: str, name: str, *, public: bool = False,
                  max_file_size: int = _DEFAULT_MAX_FILE,
                  allowed_content_types: Optional[List[str]] = None,
                  ) -> Dict[str, Any]:
    _validate_name(name)
    root = _bucket_root(forge_dir, name)
    if os.path.isdir(root):
        raise BucketError(f"bucket exists: {name}")
    os.makedirs(os.path.join(root, "_index"), exist_ok=True)
    os.makedirs(os.path.join(root, "blobs"), exist_ok=True)
    manifest = {
        "name": name,
        "public": bool(public),
        "max_file_size": int(max_file_size),
        "allowed_content_types": list(allowed_content_types or []),
        "created_at": _utc_iso(),
    }
    _write_json(os.path.join(root, "_manifest.json"), manifest)
    return manifest


def delete_bucket(forge_dir: str, name: str) -> bool:
    _validate_name(name)
    root = _bucket_root(forge_dir, name)
    if not os.path.isdir(root):
        return False
    shutil.rmtree(root)
    return True


def list_buckets(forge_dir: str) -> List[Dict[str, Any]]:
    sroot = os.path.join(forge_dir, "storage")
    if not os.path.isdir(sroot):
        return []
    out = []
    for entry in sorted(os.listdir(sroot)):
        mpath = os.path.join(sroot, entry, "_manifest.json")
        if not os.path.isfile(mpath):
            continue
        try:
            with open(mpath, "r", encoding="utf-8") as f:
                out.append(json.load(f))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def upload(forge_dir: str, bucket: str, path: str, content: bytes,
           content_type: Optional[str] = None) -> Dict[str, Any]:
    """Upload bytes to <bucket>/<path>. Returns the manifest entry."""
    _validate_name(bucket)
    _validate_object_path(path)
    if not isinstance(content, (bytes, bytearray)):
        raise BucketError("content must be bytes")
    root = _bucket_root(forge_dir, bucket)
    manifest_path = os.path.join(root, "_manifest.json")
    if not os.path.exists(manifest_path):
        raise BucketError(f"bucket not found: {bucket}")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    if len(content) > int(manifest.get("max_file_size", _DEFAULT_MAX_FILE)):
        raise BucketError("file exceeds bucket max_file_size")

    ctype = content_type
    if not ctype:
        ctype, _ = mimetypes.guess_type(path)
        ctype = ctype or "application/octet-stream"
    allowed = manifest.get("allowed_content_types") or []
    if allowed and ctype not in allowed:
        raise BucketError(f"content-type {ctype!r} not in allowlist")

    sha = hashlib.sha256(bytes(content)).hexdigest()
    shard = sha[:2]
    blob_dir = os.path.join(root, "blobs", shard)
    os.makedirs(blob_dir, exist_ok=True)
    blob_path = os.path.join(blob_dir, sha[2:])
    if not os.path.exists(blob_path):
        tmp = blob_path + ".tmp"
        with open(tmp, "wb") as bf:
            bf.write(bytes(content))
        os.replace(tmp, blob_path)

    entry = {
        "path": path,
        "sha": sha,
        "size": len(content),
        "ctype": ctype,
        "uploaded_at": _utc_iso(),
    }
    idx_path = os.path.join(
        root, "_index",
        hashlib.sha256(path.encode("utf-8")).hexdigest() + ".json",
    )
    _write_json(idx_path, entry)
    return entry


def download(forge_dir: str, bucket: str, path: str) -> Tuple[bytes, Dict[str, Any]]:
    """Fetch object bytes + metadata. Raises BucketError if missing."""
    _validate_name(bucket)
    _validate_object_path(path)
    root = _bucket_root(forge_dir, bucket)
    idx_path = os.path.join(
        root, "_index",
        hashlib.sha256(path.encode("utf-8")).hexdigest() + ".json",
    )
    if not os.path.exists(idx_path):
        raise BucketError(f"object not found: {bucket}/{path}")
    with open(idx_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    blob_path = os.path.join(root, "blobs", meta["sha"][:2], meta["sha"][2:])
    if not os.path.exists(blob_path):
        raise BucketError(f"blob missing for {bucket}/{path}")
    with open(blob_path, "rb") as bf:
        return bf.read(), meta


def list_objects(forge_dir: str, bucket: str, prefix: str = "",
                 limit: int = 1000) -> List[Dict[str, Any]]:
    _validate_name(bucket)
    root = _bucket_root(forge_dir, bucket)
    idx_dir = os.path.join(root, "_index")
    if not os.path.isdir(idx_dir):
        return []
    out: List[Dict[str, Any]] = []
    cap = max(1, min(int(limit), 10000))
    for entry in os.listdir(idx_dir):
        if not entry.endswith(".json"):
            continue
        with open(os.path.join(idx_dir, entry), "r", encoding="utf-8") as f:
            try:
                rec = json.load(f)
            except json.JSONDecodeError:
                continue
        if prefix and not rec.get("path", "").startswith(prefix):
            continue
        out.append(rec)
        if len(out) >= cap:
            break
    out.sort(key=lambda r: r.get("uploaded_at", ""))
    return out


# ---- helpers --------------------------------------------------------------


def _write_json(path: str, data: Any) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def _utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
