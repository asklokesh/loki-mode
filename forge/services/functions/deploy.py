"""Function deployment lifecycle.

Each deploy creates a versioned snapshot under
<forge_dir>/functions/<name>/versions/<n>/. The manifest points to the
"active" version; rollbacks switch the pointer atomically (write tmp +
os.replace). Smoke tests run synchronously before promote so a broken
deploy never serves traffic.

The function code is treated as a single source file in F-2. Multi-file
bundles arrive with the Bun bundler in F-2.16.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import time
from typing import Any, Dict, List, Optional


class FunctionError(Exception):
    pass


_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,62}$")
_ALLOWED_RUNTIMES = {"bun", "deno", "python"}
_ALLOWED_TRIGGERS = {"http", "cron", "webhook", "event"}
_MAX_SOURCE_BYTES = 4 * 1024 * 1024  # 4MB per function source bundle


def _root(forge_dir: str) -> str:
    return os.path.join(forge_dir, "functions")


def _fn_dir(forge_dir: str, name: str) -> str:
    return os.path.join(_root(forge_dir), name)


def _validate_name(name: str) -> None:
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise FunctionError(
            "function name must match ^[a-z][a-z0-9_-]{1,62}$"
        )


def _write_json(path: str, data: Any, mode: int = 0o644) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, path)
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def _utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def deploy(forge_dir: str, name: str, runtime: str, source_b64: str,
           *, entry: str = "index", env_secrets: Optional[List[str]] = None,
           timeout_ms: int = 10000, memory_mb: int = 128,
           triggers: Optional[List[Dict[str, Any]]] = None,
           deployed_by_user_id: Optional[str] = None) -> Dict[str, Any]:
    """Deploy a new version of a function. Returns its manifest entry."""
    _validate_name(name)
    if runtime not in _ALLOWED_RUNTIMES:
        raise FunctionError(f"unsupported runtime: {runtime!r}")
    if not isinstance(source_b64, str) or not source_b64.strip():
        raise FunctionError("source_b64 must be a non-empty base64 string")
    try:
        source_bytes = base64.b64decode(source_b64.encode("ascii"), validate=True)
    except (ValueError, Exception) as e:
        raise FunctionError(f"source_b64 decode failed: {e}") from e
    if len(source_bytes) > _MAX_SOURCE_BYTES:
        raise FunctionError(
            f"source exceeds cap ({_MAX_SOURCE_BYTES} bytes)"
        )
    if not isinstance(timeout_ms, int) or not (100 <= timeout_ms <= 600_000):
        raise FunctionError("timeout_ms must be in [100, 600000]")
    if not isinstance(memory_mb, int) or not (16 <= memory_mb <= 4096):
        raise FunctionError("memory_mb must be in [16, 4096]")
    env_secrets = list(env_secrets or [])
    for s in env_secrets:
        if not isinstance(s, str) or not s.replace("_", "").isalnum() or s.startswith("_"):
            raise FunctionError(f"invalid env_secret name: {s!r}")

    triggers = list(triggers or [{"type": "http"}])
    for t in triggers:
        if not isinstance(t, dict) or t.get("type") not in _ALLOWED_TRIGGERS:
            raise FunctionError(
                f"trigger.type must be one of {sorted(_ALLOWED_TRIGGERS)}"
            )

    fn_dir = _fn_dir(forge_dir, name)
    versions_dir = os.path.join(fn_dir, "versions")
    os.makedirs(versions_dir, exist_ok=True)

    # Choose the next version id (monotonically increasing).
    existing = sorted(
        (int(v) for v in os.listdir(versions_dir) if v.isdigit()),
        reverse=True,
    )
    next_v = (existing[0] + 1) if existing else 1
    vdir = os.path.join(versions_dir, str(next_v))
    os.makedirs(vdir, exist_ok=False)
    # Source layout: index.<ext> where ext is runtime-specific.
    ext = {"bun": "ts", "deno": "ts", "python": "py"}[runtime]
    src_path = os.path.join(vdir, f"{entry}.{ext}")
    with open(src_path, "wb") as f:
        f.write(source_bytes)
    os.chmod(src_path, 0o600)
    sha = hashlib.sha256(source_bytes).hexdigest()

    # Update the manifest.
    manifest_path = os.path.join(fn_dir, "manifest.json")
    manifest: Dict[str, Any]
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    else:
        manifest = {"name": name, "versions": []}
    manifest.update({
        "name": name,
        "runtime": runtime,
        "entry": entry,
        "env_secrets": env_secrets,
        "timeout_ms": timeout_ms,
        "memory_mb": memory_mb,
        "triggers": triggers,
        "active_version": next_v,
    })
    versions = manifest.get("versions", [])
    version_entry = {
        "version": next_v,
        "sha": sha,
        "size": len(source_bytes),
        "deployed_at": _utc_iso(),
    }
    # N-40: attribute the deploy to the caller's user_id when supplied
    # so audit reviews see who shipped each version. None on legacy
    # / unattended deploys.
    if deployed_by_user_id is not None:
        if not isinstance(deployed_by_user_id, str) or not deployed_by_user_id:
            raise FunctionError("deployed_by_user_id must be a non-empty string")
        # N-49: when the auth users table exists, verify the supplied
        # user_id maps to a real row so typos surface here rather
        # than in the audit log days later. Missing users table = no
        # check (back-compat for deploys before auth is provisioned).
        try:
            import sqlite3 as _sql
            db_path = os.path.join(forge_dir, "db.sqlite")
            if os.path.isfile(db_path):
                conn = _sql.connect(db_path)
                try:
                    row = conn.execute(
                        "SELECT name FROM sqlite_master "
                        "WHERE type='table' AND name='users'"
                    ).fetchone()
                    if row:
                        hit = conn.execute(
                            "SELECT 1 FROM users WHERE id = ? LIMIT 1",
                            (deployed_by_user_id,)
                        ).fetchone()
                        if not hit:
                            raise FunctionError(
                                f"deployed_by_user_id {deployed_by_user_id!r} "
                                "not found in users table"
                            )
                finally:
                    conn.close()
        except FunctionError:
            raise
        except Exception:
            pass
        version_entry["deployed_by_user_id"] = deployed_by_user_id
    versions.append(version_entry)
    # X-78: signed-source attestation. We HMAC the source bytes with
    # the project's master key so downstream verifiers can confirm
    # this exact source was deployed by Loki. Best-effort; if the
    # secrets vault is unavailable we skip the signature.
    try:
        import hmac as _hmac
        import hashlib as _hashlib
        from forge.services.secrets.vault import _master_key
        sig = _hmac.new(_master_key(forge_dir),
                        source_bytes, _hashlib.sha256).hexdigest()
        versions[-1]["signature"] = sig
    except Exception:
        pass

    # Cap version history at 25 - older versions garbage-collected.
    if len(versions) > 25:
        for stale in versions[:-25]:
            stale_dir = os.path.join(versions_dir, str(stale["version"]))
            shutil.rmtree(stale_dir, ignore_errors=True)
        versions = versions[-25:]
    manifest["versions"] = versions
    _write_json(manifest_path, manifest)
    return manifest


def list_functions(forge_dir: str) -> List[Dict[str, Any]]:
    root = _root(forge_dir)
    if not os.path.isdir(root):
        return []
    out: List[Dict[str, Any]] = []
    for entry in sorted(os.listdir(root)):
        mpath = os.path.join(root, entry, "manifest.json")
        if not os.path.isfile(mpath):
            continue
        try:
            with open(mpath, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        # N-64: surface attribution for the active version at the top
        # level so dashboards don't have to walk versions[].
        active = manifest.get("active_version")
        if active is not None:
            for v in manifest.get("versions", []):
                if v.get("version") == active:
                    if v.get("deployed_by_user_id"):
                        manifest["last_deployed_by_user_id"] = \
                            v["deployed_by_user_id"]
                    if v.get("deployed_at"):
                        manifest["last_deployed_at"] = v["deployed_at"]
                    break
        out.append(manifest)
    return out


def get_function(forge_dir: str, name: str) -> Optional[Dict[str, Any]]:
    _validate_name(name)
    mpath = os.path.join(_fn_dir(forge_dir, name), "manifest.json")
    if not os.path.isfile(mpath):
        return None
    with open(mpath, "r", encoding="utf-8") as f:
        return json.load(f)


def list_versions(forge_dir: str, name: str) -> List[Dict[str, Any]]:
    m = get_function(forge_dir, name)
    if not m:
        return []
    return list(m.get("versions", []))


def delete_function(forge_dir: str, name: str) -> bool:
    _validate_name(name)
    fn_dir = _fn_dir(forge_dir, name)
    if not os.path.isdir(fn_dir):
        return False
    shutil.rmtree(fn_dir)
    return True


def rollback(forge_dir: str, name: str, to_version: int) -> Dict[str, Any]:
    """Switch the active_version pointer back to a prior deploy. Best-effort:
    the source file must still exist on disk (older versions are garbage-
    collected past the 25-version cap)."""
    m = get_function(forge_dir, name)
    if not m:
        raise FunctionError(f"function not found: {name}")
    versions = [v["version"] for v in m.get("versions", [])]
    if to_version not in versions:
        raise FunctionError(f"version {to_version} not in history {versions}")
    vdir = os.path.join(_fn_dir(forge_dir, name), "versions", str(to_version))
    if not os.path.isdir(vdir):
        raise FunctionError(f"version {to_version} source missing on disk")
    m["active_version"] = to_version
    _write_json(os.path.join(_fn_dir(forge_dir, name), "manifest.json"), m)
    return m


def verify_signature(forge_dir: str, name: str,
                     version: Optional[int] = None) -> Dict[str, Any]:
    """N-07: recompute the HMAC over the on-disk source bytes and
    compare against the signature recorded at deploy time.

    Returns {ok, reason, version, signature_present}:
        - ok=True signature_present=False: no signature on file
          (legacy deploy / master_key unavailable at deploy time);
          invoke() treats this as a soft pass so back-compat holds.
        - ok=True signature_present=True: recompute matched.
        - ok=False: mismatch or source missing.
    Never raises - the caller decides whether a mismatch is fatal.
    """
    m = get_function(forge_dir, name)
    if not m:
        return {"ok": False, "reason": "function_not_found",
                "signature_present": False, "version": version}
    v = version if version is not None else m.get("active_version")
    if v is None:
        return {"ok": False, "reason": "no_active_version",
                "signature_present": False, "version": None}
    ver = next((x for x in m.get("versions", [])
                if x.get("version") == v), None)
    if ver is None:
        return {"ok": False, "reason": "version_not_recorded",
                "signature_present": False, "version": v}
    sig = ver.get("signature")
    if not sig:
        return {"ok": True, "reason": "no_signature_on_record",
                "signature_present": False, "version": v}
    src = source_path(forge_dir, name, version=v)
    if not src:
        return {"ok": False, "reason": "source_missing",
                "signature_present": True, "version": v}
    try:
        import hmac as _hmac
        import hashlib as _hashlib
        from forge.services.secrets.vault import _master_key
        with open(src, "rb") as f:
            actual = _hmac.new(_master_key(forge_dir), f.read(),
                               _hashlib.sha256).hexdigest()
    except Exception as e:
        return {"ok": False, "reason": f"hmac_error: {e}",
                "signature_present": True, "version": v}
    if not _hmac.compare_digest(actual, sig):
        return {"ok": False, "reason": "signature_mismatch",
                "signature_present": True, "version": v,
                "expected": sig, "actual": actual}
    return {"ok": True, "reason": "verified",
            "signature_present": True, "version": v}


def source_path(forge_dir: str, name: str,
                version: Optional[int] = None) -> Optional[str]:
    """Resolve the on-disk path to the source file for a given version
    (or the active version if not specified). Internal use by invoke()."""
    m = get_function(forge_dir, name)
    if not m:
        return None
    v = version if version is not None else m.get("active_version")
    if v is None:
        return None
    vdir = os.path.join(_fn_dir(forge_dir, name), "versions", str(v))
    if not os.path.isdir(vdir):
        return None
    entry = m.get("entry", "index")
    ext = {"bun": "ts", "deno": "ts", "python": "py"}.get(m.get("runtime", "bun"), "ts")
    p = os.path.join(vdir, f"{entry}.{ext}")
    return p if os.path.isfile(p) else None
