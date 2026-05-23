"""JWT signing/verification + user/session management.

JWT implementation is HS256-only in F-2 (no external deps). RS256 with
key rotation lands in F-3 when we have a real key-management story. The
HS256 path is correct and constant-time-comparable; the threat model
is "developer machine plus self-hosted prod", not "untrusted JWT issuer".

All user/session state lives in <forge_dir>/auth/users.sqlite to keep it
isolated from the user-app database. Schema:

    users(id PK, email UNIQUE, password_hash, oauth_subject_json,
          created_at, last_login_at, disabled)
    sessions(id PK, user_id FK, refresh_token_hash, issued_at,
             expires_at, revoked_at)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple


# --- low-level JWT (HS256) -------------------------------------------------


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _hmac_sha256(key: bytes, msg: bytes) -> bytes:
    return hmac.new(key, msg, hashlib.sha256).digest()


def _get_or_create_signing_key(forge_dir: str) -> bytes:
    """Return the active HS256 signing key. Creates one on first use."""
    keydir = os.path.join(forge_dir, "auth", "keys")
    os.makedirs(keydir, exist_ok=True)
    path = os.path.join(keydir, "jwt.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            blob = json.load(f)
        active = blob.get("active")
        if isinstance(active, str):
            return _b64url_decode(active)
    # Generate.
    raw = secrets.token_bytes(48)
    blob = {"active": _b64url_encode(raw), "previous": []}
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(blob, f)
    os.replace(tmp, path)
    os.chmod(path, 0o600)
    return raw


def sign_token(forge_dir: str, claims: Dict[str, Any],
               ttl_seconds: int = 3600) -> str:
    """Sign a JWT (HS256). Adds iat/exp/jti if missing."""
    if not isinstance(claims, dict):
        raise TypeError("claims must be a dict")
    now = int(time.time())
    payload = dict(claims)
    payload.setdefault("iat", now)
    payload.setdefault("exp", now + max(1, int(ttl_seconds)))
    payload.setdefault("jti", uuid.uuid4().hex)

    header = {"alg": "HS256", "typ": "JWT"}
    h = _b64url_encode(json.dumps(header, separators=(",", ":"),
                                  sort_keys=True).encode("utf-8"))
    p = _b64url_encode(json.dumps(payload, separators=(",", ":"),
                                  sort_keys=True).encode("utf-8"))
    signing_input = (h + "." + p).encode("ascii")
    key = _get_or_create_signing_key(forge_dir)
    sig = _b64url_encode(_hmac_sha256(key, signing_input))
    return f"{h}.{p}.{sig}"


def verify_token(forge_dir: str, token: str) -> Dict[str, Any]:
    """Verify a JWT and return its claims. Raises ValueError on any
    failure (bad format, bad signature, expired, wrong alg)."""
    if not isinstance(token, str) or token.count(".") != 2:
        raise ValueError("malformed token")
    h_b64, p_b64, s_b64 = token.split(".")
    try:
        header = json.loads(_b64url_decode(h_b64))
        payload = json.loads(_b64url_decode(p_b64))
        sig = _b64url_decode(s_b64)
    except (ValueError, json.JSONDecodeError) as e:
        raise ValueError("malformed token: " + str(e)) from e

    if header.get("alg") != "HS256" or header.get("typ") != "JWT":
        raise ValueError("unsupported alg/typ")

    key = _get_or_create_signing_key(forge_dir)
    expected = _hmac_sha256(key, (h_b64 + "." + p_b64).encode("ascii"))
    if not hmac.compare_digest(expected, sig):
        raise ValueError("signature mismatch")

    now = int(time.time())
    exp = payload.get("exp")
    if isinstance(exp, int) and exp < now:
        raise ValueError("token expired")
    nbf = payload.get("nbf")
    if isinstance(nbf, int) and nbf > now:
        raise ValueError("token not yet valid")
    return payload


# --- user + session store --------------------------------------------------


def _users_db_path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "auth", "users.sqlite")


def _open_users_db(forge_dir: str) -> sqlite3.Connection:
    path = _users_db_path(forge_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False,
                           isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def ensure_auth_schema(forge_dir: str) -> None:
    """Create auth tables on first use. Idempotent."""
    conn = _open_users_db(forge_dir)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE,
            password_hash TEXT,
            oauth_subject_json TEXT,
            created_at TEXT NOT NULL,
            last_login_at TEXT,
            disabled INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            refresh_token_hash TEXT NOT NULL,
            issued_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            revoked_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user
            ON sessions(user_id);
        """
    )
    conn.close()


# --- password hashing (PBKDF2-HMAC-SHA256; 600k iterations, OWASP 2026) ---

_PBKDF2_ITERS = 600_000


def hash_password(plain: str) -> str:
    if not isinstance(plain, str) or not plain:
        raise ValueError("password must be a non-empty string")
    if len(plain.encode("utf-8")) > 1024:
        raise ValueError("password too long (>1024 bytes)")
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", plain.encode("utf-8"),
                             salt, _PBKDF2_ITERS, dklen=32)
    return f"pbkdf2_sha256${_PBKDF2_ITERS}${_b64url_encode(salt)}${_b64url_encode(dk)}"


def verify_password(plain: str, stored: str) -> bool:
    if not isinstance(plain, str) or not isinstance(stored, str):
        return False
    parts = stored.split("$")
    if len(parts) != 4 or parts[0] != "pbkdf2_sha256":
        return False
    try:
        iters = int(parts[1])
        salt = _b64url_decode(parts[2])
        expected = _b64url_decode(parts[3])
    except (ValueError, Exception):
        return False
    dk = hashlib.pbkdf2_hmac("sha256", plain.encode("utf-8"),
                             salt, iters, dklen=len(expected))
    return hmac.compare_digest(dk, expected)


# --- user management -------------------------------------------------------


def create_user(forge_dir: str, email: Optional[str] = None,
                password: Optional[str] = None,
                oauth_subject: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Create a user. Either email+password OR oauth_subject is required.
    Returns the new user row. Raises ValueError on duplicate email or
    invalid input.
    """
    if not email and not oauth_subject:
        raise ValueError("either email or oauth_subject required")
    ensure_auth_schema(forge_dir)
    conn = _open_users_db(forge_dir)
    try:
        if email:
            existing = conn.execute(
                "SELECT id FROM users WHERE email = ?", (email,)
            ).fetchone()
            if existing:
                raise ValueError(f"user already exists: {email}")
        uid = uuid.uuid4().hex
        ph = hash_password(password) if password else None
        oauth_json = json.dumps(oauth_subject, sort_keys=True) if oauth_subject else None
        now = _utc_iso()
        conn.execute(
            "INSERT INTO users (id, email, password_hash, oauth_subject_json, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (uid, email, ph, oauth_json, now),
        )
        row = conn.execute(
            "SELECT id, email, created_at, last_login_at, disabled "
            "FROM users WHERE id = ?", (uid,)
        ).fetchone()
        return dict(row) if row else {}
    finally:
        conn.close()


def list_users(forge_dir: str, filter: Optional[Dict[str, Any]] = None,
               limit: int = 100) -> List[Dict[str, Any]]:
    ensure_auth_schema(forge_dir)
    conn = _open_users_db(forge_dir)
    try:
        sql = ("SELECT id, email, created_at, last_login_at, disabled "
               "FROM users")
        params: List[Any] = []
        if filter:
            clauses = []
            if "email" in filter:
                clauses.append("email = ?")
                params.append(filter["email"])
            if "disabled" in filter:
                clauses.append("disabled = ?")
                params.append(1 if filter["disabled"] else 0)
            if clauses:
                sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(max(1, min(int(limit), 1000)))
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def revoke_session(forge_dir: str, user_id: str) -> int:
    """Revoke all active sessions for a user. Returns the number revoked."""
    ensure_auth_schema(forge_dir)
    conn = _open_users_db(forge_dir)
    try:
        cur = conn.execute(
            "UPDATE sessions SET revoked_at = ? "
            "WHERE user_id = ? AND revoked_at IS NULL",
            (_utc_iso(), user_id),
        )
        return cur.rowcount
    finally:
        conn.close()


def _utc_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
