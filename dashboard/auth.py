"""
Optional Authentication Module for Loki Mode Dashboard.

Enterprise feature - disabled by default.
Enable with LOKI_ENTERPRISE_AUTH=true environment variable.

Token storage: ~/.loki/dashboard/tokens.json
"""

import hashlib
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

# Configuration
ENTERPRISE_AUTH_ENABLED = os.environ.get("LOKI_ENTERPRISE_AUTH", "").lower() in ("true", "1", "yes")
TOKEN_DIR = Path.home() / ".loki" / "dashboard"
TOKEN_FILE = TOKEN_DIR / "tokens.json"

# Security scheme (optional)
security = HTTPBearer(auto_error=False)


def _ensure_token_dir() -> None:
    """Ensure the token directory exists."""
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)


def _load_tokens() -> dict:
    """Load tokens from disk."""
    _ensure_token_dir()
    if TOKEN_FILE.exists():
        try:
            with open(TOKEN_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {"version": "1.0", "tokens": {}}
    return {"version": "1.0", "tokens": {}}


def _save_tokens(tokens: dict) -> None:
    """Save tokens to disk."""
    _ensure_token_dir()
    # Set restrictive permissions (owner read/write only)
    TOKEN_FILE.touch(mode=0o600, exist_ok=True)
    with open(TOKEN_FILE, "w") as f:
        json.dump(tokens, f, indent=2, default=str)


def _hash_token(token: str) -> str:
    """Hash a token for storage."""
    return hashlib.sha256(token.encode()).hexdigest()


def _constant_time_compare(a: str, b: str) -> bool:
    """Constant-time string comparison to prevent timing attacks."""
    return secrets.compare_digest(a.encode(), b.encode())


def generate_token(
    name: str,
    scopes: Optional[list[str]] = None,
    expires_days: Optional[int] = None,
) -> dict:
    """
    Generate a new API token.

    Args:
        name: Human-readable name for the token
        scopes: Optional list of permission scopes (default: all)
        expires_days: Optional expiration in days (None = never expires)

    Returns:
        Dict with token info (includes raw token - only shown once)

    Raises:
        ValueError: If name is empty/too long or expires_days is invalid
    """
    # Validate inputs
    if not name or not name.strip():
        raise ValueError("Token name cannot be empty")
    if len(name) > 255:
        raise ValueError("Token name too long (max 255 characters)")
    if expires_days is not None and expires_days <= 0:
        raise ValueError("expires_days must be positive (or None for no expiration)")

    name = name.strip()

    # Generate secure random token
    raw_token = f"loki_{secrets.token_urlsafe(32)}"
    token_hash = _hash_token(raw_token)
    token_id = token_hash[:12]

    tokens = _load_tokens()

    # Check for duplicate name
    for existing in tokens["tokens"].values():
        if existing["name"] == name:
            raise ValueError(f"Token with name '{name}' already exists")

    # Calculate expiration
    expires_at = None
    if expires_days:
        from datetime import timedelta
        expires_at = (datetime.now(timezone.utc) + timedelta(days=expires_days)).isoformat()

    token_entry = {
        "id": token_id,
        "name": name,
        "hash": token_hash,
        "scopes": scopes or ["*"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": expires_at,
        "last_used": None,
        "revoked": False,
    }

    tokens["tokens"][token_id] = token_entry
    _save_tokens(tokens)

    # Return with raw token (only shown once)
    return {
        **token_entry,
        "token": raw_token,  # Only returned on creation
    }


def revoke_token(identifier: str) -> bool:
    """
    Revoke a token by ID or name.

    Args:
        identifier: Token ID or name

    Returns:
        True if revoked, False if not found
    """
    tokens = _load_tokens()

    # Find by ID or name
    token_id = None
    for tid, token in tokens["tokens"].items():
        if tid == identifier or token["name"] == identifier:
            token_id = tid
            break

    if token_id:
        tokens["tokens"][token_id]["revoked"] = True
        tokens["tokens"][token_id]["revoked_at"] = datetime.now(timezone.utc).isoformat()
        _save_tokens(tokens)
        return True
    return False


def delete_token(identifier: str) -> bool:
    """
    Permanently delete a token by ID or name.

    Args:
        identifier: Token ID or name

    Returns:
        True if deleted, False if not found
    """
    tokens = _load_tokens()

    # Find by ID or name
    token_id = None
    for tid, token in tokens["tokens"].items():
        if tid == identifier or token["name"] == identifier:
            token_id = tid
            break

    if token_id:
        del tokens["tokens"][token_id]
        _save_tokens(tokens)
        return True
    return False


def list_tokens(include_revoked: bool = False) -> list[dict]:
    """
    List all tokens (without hashes or raw tokens).

    Args:
        include_revoked: Whether to include revoked tokens

    Returns:
        List of token metadata
    """
    tokens = _load_tokens()
    result = []

    for token in tokens["tokens"].values():
        if not include_revoked and token.get("revoked"):
            continue

        # Don't expose hash
        safe_token = {
            "id": token["id"],
            "name": token["name"],
            "scopes": token["scopes"],
            "created_at": token["created_at"],
            "expires_at": token.get("expires_at"),
            "last_used": token.get("last_used"),
            "revoked": token.get("revoked", False),
        }
        result.append(safe_token)

    return result


def validate_token(raw_token: str) -> Optional[dict]:
    """
    Validate a raw token.

    Args:
        raw_token: The raw token string

    Returns:
        Token metadata if valid, None if invalid/expired/revoked
    """
    if not raw_token or not raw_token.startswith("loki_"):
        return None

    token_hash = _hash_token(raw_token)
    tokens = _load_tokens()

    # Find matching token (using constant-time comparison to prevent timing attacks)
    for token in tokens["tokens"].values():
        if _constant_time_compare(token["hash"], token_hash):
            # Check if revoked
            if token.get("revoked"):
                return None

            # Check expiration
            if token.get("expires_at"):
                expires = datetime.fromisoformat(token["expires_at"])
                if datetime.now(timezone.utc) > expires:
                    return None

            # Update last used
            token["last_used"] = datetime.now(timezone.utc).isoformat()
            _save_tokens(tokens)

            return {
                "id": token["id"],
                "name": token["name"],
                "scopes": token["scopes"],
            }

    return None


def has_scope(token_info: dict, required_scope: str) -> bool:
    """
    Check if a token has a required scope.

    Args:
        token_info: Token metadata from validate_token
        required_scope: The scope to check

    Returns:
        True if token has the scope (or wildcard)
    """
    scopes = token_info.get("scopes", [])
    return "*" in scopes or required_scope in scopes


# FastAPI dependency for optional auth
async def get_current_token(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(security),
) -> Optional[dict]:
    """
    FastAPI dependency for optional token authentication.

    When LOKI_ENTERPRISE_AUTH is enabled:
        - Requires valid Bearer token
        - Returns token info

    When disabled:
        - Returns None (allows anonymous access)
    """
    if not ENTERPRISE_AUTH_ENABLED:
        # Auth disabled - allow anonymous
        return None

    if not credentials:
        raise HTTPException(
            status_code=401,
            detail="Authentication required (enterprise mode)",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token_info = validate_token(credentials.credentials)
    if not token_info:
        raise HTTPException(
            status_code=401,
            detail="Invalid, expired, or revoked token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return token_info


def require_scope(scope: str):
    """
    Factory for scope-checking dependency.

    Usage:
        @app.get("/admin", dependencies=[Depends(require_scope("admin"))])
    """
    async def check_scope(token_info: Optional[dict] = Security(get_current_token)):
        if not ENTERPRISE_AUTH_ENABLED:
            return  # No auth required

        if not token_info:
            raise HTTPException(status_code=401, detail="Authentication required")

        if not has_scope(token_info, scope):
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions. Required scope: {scope}"
            )

    return check_scope


def is_enterprise_mode() -> bool:
    """Check if enterprise mode is enabled."""
    return ENTERPRISE_AUTH_ENABLED
