"""
API Key Management Module for Loki Mode Dashboard.

Provides key rotation with grace periods, metadata management,
and usage tracking. Builds on dashboard.auth for core token operations.

Storage: Extends ~/.loki/dashboard/tokens.json with additional fields.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from pydantic import BaseModel, Field

from . import auth


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------


class ApiKeyCreate(BaseModel):
    """Request schema for creating an API key."""
    name: str
    scopes: Optional[list[str]] = None
    role: Optional[str] = None
    expires_days: Optional[int] = None
    description: Optional[str] = None
    allowed_ips: Optional[list[str]] = None
    rate_limit: Optional[int] = Field(None, description="Requests per minute")


class ApiKeyResponse(BaseModel):
    """Response schema for an API key."""
    id: str
    name: str
    scopes: list[str]
    role: Optional[str] = None
    created_at: str
    expires_at: Optional[str] = None
    last_used: Optional[str] = None
    revoked: bool = False
    description: Optional[str] = None
    allowed_ips: Optional[list[str]] = None
    rate_limit: Optional[int] = None
    rotating_from: Optional[str] = None
    rotation_expires_at: Optional[str] = None
    usage_count: int = 0


class ApiKeyRotateRequest(BaseModel):
    """Request schema for rotating an API key."""
    grace_period_hours: int = Field(24, ge=0, description="Hours the old key remains valid")


class ApiKeyRotateResponse(BaseModel):
    """Response schema after key rotation."""
    new_key: ApiKeyResponse
    old_key_id: str
    old_key_rotation_expires_at: str
    token: str  # Raw token, shown only once


# ---------------------------------------------------------------------------
# Internal Helpers
# ---------------------------------------------------------------------------


def _find_token_entry(identifier: str) -> Optional[tuple[str, dict]]:
    """Find a token entry by ID or name.

    Args:
        identifier: Token ID or name.

    Returns:
        Tuple of (token_id, token_dict) or None if not found.
    """
    tokens = auth._load_tokens()
    for tid, entry in tokens["tokens"].items():
        if tid == identifier or entry["name"] == identifier:
            return tid, entry
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def rotate_key(identifier: str, grace_period_hours: int = 24) -> dict:
    """Rotate an API key, keeping the old key valid during a grace period.

    Creates a new key with the same name (suffixed), scopes, and role.
    The old key is marked as "rotating" and will expire after the grace
    period.

    Args:
        identifier: ID or name of the key to rotate.
        grace_period_hours: Hours the old key remains valid (default 24).

    Returns:
        Dict with ``new_key`` (includes raw token), ``old_key_id``, and
        ``old_key_rotation_expires_at``.

    Raises:
        ValueError: If the key is not found, already revoked, or already
                    in rotation.
    """
    result = _find_token_entry(identifier)
    if result is None:
        raise ValueError(f"Key not found: {identifier}")

    old_id, old_entry = result

    if old_entry.get("revoked"):
        raise ValueError("Cannot rotate a revoked key")

    if old_entry.get("rotation_expires_at"):
        raise ValueError("Key is already in rotation")

    # Capture properties from the old key
    original_name = old_entry["name"]
    scopes = old_entry.get("scopes", ["*"])
    role = old_entry.get("role")

    # Mark old key as rotating
    rotation_expires = (
        datetime.now(timezone.utc) + timedelta(hours=grace_period_hours)
    ).isoformat()

    tokens = auth._load_tokens()
    tokens["tokens"][old_id]["rotation_expires_at"] = rotation_expires
    # Temporarily rename old key so generate_token doesn't reject duplicate
    tokens["tokens"][old_id]["name"] = f"{original_name}__rotating"
    auth._save_tokens(tokens)

    # Generate the replacement key with the original name
    try:
        new_entry = auth.generate_token(
            name=original_name,
            scopes=scopes if role is None else None,
            role=role,
        )
    except Exception:
        # Rollback: restore old key name and remove rotation marker
        tokens = auth._load_tokens()
        tokens["tokens"][old_id]["name"] = original_name
        tokens["tokens"][old_id].pop("rotation_expires_at", None)
        auth._save_tokens(tokens)
        raise

    # Record the relationship on the new key
    tokens = auth._load_tokens()
    new_id = new_entry["id"]
    tokens["tokens"][new_id]["rotating_from"] = old_id

    # Copy metadata from old key to new key
    for field in ("description", "allowed_ips", "rate_limit"):
        if old_entry.get(field) is not None:
            tokens["tokens"][new_id][field] = old_entry[field]

    auth._save_tokens(tokens)

    return {
        "new_key": {**tokens["tokens"][new_id]},
        "old_key_id": old_id,
        "old_key_rotation_expires_at": rotation_expires,
        "token": new_entry["token"],
    }


def get_key_details(identifier: str) -> Optional[dict]:
    """Get full key metadata including usage stats.

    Args:
        identifier: Token ID or name.

    Returns:
        Dict with all key metadata, or None if not found.
    """
    result = _find_token_entry(identifier)
    if result is None:
        return None

    tid, entry = result
    # Return a safe copy (no hash/salt)
    return {
        "id": entry["id"],
        "name": entry["name"],
        "scopes": entry.get("scopes", []),
        "role": entry.get("role"),
        "created_at": entry.get("created_at"),
        "expires_at": entry.get("expires_at"),
        "last_used": entry.get("last_used"),
        "revoked": entry.get("revoked", False),
        "description": entry.get("description"),
        "allowed_ips": entry.get("allowed_ips"),
        "rate_limit": entry.get("rate_limit"),
        "rotating_from": entry.get("rotating_from"),
        "rotation_expires_at": entry.get("rotation_expires_at"),
        "usage_count": entry.get("usage_count", 0),
    }


def update_key_metadata(
    identifier: str,
    description: Optional[str] = None,
    allowed_ips: Optional[list[str]] = None,
    rate_limit: Optional[int] = None,
) -> dict:
    """Update key metadata without rotating.

    Args:
        identifier: Token ID or name.
        description: New description (or None to leave unchanged).
        allowed_ips: New allowed IPs list (or None to leave unchanged).
        rate_limit: New rate limit in requests/minute (or None to leave
                    unchanged).

    Returns:
        Updated key details dict.

    Raises:
        ValueError: If the key is not found.
    """
    result = _find_token_entry(identifier)
    if result is None:
        raise ValueError(f"Key not found: {identifier}")

    tid, _ = result
    tokens = auth._load_tokens()

    if description is not None:
        tokens["tokens"][tid]["description"] = description
    if allowed_ips is not None:
        tokens["tokens"][tid]["allowed_ips"] = allowed_ips
    if rate_limit is not None:
        tokens["tokens"][tid]["rate_limit"] = rate_limit

    auth._save_tokens(tokens)
    return get_key_details(identifier)


def list_keys_with_details(include_rotating: bool = True) -> list[dict]:
    """List all keys with extended metadata and rotation status.

    Args:
        include_rotating: Whether to include keys that are in rotation
                          (old keys being phased out). Default True.

    Returns:
        List of key detail dicts (no hashes or raw tokens).
    """
    tokens = auth._load_tokens()
    result = []

    for entry in tokens["tokens"].values():
        # Skip revoked keys
        if entry.get("revoked"):
            continue

        # Skip rotating keys if not requested
        is_rotating = bool(entry.get("rotation_expires_at"))
        if is_rotating and not include_rotating:
            continue

        detail = {
            "id": entry["id"],
            "name": entry["name"],
            "scopes": entry.get("scopes", []),
            "role": entry.get("role"),
            "created_at": entry.get("created_at"),
            "expires_at": entry.get("expires_at"),
            "last_used": entry.get("last_used"),
            "revoked": entry.get("revoked", False),
            "description": entry.get("description"),
            "allowed_ips": entry.get("allowed_ips"),
            "rate_limit": entry.get("rate_limit"),
            "rotating_from": entry.get("rotating_from"),
            "rotation_expires_at": entry.get("rotation_expires_at"),
            "usage_count": entry.get("usage_count", 0),
        }
        result.append(detail)

    return result


def cleanup_expired_rotating_keys() -> list[str]:
    """Remove keys whose rotation grace period has expired.

    Finds all keys with a ``rotation_expires_at`` timestamp in the past
    and deletes them.

    Returns:
        List of deleted key IDs.
    """
    tokens = auth._load_tokens()
    now = datetime.now(timezone.utc)
    to_delete = []

    for tid, entry in tokens["tokens"].items():
        rotation_exp = entry.get("rotation_expires_at")
        if rotation_exp:
            exp_dt = datetime.fromisoformat(rotation_exp)
            if now > exp_dt:
                to_delete.append(tid)

    for tid in to_delete:
        del tokens["tokens"][tid]

    if to_delete:
        auth._save_tokens(tokens)

    return to_delete


def get_key_usage_stats(identifier: str) -> Optional[dict]:
    """Return usage statistics for a key.

    Args:
        identifier: Token ID or name.

    Returns:
        Dict with usage_count, last_used, created_at, and age_days,
        or None if not found.
    """
    result = _find_token_entry(identifier)
    if result is None:
        return None

    _, entry = result
    created = entry.get("created_at")
    age_days = None
    if created:
        created_dt = datetime.fromisoformat(created)
        age_days = (datetime.now(timezone.utc) - created_dt).days

    return {
        "usage_count": entry.get("usage_count", 0),
        "last_used": entry.get("last_used"),
        "created_at": created,
        "age_days": age_days,
    }


def increment_usage(identifier: str) -> None:
    """Increment the usage counter for a key.

    Called internally when a key is validated. This is separate from
    auth.validate_token() to avoid modifying auth.py.

    Args:
        identifier: Token ID or name.
    """
    result = _find_token_entry(identifier)
    if result is None:
        return

    tid, _ = result
    tokens = auth._load_tokens()
    tokens["tokens"][tid]["usage_count"] = tokens["tokens"][tid].get("usage_count", 0) + 1
    auth._save_tokens(tokens)
