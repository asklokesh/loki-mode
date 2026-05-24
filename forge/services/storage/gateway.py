"""S3-compatible storage backend gateway (X-46).

The FS-backed default (buckets.py) is the dev path. For prod, the
deploy adapter wires this gateway to an actual S3-compatible
endpoint (AWS S3, R2, B2, Tigris, MinIO). We do not bundle a boto3
client - we provide the *config* + the upload-plan + signed URLs so
the user-app's runtime handles the bytes.

Storage:
    <forge_dir>/storage/.gateway.json - per-project config
    {
      provider: 's3' | 'r2' | 'b2' | 'tigris' | 'minio' | 'fs',
      endpoint: 'https://...',
      bucket: 'forge-prod',
      region: 'us-east-1',
      access_key_ref: 'AWS_ACCESS_KEY_ID',
      secret_key_ref: 'AWS_SECRET_ACCESS_KEY',
    }

When provider != 'fs', signed-URL generation switches to AWS SigV4
form (computed locally; no upstream call).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


SUPPORTED_PROVIDERS = ("fs", "s3", "r2", "b2", "tigris", "minio")


class StorageProbeError(RuntimeError):
    """Raised when probe() fails to confirm the bucket is reachable.

    The message names the endpoint, the bucket, and the HTTP status (or
    the underlying socket/HTTP error) so the operator can fix the
    misconfiguration without reading the SDK stack trace.
    """


def _config_path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "storage", ".gateway.json")


def probe_bucket(*, endpoint: str, bucket: str,
                 timeout_s: float = 3.0) -> Dict[str, Any]:
    """N-03: HEAD the bucket and return {ok, status, error}.

    No SigV4 - this is the unauthenticated reachability check. A
    private bucket returning 403 still counts as "reachable" because
    the endpoint exists and answered; a DNS failure or connection
    refused returns ok=False with a clear error string. Used by
    configure(probe=True) to fail fast on misconfigured endpoints.
    """
    if not endpoint or not endpoint.startswith(("https://", "http://")):
        raise ValueError("endpoint must be an http(s) URL")
    if not bucket:
        raise ValueError("bucket required")
    url = f"{endpoint.rstrip('/')}/{urllib.parse.quote(bucket)}/"
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return {"ok": True, "status": resp.status, "url": url}
    except urllib.error.HTTPError as e:
        # 401/403 means the endpoint answered; reachability confirmed.
        if e.code in (401, 403, 404):
            return {"ok": True, "status": e.code, "url": url,
                    "note": "endpoint reachable; auth/visibility may "
                            "require credentials"}
        return {"ok": False, "status": e.code, "url": url,
                "error": f"HTTP {e.code} {e.reason}"}
    except (urllib.error.URLError, socket.timeout, socket.gaierror,
            ConnectionError, TimeoutError) as e:
        return {"ok": False, "status": None, "url": url,
                "error": f"{type(e).__name__}: {e}"}


def configure(forge_dir: str, *,
              provider: str,
              endpoint: Optional[str] = None,
              bucket: Optional[str] = None,
              region: str = "auto",
              access_key_ref: Optional[str] = None,
              secret_key_ref: Optional[str] = None,
              probe: bool = False,
              probe_timeout_s: float = 3.0) -> Dict[str, Any]:
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError(f"unsupported provider: {provider!r}")
    if provider != "fs":
        if not endpoint or not endpoint.startswith(("https://", "http://")):
            raise ValueError("endpoint required (http(s) URL)")
        if not bucket:
            raise ValueError("bucket required")
        if access_key_ref and not access_key_ref.replace("_", "").isalnum():
            raise ValueError("access_key_ref must be a forge secret name")
        if secret_key_ref and not secret_key_ref.replace("_", "").isalnum():
            raise ValueError("secret_key_ref must be a forge secret name")
        if probe:
            result = probe_bucket(endpoint=endpoint, bucket=bucket,
                                  timeout_s=probe_timeout_s)
            if not result.get("ok"):
                raise StorageProbeError(
                    f"bucket probe failed for {provider}://{bucket} "
                    f"at {endpoint}: {result.get('error')}"
                )
    cfg = {
        "provider": provider,
        "endpoint": endpoint,
        "bucket": bucket,
        "region": region,
        "access_key_ref": access_key_ref,
        "secret_key_ref": secret_key_ref,
        "configured_at": int(time.time()),
    }
    os.makedirs(os.path.dirname(_config_path(forge_dir)), exist_ok=True)
    tmp = _config_path(forge_dir) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)
    os.replace(tmp, _config_path(forge_dir))
    os.chmod(_config_path(forge_dir), 0o600)
    return cfg


def get_config(forge_dir: str) -> Dict[str, Any]:
    p = _config_path(forge_dir)
    if not os.path.isfile(p):
        return {"provider": "fs"}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"provider": "fs"}


# ---- SigV4 signed-URL generator (used by R2 / S3 / MinIO / B2) ------------


def _sigv4_sign(key: bytes, date_str: str, region: str,
                service: str) -> bytes:
    k_date = hmac.new(b"AWS4" + key, date_str.encode(), hashlib.sha256).digest()
    k_region = hmac.new(k_date, region.encode(), hashlib.sha256).digest()
    k_service = hmac.new(k_region, service.encode(), hashlib.sha256).digest()
    return hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()


def s3_presigned_url(*, access_key: str, secret_key: str,
                     endpoint: str, bucket: str, key: str,
                     region: str = "auto", method: str = "GET",
                     expires_in: int = 3600) -> str:
    """Compute a SigV4 presigned URL locally. Returns the absolute URL.

    This is enough for object GET / PUT against any S3-compatible
    endpoint. We do not POST + form-data (used by browser uploads);
    the user-app's runtime client handles that case.
    """
    if expires_in <= 0 or expires_in > 7 * 24 * 3600:
        raise ValueError("expires_in must be in (0, 7 days]")
    now = time.gmtime()
    amz_date = time.strftime("%Y%m%dT%H%M%SZ", now)
    date_str = amz_date[:8]
    canonical_uri = "/" + urllib.parse.quote(bucket) + "/" + urllib.parse.quote(key, safe="/")
    host = urllib.parse.urlparse(endpoint).netloc
    credential = f"{access_key}/{date_str}/{region}/s3/aws4_request"
    qs_pairs = [
        ("X-Amz-Algorithm", "AWS4-HMAC-SHA256"),
        ("X-Amz-Credential", credential),
        ("X-Amz-Date", amz_date),
        ("X-Amz-Expires", str(expires_in)),
        ("X-Amz-SignedHeaders", "host"),
    ]
    canonical_qs = "&".join(
        urllib.parse.quote(k, safe="") + "=" + urllib.parse.quote(v, safe="")
        for k, v in qs_pairs
    )
    canonical_request = "\n".join([
        method.upper(),
        canonical_uri,
        canonical_qs,
        f"host:{host}\n",
        "host",
        "UNSIGNED-PAYLOAD",
    ])
    cr_hash = hashlib.sha256(canonical_request.encode()).hexdigest()
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256",
        amz_date,
        f"{date_str}/{region}/s3/aws4_request",
        cr_hash,
    ])
    signing_key = _sigv4_sign(secret_key.encode(), date_str, region, "s3")
    sig = hmac.new(signing_key, string_to_sign.encode(),
                   hashlib.sha256).hexdigest()
    url = f"{endpoint.rstrip('/')}{canonical_uri}?{canonical_qs}&X-Amz-Signature={sig}"
    return url
