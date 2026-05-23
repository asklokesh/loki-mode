"""Signed URLs for forge storage objects.

URL format:
    /forge/storage/v1/<bucket>/<path>?expires=<unix>&sig=<hex>[&transform=<preset>]

Signature: HMAC-SHA256 over "<bucket>|<path>|<expires>|<transform>" using
the bucket master key (auto-generated on first sign call, stored at
<forge_dir>/storage/<bucket>/.sign_key, 0600).

We never embed the signing key in the URL itself; only the digest. That
keeps URLs link-shareable without exposing the secret.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
import urllib.parse
from typing import Dict, Optional


def _key_path(forge_dir: str, bucket: str) -> str:
    return os.path.join(forge_dir, "storage", bucket, ".sign_key")


def _get_or_create_key(forge_dir: str, bucket: str) -> bytes:
    path = _key_path(forge_dir, bucket)
    if os.path.exists(path):
        with open(path, "rb") as f:
            return f.read()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = secrets.token_bytes(48)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(raw)
    os.replace(tmp, path)
    os.chmod(path, 0o600)
    return raw


def _signature(key: bytes, bucket: str, path: str, expires: int,
               transform: str) -> str:
    msg = "|".join([bucket, path, str(expires), transform]).encode("utf-8")
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def sign_url(forge_dir: str, bucket: str, path: str, *,
             expires_in: int = 3600,
             base_url: str = "",
             transform: str = "") -> str:
    """Mint a signed URL for an object. expires_in is seconds from now."""
    if expires_in <= 0 or expires_in > 7 * 24 * 3600:
        raise ValueError("expires_in must be in (0, 7 days]")
    key = _get_or_create_key(forge_dir, bucket)
    expires = int(time.time()) + int(expires_in)
    sig = _signature(key, bucket, path, expires, transform)
    qs = {"expires": str(expires), "sig": sig}
    if transform:
        qs["transform"] = transform
    url = f"{base_url.rstrip('/')}/forge/storage/v1/{urllib.parse.quote(bucket)}/{urllib.parse.quote(path)}"
    return url + "?" + urllib.parse.urlencode(qs)


def verify_url(forge_dir: str, bucket: str, path: str, qs: Dict[str, str]) -> Dict[str, str]:
    """Validate a signed-URL query string. Returns {"valid": "true",
    "transform": ...} or raises ValueError."""
    try:
        expires = int(qs.get("expires", "0"))
    except ValueError:
        raise ValueError("invalid expires")
    if expires < int(time.time()):
        raise ValueError("expired")
    sig = qs.get("sig", "")
    transform = qs.get("transform", "") or ""
    key = _get_or_create_key(forge_dir, bucket)
    expected = _signature(key, bucket, path, expires, transform)
    if not hmac.compare_digest(expected, sig):
        raise ValueError("bad signature")
    return {"valid": "true", "transform": transform, "expires": str(expires)}
