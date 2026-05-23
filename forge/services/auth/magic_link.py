"""Magic-link (passwordless email) flow.

The user requests a magic link by email; we mint a single-use token
and persist a record in <forge_dir>/auth/magic_links.jsonl with
expiry. The agent's forge function ships the email; we don't bind to
SendGrid/Resend/Mailgun here - just emit a record and return the
token for the function to deliver.

Redemption issues a JWT session token (via sessions.sign_token) tied
to the user-id we resolve from the email. Each magic link is single-
use; redemption marks the record consumed.

Tokens are 128-bit random URL-safe strings; 600s default TTL.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from typing import Any, Dict, Optional

from .sessions import (
    create_user as _create_user,
    ensure_auth_schema,
    sign_token,
    _open_users_db,
)


_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_TOKEN_TTL_SECONDS = 600


class MagicLinkError(Exception):
    pass


def _path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "auth", "magic_links.jsonl")


def issue(forge_dir: str, email: str,
          *, redirect_url: Optional[str] = None,
          ttl_seconds: int = _TOKEN_TTL_SECONDS,
          email_provider: Optional[str] = None,
          link_template: Optional[str] = None) -> Dict[str, Any]:
    """Mint a single-use magic-link token for `email`.

    If `email_provider` is supplied and the matching forge email
    adapter is configured, we also call send() to deliver the link.
    `link_template` is the URL the user clicks (with {token}
    substituted); defaults to "?token={token}" so callers can prefix
    with their own host.

    Returns the token plus expiry; with email delivery enabled, the
    returned record carries an `email_record_id` so the caller can
    audit.
    """
    if not isinstance(email, str) or not _EMAIL_RE.match(email):
        raise MagicLinkError("invalid email")
    if redirect_url is not None and not (
        isinstance(redirect_url, str)
        and redirect_url.startswith(("http://", "https://"))
    ):
        raise MagicLinkError("redirect_url must be http(s) when provided")
    ttl_seconds = max(30, min(int(ttl_seconds), 86400))  # 30s .. 24h
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    rec = {
        "token": token,
        "email": email,
        "redirect_url": redirect_url,
        "issued_at": now,
        "expires_at": now + ttl_seconds,
        "consumed_at": None,
    }
    p = _path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")

    response: Dict[str, Any] = {
        "token": token,
        "email": email,
        "expires_at": rec["expires_at"],
        "redirect_url": redirect_url,
    }

    if email_provider:
        try:
            from forge.services.email import send
            tmpl = link_template or "?token={token}"
            link = tmpl.replace("{token}", token)
            sent = send(forge_dir, email_provider, to=email,
                        subject="Your sign-in link",
                        body_text=(f"Click to sign in: {link}\n\n"
                                   "If you did not request this, ignore."),
                        body_html=(f"<p>Click to sign in: "
                                   f"<a href=\"{link}\">{link}</a></p>"
                                   "<p>If you did not request this, ignore.</p>"))
            response["email_record_id"] = sent.get("id")
            response["email_status"] = sent.get("status")
        except Exception as e:
            response["email_error"] = str(e)

    return response


def redeem(forge_dir: str, token: str) -> Dict[str, Any]:
    """Redeem a magic-link token. Single-use: subsequent attempts with the
    same token return {"ok": False, "error": "consumed_or_unknown"}.

    Side-effect: creates a forge user for `email` if one doesn't exist
    yet, then issues a session JWT.
    """
    if not isinstance(token, str) or len(token) < 32:
        return {"ok": False, "error": "invalid_token_shape"}
    p = _path(forge_dir)
    if not os.path.isfile(p):
        return {"ok": False, "error": "consumed_or_unknown"}

    records: list = []
    target_idx = -1
    target_rec: Optional[Dict[str, Any]] = None
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("token") == token:
                    target_idx = len(records)
                    target_rec = rec
                records.append(rec)
    except OSError as e:
        return {"ok": False, "error": str(e)}

    if target_rec is None:
        return {"ok": False, "error": "consumed_or_unknown"}
    if target_rec.get("consumed_at"):
        return {"ok": False, "error": "consumed_or_unknown"}
    now = int(time.time())
    if target_rec.get("expires_at", 0) < now:
        return {"ok": False, "error": "expired"}

    # Mark consumed (rewrite the file).
    records[target_idx]["consumed_at"] = now
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")
    os.replace(tmp, p)

    # Ensure user exists.
    ensure_auth_schema(forge_dir)
    email = target_rec["email"]
    conn = _open_users_db(forge_dir)
    try:
        row = conn.execute(
            "SELECT id FROM users WHERE email = ?", (email,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        u = _create_user(forge_dir, email=email,
                         oauth_subject={"provider": "magic-link"})
        user_id = u["id"]
    else:
        user_id = row["id"]

    jwt = sign_token(forge_dir, {"sub": user_id, "email": email,
                                  "via": "magic-link"})
    return {
        "ok": True,
        "user_id": user_id,
        "email": email,
        "token": jwt,
        "redirect_url": target_rec.get("redirect_url"),
    }
