"""Image-transform preset registry.

The actual rendering pipeline (sharp via Bun) lands with F-2.16 when the
functions runtime is online; for now we ship the *recipe registry* so
the agent can declare presets in its iteration N and reference them by
short name in URLs from iteration N+1.

Recipe schema:
    {
      "name": "avatar",
      "ops": [
        {"resize": {"w": 256, "h": 256, "fit": "cover"}},
        {"format": "webp"},
        {"quality": 85}
      ]
    }
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List


_PRESET_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")

_ALLOWED_OPS = {
    "resize": {"w": int, "h": int, "fit": str},
    "format": str,
    "quality": int,
    "rotate": int,
    "grayscale": bool,
    "blur": (int, float),
}

_FIT_ALLOWED = {"cover", "contain", "fill", "inside", "outside"}
_FORMAT_ALLOWED = {"webp", "avif", "jpeg", "jpg", "png"}


def _presets_path(forge_dir: str, bucket: str) -> str:
    return os.path.join(forge_dir, "storage", bucket, "_transforms.json")


def unrevoke_preset(forge_dir: str, bucket: str, name: str) -> bool:
    """N-67: remove `name`'s entries from .revoked.jsonl so it can be
    re-registered without force=True. Returns True when at least one
    audit line was dropped, False when no record matched. The action
    itself is logged on a sibling .unrevoked.jsonl so the trail stays
    bidirectional.
    """
    audit_path = os.path.join(os.path.dirname(_presets_path(forge_dir, bucket)),
                              ".revoked.jsonl")
    if not os.path.isfile(audit_path):
        return False
    kept: List[str] = []
    removed = 0
    try:
        with open(audit_path, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    rec = json.loads(stripped)
                except json.JSONDecodeError:
                    kept.append(line.rstrip("\n"))
                    continue
                if rec.get("name") == name:
                    removed += 1
                    continue
                kept.append(stripped)
    except OSError:
        return False
    if not removed:
        return False
    tmp = audit_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for ln in kept:
            f.write(ln + "\n")
    os.replace(tmp, audit_path)
    # Log the unrevoke action.
    unrevoked_path = os.path.join(os.path.dirname(audit_path),
                                  ".unrevoked.jsonl")
    import time as _t
    try:
        with open(unrevoked_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "name": name,
                "unrevoked_at": int(_t.time()),
                "removed_count": removed,
            }, separators=(",", ":")) + "\n")
    except OSError:
        pass
    return True


def list_revoked_presets(forge_dir: str, bucket: str) -> List[Dict[str, Any]]:
    """N-33: read the .revoked.jsonl audit trail for a bucket.

    Returns the list of revocation records in chronological order
    {name, revoked_at, ops, still_revoked}. Use this in incident
    reviews to confirm a known-bad preset stayed dropped.

    N-52: `still_revoked` is False when a later register call with
    force=True re-introduced the same name. Lets dashboards show the
    "currently shadowing" set without the operator computing the diff.
    """
    audit_path = os.path.join(os.path.dirname(_presets_path(forge_dir, bucket)),
                              ".revoked.jsonl")
    if not os.path.isfile(audit_path):
        return []
    out: List[Dict[str, Any]] = []
    try:
        with open(audit_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    # Cross-reference the live registry to compute still_revoked.
    live = {p["name"] for p in list_transform_presets(forge_dir, bucket)}
    for rec in out:
        rec["still_revoked"] = rec.get("name") not in live
    return out


def _is_revoked(forge_dir: str, bucket: str, name: str) -> bool:
    """N-28: True when `name` appears in the bucket's .revoked.jsonl."""
    audit_path = os.path.join(os.path.dirname(_presets_path(forge_dir, bucket)),
                              ".revoked.jsonl")
    if not os.path.isfile(audit_path):
        return False
    try:
        with open(audit_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("name") == name:
                    return True
    except OSError:
        pass
    return False


def register_transform_preset(forge_dir: str, bucket: str,
                              preset: Dict[str, Any],
                              *, force: bool = False) -> Dict[str, Any]:
    name = preset.get("name")
    if not isinstance(name, str) or not _PRESET_NAME_RE.match(name):
        raise ValueError("preset name must match ^[a-z][a-z0-9_-]{0,31}$")
    # N-28: a name previously dropped via revoke_transform_preset is
    # blocked from re-registration unless the caller explicitly opts
    # in via force=True. This prevents accidentally restoring a
    # known-bad preset during an incident replay.
    if not force and _is_revoked(forge_dir, bucket, name):
        raise ValueError(
            f"preset {name!r} was previously revoked for bucket "
            f"{bucket!r}; pass force=True to override"
        )
    ops = preset.get("ops")
    if not isinstance(ops, list) or not ops:
        raise ValueError("preset must include a non-empty ops list")
    cleaned_ops: List[Dict[str, Any]] = []
    for i, op in enumerate(ops):
        if not isinstance(op, dict) or len(op) != 1:
            raise ValueError(f"op #{i} must be a single-key dict")
        verb, arg = next(iter(op.items()))
        if verb not in _ALLOWED_OPS:
            raise ValueError(f"op #{i}: unknown verb {verb!r}")
        if verb == "resize":
            if not isinstance(arg, dict):
                raise ValueError(f"op #{i}: resize arg must be dict")
            w = int(arg.get("w", 0))
            h = int(arg.get("h", 0))
            fit = str(arg.get("fit", "cover"))
            if w <= 0 or w > 8192 or h <= 0 or h > 8192:
                raise ValueError(f"op #{i}: resize w/h out of range")
            if fit not in _FIT_ALLOWED:
                raise ValueError(f"op #{i}: invalid fit")
            cleaned_ops.append({"resize": {"w": w, "h": h, "fit": fit}})
        elif verb == "format":
            f = str(arg).lower()
            if f not in _FORMAT_ALLOWED:
                raise ValueError(f"op #{i}: invalid format")
            cleaned_ops.append({"format": f})
        elif verb == "quality":
            q = int(arg)
            if q < 1 or q > 100:
                raise ValueError(f"op #{i}: quality out of range")
            cleaned_ops.append({"quality": q})
        elif verb == "rotate":
            r = int(arg) % 360
            cleaned_ops.append({"rotate": r})
        elif verb == "grayscale":
            cleaned_ops.append({"grayscale": bool(arg)})
        elif verb == "blur":
            cleaned_ops.append({"blur": float(arg)})

    cleaned = {"name": name, "ops": cleaned_ops}
    path = _presets_path(forge_dir, bucket)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db: Dict[str, Any] = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                db = json.load(f)
        except (OSError, json.JSONDecodeError):
            db = {}
    db[name] = cleaned
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, sort_keys=True)
    os.replace(tmp, path)
    return cleaned


def list_transform_presets(forge_dir: str, bucket: str) -> List[Dict[str, Any]]:
    path = _presets_path(forge_dir, bucket)
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            db = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    return list(db.values())


def revoke_transform_preset(forge_dir: str, bucket: str,
                            name: str) -> bool:
    """N-14: remove a preset and append a `.revoked.jsonl` audit line.

    Use this for security incidents - e.g. a preset that proxied user
    content through a now-untrusted transform. Returns True when a
    preset was removed, False when no such preset existed. The audit
    line records the revocation so operators can correlate it with
    the incident timeline.
    """
    path = _presets_path(forge_dir, bucket)
    if not os.path.isfile(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            db = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False
    if name not in db:
        return False
    removed = db.pop(name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, sort_keys=True)
    os.replace(tmp, path)
    # Audit trail: append a line per revocation so the incident
    # response timeline survives even when the preset file is
    # later rewritten.
    audit_path = os.path.join(os.path.dirname(path), ".revoked.jsonl")
    import time as _t
    try:
        with open(audit_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "name": name,
                "revoked_at": int(_t.time()),
                "ops": removed.get("ops"),
            }, separators=(",", ":")) + "\n")
    except OSError:
        pass
    return True
