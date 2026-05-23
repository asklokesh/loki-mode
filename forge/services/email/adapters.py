"""Email send adapters - Resend, SendGrid, Postmark.

Storage:
    <forge_dir>/email/<provider>.json        - non-secret config + api_key_ref
    <forge_dir>/email/<provider>/sent.jsonl  - audit log of every send

If a forge function named `email_dispatch` is deployed, send() invokes
it (the function holds the upstream HTTP client). Otherwise we just
record the message to sent.jsonl with status=recorded - dev-friendly,
useful for tests, and matches the same pattern we use for the gateway.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, List, Optional


class EmailError(Exception):
    pass


SUPPORTED_PROVIDERS = {"resend", "sendgrid", "postmark"}
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _provider_dir(forge_dir: str, provider: str) -> str:
    return os.path.join(forge_dir, "email", provider)


def _config_path(forge_dir: str, provider: str) -> str:
    return os.path.join(forge_dir, "email", f"{provider}.json")


def setup_provider(forge_dir: str, provider: str, *,
                   api_key_ref: str,
                   from_address: str,
                   from_name: Optional[str] = None) -> Dict[str, Any]:
    if provider not in SUPPORTED_PROVIDERS:
        raise EmailError(f"unsupported provider: {provider!r}")
    if not isinstance(api_key_ref, str) or not api_key_ref.replace("_", "").isalnum():
        raise EmailError("api_key_ref must be a forge secret name")
    if not _EMAIL_RE.match(from_address):
        raise EmailError("from_address must be a valid email")
    cfg = {
        "provider": provider,
        "api_key_ref": api_key_ref,
        "from_address": from_address,
        "from_name": from_name,
        "configured_at": int(time.time()),
    }
    os.makedirs(os.path.dirname(_config_path(forge_dir, provider)),
                exist_ok=True)
    tmp = _config_path(forge_dir, provider) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)
    os.replace(tmp, _config_path(forge_dir, provider))
    os.chmod(_config_path(forge_dir, provider), 0o600)
    return cfg


def send(forge_dir: str, provider: str, *,
         to: str, subject: str, body_text: str,
         body_html: Optional[str] = None,
         headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    if provider not in SUPPORTED_PROVIDERS:
        raise EmailError(f"unsupported provider: {provider!r}")
    if not _EMAIL_RE.match(to):
        raise EmailError("to must be a valid email")
    if not isinstance(subject, str) or not subject:
        raise EmailError("subject required")
    if not isinstance(body_text, str) or not body_text:
        raise EmailError("body_text required")
    cfg_path = _config_path(forge_dir, provider)
    if not os.path.isfile(cfg_path):
        raise EmailError(f"{provider} not configured")
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    rec = {
        "id": "email_" + str(int(time.time() * 1000)),
        "provider": provider,
        "to": to,
        "from_address": cfg.get("from_address"),
        "subject": subject[:200],
        "headers": (headers or {}),
        "issued_at": int(time.time()),
        "status": "recorded",
    }

    # Best-effort dispatch via a deployed forge function. We never crash
    # the caller (e.g. magic-link redeem) on a delivery failure - just
    # record and surface the error.
    try:
        from forge.services.functions import get_function, invoke
        if get_function(forge_dir, "email_dispatch"):
            res = invoke(forge_dir, "email_dispatch", payload={
                "provider": provider,
                "config": cfg,
                "to": to,
                "subject": subject,
                "body_text": body_text,
                "body_html": body_html,
                "headers": headers,
            })
            rec["status"] = "sent" if res.get("ok") else "send_failed"
            rec["dispatch_run_id"] = res.get("run_id")
    except Exception as e:
        rec["status"] = "dispatch_error"
        rec["error"] = str(e)

    path = os.path.join(_provider_dir(forge_dir, provider), "sent.jsonl")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    return rec


def list_sent(forge_dir: str, provider: str,
              limit: int = 100) -> List[Dict[str, Any]]:
    if provider not in SUPPORTED_PROVIDERS:
        raise EmailError(f"unsupported provider: {provider!r}")
    path = os.path.join(_provider_dir(forge_dir, provider), "sent.jsonl")
    if not os.path.isfile(path):
        return []
    out: List[Dict[str, Any]] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return out[-max(1, min(int(limit), 10000)):]
