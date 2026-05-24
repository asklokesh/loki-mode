"""Local-vault storage for forge secrets.

File format (.vault file is JSON):
    {
      "version": 1,
      "kdf": "scrypt|sha256",
      "salt": "<b64>",
      "entries": {
          "<name>": {
              "alg": "AES-GCM-256" | "HMAC-XOR",
              "nonce": "<b64>",
              "ct":    "<b64>",
              "mac":   "<b64>",
              "created_at": <ts>,
              "updated_at": <ts>
          }
      }
    }

When `cryptography` is unavailable we fall back to HMAC-XOR (NOT secure
against an attacker who has the file - we warn loudly). The intent is
to keep dev machines functional without forcing a dep; production
deploys pull `cryptography` via the deploy adapter.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
from typing import Any, Dict, List, Optional


class SecretError(Exception):
    pass


_KEY_RE_OK = lambda s: isinstance(s, str) and s.replace("_", "").isalnum() and not s.startswith("_")


def _vault_path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "secrets.vault")


def _master_key(forge_dir: str) -> bytes:
    env = os.environ.get("LOKI_FORGE_MASTER_KEY")
    if env:
        try:
            raw = base64.urlsafe_b64decode(env + "=" * (-len(env) % 4))
        except Exception as e:
            raise SecretError(f"LOKI_FORGE_MASTER_KEY decode failed: {e}") from e
        if len(raw) < 32:
            raise SecretError("LOKI_FORGE_MASTER_KEY must decode to >=32 bytes")
        return raw
    keyfile = os.path.join(forge_dir, ".master.key")
    if os.path.exists(keyfile):
        with open(keyfile, "rb") as f:
            return f.read()
    os.makedirs(forge_dir, exist_ok=True)
    raw = secrets.token_bytes(32)
    tmp = keyfile + ".tmp"
    with open(tmp, "wb") as f:
        f.write(raw)
    os.replace(tmp, keyfile)
    os.chmod(keyfile, 0o600)
    return raw


def _load(forge_dir: str) -> Dict[str, Any]:
    p = _vault_path(forge_dir)
    if not os.path.isfile(p):
        return {"version": 1, "entries": {}}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "entries": {}}


def _save(forge_dir: str, data: Dict[str, Any]) -> None:
    p = _vault_path(forge_dir)
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, p)
    os.chmod(p, 0o600)


_AES_GCM_CACHE: Any = "__not_probed__"


def _try_aes_gcm():
    """Probe whether AES-GCM is usable. cryptography can have a partial
    install where the Python wrapper imports but its C extension
    (_cffi_backend) panics PyO3 at first encrypt call. PyO3 panics abort
    the process - we cannot try/except them. Detect such installs by
    importing _cffi_backend explicitly first."""
    global _AES_GCM_CACHE
    if _AES_GCM_CACHE != "__not_probed__":
        return _AES_GCM_CACHE
    try:
        import _cffi_backend  # noqa: F401
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM as _A
        # One real encryption to catch any other late binding issues.
        _A(secrets.token_bytes(32)).encrypt(secrets.token_bytes(12), b"x", None)
        _AES_GCM_CACHE = _A
    except Exception:
        _AES_GCM_CACHE = None
    return _AES_GCM_CACHE


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _encrypt(value: str, key: bytes) -> Dict[str, str]:
    aesgcm = _try_aes_gcm()
    if aesgcm is not None:
        nonce = secrets.token_bytes(12)
        ct = aesgcm(key[:32]).encrypt(nonce, value.encode("utf-8"), None)
        return {
            "alg": "AES-GCM-256",
            "nonce": _b64e(nonce),
            "ct": _b64e(ct),
            # N-08: master key path is "raw32" (32 random bytes from
            # secrets.token_bytes, no PBKDF2). When operators promote
            # to a passphrase-derived key, we'll bump these to "pbkdf2"
            # + 600000 and the existing list_secrets surface will
            # reflect the change without code changes.
            "kdf": "raw32",
            "kdf_iterations": 0,
        }
    # Fallback: HMAC-XOR. Warn loudly the first time.
    sys.stderr.write(
        "[forge.secrets] WARNING: 'cryptography' not installed; vault is "
        "using HMAC-XOR fallback. Install cryptography for AES-GCM.\n"
    )
    nonce = secrets.token_bytes(16)
    keystream = b""
    counter = 0
    while len(keystream) < len(value.encode("utf-8")):
        keystream += hmac.new(
            key,
            nonce + counter.to_bytes(4, "big"),
            hashlib.sha256,
        ).digest()
        counter += 1
    keystream = keystream[: len(value.encode("utf-8"))]
    ct = bytes(a ^ b for a, b in zip(value.encode("utf-8"), keystream))
    mac = hmac.new(key, nonce + ct, hashlib.sha256).digest()
    return {
        "alg": "HMAC-XOR",
        "nonce": _b64e(nonce),
        "ct": _b64e(ct),
        "mac": _b64e(mac),
        # N-08: HMAC-XOR rows have no KDF; expose this so list_secrets()
        # can flag them as the insecure fallback.
        "kdf": "none",
        "kdf_iterations": 0,
    }


def _decrypt(entry: Dict[str, str], key: bytes) -> str:
    nonce = _b64d(entry["nonce"])
    ct = _b64d(entry["ct"])
    alg = entry.get("alg")
    if alg == "AES-GCM-256":
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        pt = AESGCM(key[:32]).decrypt(nonce, ct, None)
        return pt.decode("utf-8")
    if alg == "HMAC-XOR":
        mac = _b64d(entry["mac"])
        check = hmac.new(key, nonce + ct, hashlib.sha256).digest()
        if not hmac.compare_digest(mac, check):
            raise SecretError("HMAC-XOR integrity check failed")
        keystream = b""
        counter = 0
        while len(keystream) < len(ct):
            keystream += hmac.new(
                key,
                nonce + counter.to_bytes(4, "big"),
                hashlib.sha256,
            ).digest()
            counter += 1
        keystream = keystream[: len(ct)]
        return bytes(a ^ b for a, b in zip(ct, keystream)).decode("utf-8")
    raise SecretError(f"unknown alg: {alg!r}")


def set_secret(forge_dir: str, name: str, value: str) -> Dict[str, Any]:
    if not _KEY_RE_OK(name):
        raise SecretError(
            "secret name must match [A-Za-z0-9_], not start with '_'"
        )
    if not isinstance(value, str):
        raise SecretError("value must be a string")
    if len(value.encode("utf-8")) > 64 * 1024:
        raise SecretError("value exceeds 64 KB cap")
    data = _load(forge_dir)
    key = _master_key(forge_dir)
    ent = _encrypt(value, key)
    now = int(time.time())
    prev = data["entries"].get(name) or {}
    ent.update({
        "created_at": prev.get("created_at", now),
        "updated_at": now,
    })
    data["entries"][name] = ent
    _save(forge_dir, data)
    return {"name": name, "alg": ent["alg"], "updated_at": now}


def get_secret(forge_dir: str, name: str) -> Optional[str]:
    data = _load(forge_dir)
    ent = data["entries"].get(name)
    if not ent:
        return None
    value = _decrypt(ent, _master_key(forge_dir))
    # N-41: stamp last_used_at on successful decryption so operators
    # can spot stale secrets that no caller has fetched in months.
    # Best-effort - file write failure must not block the value
    # return.
    try:
        import time as _t
        ent["last_used_at"] = int(_t.time())
        _save(forge_dir, data)
    except Exception:
        pass
    return value


def list_secrets(forge_dir: str) -> List[Dict[str, Any]]:
    """Returns names + metadata only; values never echoed.

    N-08: includes `kdf` and `kdf_iterations` so an operator can spot
    rows that fell back to HMAC-XOR (kdf='none', iterations=0). Old
    entries written before this field landed get defaults inferred
    from `alg` so existing vaults still report sensibly.
    """
    data = _load(forge_dir)
    out: List[Dict[str, Any]] = []
    for name, ent in sorted(data["entries"].items()):
        alg = ent.get("alg")
        kdf = ent.get("kdf")
        if kdf is None:
            # Back-compat default: AES-GCM rows used raw32 master key;
            # HMAC-XOR rows had no KDF.
            kdf = "raw32" if alg == "AES-GCM-256" else "none"
        out.append({
            "name": name,
            "alg": alg,
            "kdf": kdf,
            "kdf_iterations": int(ent.get("kdf_iterations", 0)),
            "fallback": alg == "HMAC-XOR",
            "created_at": ent.get("created_at"),
            "updated_at": ent.get("updated_at"),
            # N-41: surfaces last get_secret() time so operators
            # can identify rotation/removal candidates.
            "last_used_at": ent.get("last_used_at"),
        })
    return out


def weak_secrets(forge_dir: str) -> List[Dict[str, Any]]:
    """N-22: subset of list_secrets() that is on the insecure HMAC-XOR
    fallback. Use this in CI to fail builds that promote with weak
    secrets, or surface in a dashboard banner. The shape mirrors
    list_secrets() so callers can render it the same way.
    """
    return [r for r in list_secrets(forge_dir) if r.get("fallback")]


def export_secrets(forge_dir: str, *,
                   confirm_destructive: bool = False) -> Dict[str, str]:
    """X-67: one-shot emergency dump of every secret value.

    GATE: requires confirm_destructive=True so the agent cannot
    inadvertently export secrets via a routine MCP call. The values
    are returned in clear; the caller is responsible for not piping
    them into logs / events / commits.
    """
    if not confirm_destructive:
        raise SecretError(
            "export_secrets requires confirm_destructive=True - this "
            "returns secret values in clear and is an audit-significant "
            "operation"
        )
    data = _load(forge_dir)
    key = _master_key(forge_dir)
    out: Dict[str, str] = {}
    for name, ent in data["entries"].items():
        try:
            out[name] = _decrypt(ent, key)
        except Exception as e:
            out[name] = f"__decrypt_error__: {e}"
    return out


def rotate_value(forge_dir: str, name: str,
                 new_value: str) -> Dict[str, Any]:
    """X-85: rotate a secret's value in place. Re-encrypts with a
    fresh nonce, bumps updated_at, preserves created_at. Returns
    {name, alg, updated_at, rotated}."""
    if not _KEY_RE_OK(name):
        raise SecretError("invalid secret name")
    data = _load(forge_dir)
    if name not in data["entries"]:
        raise SecretError(f"secret not found: {name}")
    # set_secret already round-trips correctly; the difference is
    # the explicit semantic + audit signal (we record a rotation
    # marker so the dashboard can see the event).
    res = set_secret(forge_dir, name, new_value)
    res["rotated"] = True
    # Drop a rotation marker file the dashboard can surface.
    try:
        d = os.path.join(forge_dir, "secrets", "rotations.jsonl")
        os.makedirs(os.path.dirname(d), exist_ok=True)
        with open(d, "a", encoding="utf-8") as f:
            f.write(json.dumps({"name": name,
                                "ts": int(time.time()),
                                "kind": "value_rotated"}) + "\n")
    except OSError:
        pass
    return res


def delete_secret(forge_dir: str, name: str) -> bool:
    data = _load(forge_dir)
    if name not in data["entries"]:
        return False
    del data["entries"][name]
    _save(forge_dir, data)
    return True
