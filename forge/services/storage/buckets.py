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


_ALLOWED_REGIONS = (
    "us-east-1", "us-east-2", "us-west-1", "us-west-2",
    "eu-west-1", "eu-west-2", "eu-central-1",
    "ap-south-1", "ap-northeast-1", "ap-southeast-1",
    "auto",  # let the deploy adapter pick
)


def create_bucket(forge_dir: str, name: str, *, public: bool = False,
                  max_file_size: int = _DEFAULT_MAX_FILE,
                  allowed_content_types: Optional[List[str]] = None,
                  region: str = "auto",
                  ) -> Dict[str, Any]:
    _validate_name(name)
    if region not in _ALLOWED_REGIONS:
        raise BucketError(f"unsupported region: {region!r}")
    # X-36: compliance preset enforcement at create-time.
    try:
        from forge.compliance import validate_storage
        errs = validate_storage(region=region, max_file_size=max_file_size)
        if errs:
            raise BucketError("; ".join(errs))
    except BucketError:
        raise
    except Exception:
        # compliance module unavailable - skip enforcement
        pass
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
        "region": region,
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


def set_lifecycle(forge_dir: str, name: str, *,
                  delete_after_days: Optional[int] = None,
                  ) -> Dict[str, Any]:
    """X-73: set a lifecycle policy on a bucket. delete_after_days = N
    will be honored by garbage_collect_lifecycle()."""
    _validate_name(name)
    root = _bucket_root(forge_dir, name)
    mpath = os.path.join(root, "_manifest.json")
    if not os.path.exists(mpath):
        raise BucketError(f"bucket not found: {name}")
    with open(mpath, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    if delete_after_days is not None:
        if not (1 <= int(delete_after_days) <= 365 * 10):
            raise BucketError("delete_after_days must be 1..3650")
        manifest["delete_after_days"] = int(delete_after_days)
    else:
        manifest.pop("delete_after_days", None)
    _write_json(mpath, manifest)
    return manifest


def garbage_collect_lifecycle(forge_dir: str, bucket: str,
                              *, now_ts: Optional[float] = None
                              ) -> Dict[str, Any]:
    """X-73: honor the bucket's delete_after_days policy. Returns count
    of object index records pruned. Blob files (content-addressed) are
    left in place since they may be referenced by other paths."""
    _validate_name(bucket)
    root = _bucket_root(forge_dir, bucket)
    mpath = os.path.join(root, "_manifest.json")
    if not os.path.exists(mpath):
        raise BucketError(f"bucket not found: {bucket}")
    with open(mpath, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    days = manifest.get("delete_after_days")
    if not days:
        return {"pruned": 0, "policy": "none"}
    import time as _time
    cutoff = (now_ts if now_ts is not None else _time.time()) - days * 86400
    idx_dir = os.path.join(root, "_index")
    pruned = 0
    if os.path.isdir(idx_dir):
        for f in list(os.listdir(idx_dir)):
            if not f.endswith(".json"):
                continue
            entry_path = os.path.join(idx_dir, f)
            try:
                with open(entry_path, "r", encoding="utf-8") as eh:
                    entry = json.load(eh)
            except (OSError, json.JSONDecodeError):
                continue
            uploaded = entry.get("uploaded_at", "")
            try:
                ts = (_time.mktime(_time.strptime(uploaded, "%Y-%m-%dT%H:%M:%SZ"))
                      if uploaded else 0)
            except ValueError:
                ts = 0
            if ts < cutoff:
                try:
                    os.remove(entry_path)
                    versions = entry_path[:-5] + ".versions.jsonl"
                    if os.path.exists(versions):
                        os.remove(versions)
                    pruned += 1
                except OSError:
                    pass
    return {"pruned": pruned, "policy": f"delete_after_{days}d"}


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
    # X-64: append the new entry to the per-path version log before
    # overwriting the head pointer. The version log is canonical; the
    # head .json is a convenience cache.
    versions_path = idx_path[:-5] + ".versions.jsonl"
    with open(versions_path, "a", encoding="utf-8") as vf:
        vf.write(json.dumps(entry, separators=(",", ":")) + "\n")
    _write_json(idx_path, entry)
    return entry


def download(forge_dir: str, bucket: str, path: str,
             version: Optional[int] = None) -> Tuple[bytes, Dict[str, Any]]:
    """Fetch object bytes + metadata. Raises BucketError if missing.

    X-64: version selector. None (default) returns the current head;
    positive integers walk back through the version history kept in
    a sidecar jsonl file.
    """
    _validate_name(bucket)
    _validate_object_path(path)
    root = _bucket_root(forge_dir, bucket)
    if version is not None:
        if version < 1:
            raise BucketError("version must be >= 1")
        versions_path = os.path.join(
            root, "_index",
            hashlib.sha256(path.encode("utf-8")).hexdigest() + ".versions.jsonl",
        )
        if not os.path.isfile(versions_path):
            raise BucketError(f"no version history for {bucket}/{path}")
        with open(versions_path, "r", encoding="utf-8") as f:
            lines = [l.strip() for l in f if l.strip()]
        if version > len(lines):
            raise BucketError(f"version {version} out of range "
                              f"(max {len(lines)})")
        meta = json.loads(lines[version - 1])
        blob_path = os.path.join(root, "blobs", meta["sha"][:2], meta["sha"][2:])
        if not os.path.exists(blob_path):
            raise BucketError(f"blob missing for {bucket}/{path} v{version}")
        with open(blob_path, "rb") as bf:
            return bf.read(), meta
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


def upload_stream(forge_dir: str, bucket: str, path: str,
                  chunks, content_type: Optional[str] = None,
                  expected_size: Optional[int] = None
                  ) -> Dict[str, Any]:
    """X-53: streaming upload variant of upload().

    `chunks` is an iterable of bytes (e.g. from a file iterator).
    We hash on-the-fly so we don't materialize the whole payload in
    memory. Caller MUST pass expected_size when bucket has
    max_file_size enforcement (otherwise we error after partial
    write and clean up the temp file).
    """
    _validate_name(bucket)
    _validate_object_path(path)
    root = _bucket_root(forge_dir, bucket)
    manifest_path = os.path.join(root, "_manifest.json")
    if not os.path.exists(manifest_path):
        raise BucketError(f"bucket not found: {bucket}")
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    cap = int(manifest.get("max_file_size", _DEFAULT_MAX_FILE))
    if expected_size is not None and expected_size > cap:
        raise BucketError("file exceeds bucket max_file_size")

    ctype = content_type
    if not ctype:
        ctype, _ = mimetypes.guess_type(path)
        ctype = ctype or "application/octet-stream"
    allowed = manifest.get("allowed_content_types") or []
    if allowed and ctype not in allowed:
        raise BucketError(f"content-type {ctype!r} not in allowlist")

    # Stage to a tmp file, hash on the fly, then content-address the
    # final destination so we keep the dedupe property.
    blobs_root = os.path.join(root, "blobs")
    os.makedirs(blobs_root, exist_ok=True)
    import hashlib as _hashlib
    import tempfile as _tempfile
    h = _hashlib.sha256()
    tmp_fd, tmp_name = _tempfile.mkstemp(dir=blobs_root, prefix=".stream-")
    total = 0
    try:
        with os.fdopen(tmp_fd, "wb") as out:
            for chunk in chunks:
                if not isinstance(chunk, (bytes, bytearray)):
                    raise BucketError("stream must yield bytes")
                if not chunk:
                    continue
                total += len(chunk)
                if total > cap:
                    raise BucketError(
                        f"stream exceeds bucket max_file_size ({cap} bytes)"
                    )
                h.update(chunk)
                out.write(chunk)
        sha = h.hexdigest()
        shard_dir = os.path.join(blobs_root, sha[:2])
        os.makedirs(shard_dir, exist_ok=True)
        blob_path = os.path.join(shard_dir, sha[2:])
        if os.path.exists(blob_path):
            # Already have an identical blob; drop the tmp file.
            os.remove(tmp_name)
        else:
            os.replace(tmp_name, blob_path)
    except Exception:
        try:
            os.remove(tmp_name)
        except OSError:
            pass
        raise

    entry = {
        "path": path,
        "sha": sha,
        "size": total,
        "ctype": ctype,
        "uploaded_at": _utc_iso(),
    }
    idx_path = os.path.join(
        root, "_index",
        hashlib.sha256(path.encode("utf-8")).hexdigest() + ".json",
    )
    _write_json(idx_path, entry)
    return entry


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
