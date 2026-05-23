"""External auth adapter registry.

We support five adapters in F-4 (matching InsForge's catalog):
    auth0, clerk, kinde, stytch, workos.

Each adapter is registered with at minimum:
    - issuer URL (used by the JWKS lookup)
    - audience (the token aud claim we accept)
    - jwks_url (where we fetch the public keys)

verify_token() validates a JWT using the cached JWKS. The cache is
in-process with a 1-hour TTL; we never make a network call from inside
a verify(). Forge functions must pre-warm the cache via the
forge_auth_external_refresh MCP tool when keys rotate.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from typing import Any, Dict, List, Optional


class ExternalAuthError(Exception):
    pass


SUPPORTED_EXTERNAL: Dict[str, Dict[str, Any]] = {
    "auth0": {
        "default_jwks_path": "/.well-known/jwks.json",
        "alg": ["RS256"],
    },
    "clerk": {
        "default_jwks_path": "/.well-known/jwks.json",
        "alg": ["RS256"],
    },
    "kinde": {
        "default_jwks_path": "/.well-known/jwks",
        "alg": ["RS256"],
    },
    "stytch": {
        "default_jwks_path": "/.well-known/jwks.json",
        "alg": ["RS256"],
    },
    "workos": {
        "default_jwks_path": "/sso/jwks/{org_id}",
        "alg": ["RS256"],
    },
}


def _dir(forge_dir: str) -> str:
    return os.path.join(forge_dir, "auth", "external")


def _path(forge_dir: str, name: str) -> str:
    return os.path.join(_dir(forge_dir), f"{name}.json")


def _validate_url(url: str, label: str) -> None:
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        raise ExternalAuthError(f"{label} must be an http(s) URL")
    if any(ch in url for ch in " \t\r\n\x00"):
        raise ExternalAuthError(f"{label} contains whitespace/control chars")


def configure(forge_dir: str, name: str, *,
              issuer: str, audience: str,
              jwks_url: Optional[str] = None,
              extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if name not in SUPPORTED_EXTERNAL:
        raise ExternalAuthError(
            f"unsupported external auth: {name!r}; "
            f"choose from {sorted(SUPPORTED_EXTERNAL)}"
        )
    _validate_url(issuer, "issuer")
    if jwks_url is None:
        jwks_url = issuer.rstrip("/") + SUPPORTED_EXTERNAL[name]["default_jwks_path"]
    _validate_url(jwks_url, "jwks_url")
    if not isinstance(audience, str) or not audience:
        raise ExternalAuthError("audience required")
    cfg = {
        "name": name,
        "issuer": issuer.rstrip("/"),
        "audience": audience,
        "jwks_url": jwks_url,
        "alg": SUPPORTED_EXTERNAL[name]["alg"],
        "extra": extra or {},
        "configured_at": int(time.time()),
    }
    os.makedirs(_dir(forge_dir), exist_ok=True)
    p = _path(forge_dir, name)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)
    os.replace(tmp, p)
    os.chmod(p, 0o600)
    return cfg


def list_external(forge_dir: str) -> List[Dict[str, Any]]:
    d = _dir(forge_dir)
    if not os.path.isdir(d):
        return []
    out: List[Dict[str, Any]] = []
    for f in sorted(os.listdir(d)):
        if not f.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, f), "r", encoding="utf-8") as fh:
                out.append(json.load(fh))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def remove_external(forge_dir: str, name: str) -> bool:
    if name not in SUPPORTED_EXTERNAL:
        raise ExternalAuthError(f"unsupported: {name}")
    p = _path(forge_dir, name)
    if os.path.exists(p):
        os.remove(p)
        return True
    return False


# verify_token: F-4 ships a *contract* + offline self-verify against an
# embedded HS256 test fixture. The full RS256 + JWKS fetch path lands in
# F-5 when we ship the SDK that needs it (the agent's user app calls
# this from a forge function, where http is available; the Loki control
# plane should not make outbound network calls).


def verify_token(forge_dir: str, name: str, token: str,
                 jwks_cache: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Verify an external JWT.

    Args:
        jwks_cache: optional pre-fetched JWKS dict {"keys": [...]}.
                    If None we look for a cached file at
                    <forge_dir>/auth/external/<name>.jwks.json.

    Returns the verified claims dict. Raises ExternalAuthError on any
    failure (bad alg, bad signature, expired, audience/issuer mismatch).
    """
    if name not in SUPPORTED_EXTERNAL:
        raise ExternalAuthError(f"unsupported: {name}")
    cfg_path = _path(forge_dir, name)
    if not os.path.isfile(cfg_path):
        raise ExternalAuthError(f"{name} not configured")
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    if jwks_cache is None:
        jwks_path = os.path.join(_dir(forge_dir), f"{name}.jwks.json")
        if not os.path.isfile(jwks_path):
            raise ExternalAuthError(
                f"no cached JWKS for {name} - run forge_auth_external_refresh"
            )
        try:
            with open(jwks_path, "r", encoding="utf-8") as f:
                jwks_cache = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            raise ExternalAuthError(f"jwks cache unreadable: {e}") from e

    keys = jwks_cache.get("keys") or []
    if not keys:
        raise ExternalAuthError("jwks has no keys")

    # Parse the token.
    if not isinstance(token, str) or token.count(".") != 2:
        raise ExternalAuthError("malformed token")
    h_b64, p_b64, s_b64 = token.split(".")
    try:
        header = json.loads(_b64d(h_b64))
        payload = json.loads(_b64d(p_b64))
    except (ValueError, json.JSONDecodeError) as e:
        raise ExternalAuthError(f"parse error: {e}") from e

    alg = header.get("alg")
    if alg not in cfg.get("alg", []):
        raise ExternalAuthError(f"alg {alg} not allowed; expected {cfg['alg']}")

    # Audience + issuer.
    if payload.get("iss", "").rstrip("/") != cfg["issuer"]:
        raise ExternalAuthError("issuer mismatch")
    aud_claim = payload.get("aud")
    if isinstance(aud_claim, list):
        if cfg["audience"] not in aud_claim:
            raise ExternalAuthError("audience not in token aud list")
    elif aud_claim != cfg["audience"]:
        raise ExternalAuthError("audience mismatch")

    # Expiry.
    now = int(time.time())
    exp = payload.get("exp")
    if not isinstance(exp, int) or exp < now:
        raise ExternalAuthError("token expired or missing exp")

    # Signature.
    kid = header.get("kid")
    matching = [k for k in keys if k.get("kid") == kid] if kid else keys
    if not matching:
        raise ExternalAuthError("no key matched kid")
    key_obj = matching[0]

    if alg == "RS256":
        _verify_rs256(h_b64, p_b64, s_b64, key_obj)
    elif alg == "HS256":
        secret = key_obj.get("k")
        if not secret:
            raise ExternalAuthError("HS256 key missing 'k'")
        signing_input = (h_b64 + "." + p_b64).encode("ascii")
        expected = hmac.new(_b64d(secret), signing_input,
                            hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64d(s_b64)):
            raise ExternalAuthError("HS256 signature mismatch")
    else:
        raise ExternalAuthError(f"unsupported alg at verify time: {alg}")

    return payload


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _verify_rs256(h_b64: str, p_b64: str, s_b64: str,
                  jwk: Dict[str, Any]) -> None:
    """RS256 verification. Requires cryptography; falls back to a clear
    error if not present so the caller knows external auth needs the
    crypto extension."""
    try:
        from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers
        from cryptography.hazmat.primitives.asymmetric.padding import PKCS1v15
        from cryptography.hazmat.primitives.hashes import SHA256
        from cryptography.hazmat.backends import default_backend
    except Exception as e:
        raise ExternalAuthError(
            f"RS256 requires cryptography package: {e}"
        ) from e

    if jwk.get("kty") != "RSA":
        raise ExternalAuthError("jwk kty must be RSA for RS256")
    try:
        n_bytes = _b64d(jwk["n"])
        e_bytes = _b64d(jwk["e"])
    except (KeyError, ValueError) as ex:
        raise ExternalAuthError(f"jwk n/e missing: {ex}") from ex
    n = int.from_bytes(n_bytes, "big")
    e = int.from_bytes(e_bytes, "big")
    pub = RSAPublicNumbers(e=e, n=n).public_key(default_backend())
    signing_input = (h_b64 + "." + p_b64).encode("ascii")
    sig = _b64d(s_b64)
    try:
        pub.verify(sig, signing_input, PKCS1v15(), SHA256())
    except Exception as ex:
        raise ExternalAuthError("RS256 signature mismatch") from ex
