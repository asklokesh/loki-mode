"""
Optional Authentication Module for Loki Mode Dashboard.

Enterprise feature - disabled by default.
Enable with LOKI_ENTERPRISE_AUTH=true environment variable.

OIDC/SSO support (optional) - enable with LOKI_OIDC_ISSUER + LOKI_OIDC_CLIENT_ID.
Supports enterprise SSO providers (Okta, Azure AD, Google Workspace).

Token storage: ~/.loki/dashboard/tokens.json
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

# Configuration
ENTERPRISE_AUTH_ENABLED = os.environ.get("LOKI_ENTERPRISE_AUTH", "").lower() in ("true", "1", "yes")
TOKEN_DIR = Path.home() / ".loki" / "dashboard"
TOKEN_FILE = TOKEN_DIR / "tokens.json"

# OIDC Configuration (optional - disabled by default)
OIDC_ISSUER = os.environ.get("LOKI_OIDC_ISSUER", "")  # e.g., https://accounts.google.com
OIDC_CLIENT_ID = os.environ.get("LOKI_OIDC_CLIENT_ID", "")
OIDC_AUDIENCE = os.environ.get("LOKI_OIDC_AUDIENCE", "")  # Usually same as client_id
OIDC_SKIP_SIGNATURE_VERIFY = os.environ.get("LOKI_OIDC_SKIP_SIGNATURE_VERIFY", "").lower() in ("true", "1", "yes")
OIDC_ENABLED = bool(OIDC_ISSUER and OIDC_CLIENT_ID)

# Role-to-scope mapping (predefined roles)
ROLES = {
    "admin": ["*"],  # Full access
    "operator": ["control", "read", "write"],  # Start/stop/pause, view+edit dashboard
    "viewer": ["read"],  # Read-only dashboard access
    "auditor": ["read", "audit"],  # Read dashboard + audit logs
}

# Scope hierarchy: higher scopes implicitly grant lower ones (single-level lookup).
# * -> control -> write -> read
# Each scope explicitly lists ALL scopes it grants (no transitive resolution).
_SCOPE_HIERARCHY = {
    "*": {"control", "write", "read", "audit", "admin"},
    "control": {"write", "read"},
    "write": {"read"},
}

if OIDC_ENABLED:
    import logging as _logging
    _logger = _logging.getLogger("loki.auth")
    _pyjwt_available = False
    try:
        import jwt as _pyjwt_check  # noqa: F401
        from jwt import PyJWKClient as _PyJWKClient_check  # noqa: F401
        _pyjwt_available = True
    except ImportError:
        _pyjwt_available = False

    if OIDC_SKIP_SIGNATURE_VERIFY:
        _logger.critical(
            "OIDC/SSO signature verification DISABLED (LOKI_OIDC_SKIP_SIGNATURE_VERIFY=true). "
            "This is INSECURE and allows forged JWTs. Only use for local testing. "
            "For production, install PyJWT + cryptography and remove this env var."
        )
    elif _pyjwt_available:
        _logger.info(
            "OIDC/SSO enabled with PyJWT cryptographic signature verification (RS256/RS384/RS512)."
        )
    else:
        _logger.critical(
            "OIDC/SSO enabled but PyJWT is NOT installed. Tokens will be REJECTED "
            "unless LOKI_OIDC_SKIP_SIGNATURE_VERIFY=true is set. "
            "Install PyJWT + cryptography: pip install PyJWT cryptography"
        )

# OIDC JWKS cache (issuer URL -> (keys_dict, fetch_timestamp))
_oidc_jwks_cache = {}  # type: dict[str, tuple[dict, float]]
_OIDC_CACHE_TTL = 3600  # Cache JWKS for 1 hour

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
    # Enforce 0600 on every write, not just creation -- touch(mode=) only
    # applies when the file is new, so an external chmod would persist.
    os.chmod(TOKEN_FILE, 0o600)


def _hash_token(token: str, salt: str = None) -> tuple[str, str]:
    """Hash a token for storage with a per-token random salt.

    Args:
        token: The raw token string to hash.
        salt: Optional salt. If None, a new random salt is generated.

    Returns:
        Tuple of (hex_digest, salt).
    """
    if salt is None:
        salt = secrets.token_hex(16)
    digest = hashlib.sha256((salt + token).encode()).hexdigest()
    return digest, salt


def _constant_time_compare(a: str, b: str) -> bool:
    """Constant-time string comparison to prevent timing attacks."""
    return hmac.compare_digest(a.encode(), b.encode())


def resolve_scopes(role_or_scopes) -> list[str]:
    """Resolve a role name or scope list into a concrete list of scopes.

    Args:
        role_or_scopes: Either a role name (str), a single scope (str),
                        or a list of scopes.

    Returns:
        List of scope strings.
    """
    if isinstance(role_or_scopes, list):
        return role_or_scopes
    if isinstance(role_or_scopes, str):
        if role_or_scopes in ROLES:
            return list(ROLES[role_or_scopes])
        return [role_or_scopes]
    return ["*"]


def list_roles() -> dict[str, list[str]]:
    """Return the predefined role-to-scope mapping.

    Returns:
        Dict mapping role names to their scope lists.
    """
    return dict(ROLES)


def generate_token(
    name: str,
    scopes: Optional[list[str]] = None,
    expires_days: Optional[int] = None,
    role: Optional[str] = None,
) -> dict:
    """
    Generate a new API token.

    Args:
        name: Human-readable name for the token
        scopes: Optional list of permission scopes (default: all)
        expires_days: Optional expiration in days (None = never expires)
        role: Optional role name (admin, operator, viewer, auditor).
              If provided, scopes are resolved from the role.
              Cannot be combined with explicit scopes.

    Returns:
        Dict with token info (includes raw token - only shown once)

    Raises:
        ValueError: If name is empty/too long, expires_days is invalid,
                    or role is unrecognized
    """
    # Validate inputs
    if not name or not name.strip():
        raise ValueError("Token name cannot be empty")
    if len(name) > 255:
        raise ValueError("Token name too long (max 255 characters)")
    if expires_days is not None and expires_days <= 0:
        raise ValueError("expires_days must be positive (or None for no expiration)")
    if role is not None and role not in ROLES:
        raise ValueError(
            f"Unknown role '{role}'. Valid roles: {', '.join(ROLES.keys())}"
        )

    name = name.strip()

    # Resolve scopes: role takes precedence if provided
    if role is not None:
        resolved_scopes = resolve_scopes(role)
    else:
        resolved_scopes = scopes

    # Generate secure random token
    raw_token = f"loki_{secrets.token_urlsafe(32)}"
    token_hash, token_salt = _hash_token(raw_token)
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
        "salt": token_salt,
        "scopes": resolved_scopes or ["*"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": expires_at,
        "last_used": None,
        "revoked": False,
    }
    if role is not None:
        token_entry["role"] = role

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
        if "role" in token:
            safe_token["role"] = token["role"]
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

    tokens = _load_tokens()

    # Iterate ALL tokens to prevent timing side-channel that leaks token count.
    # Do not short-circuit on match -- always hash and compare every entry.
    matched_token: Optional[dict] = None
    for token in tokens["tokens"].values():
        stored_salt = token.get("salt", "")
        token_hash, _ = _hash_token(raw_token, salt=stored_salt)
        if _constant_time_compare(token["hash"], token_hash):
            matched_token = token

    if matched_token is not None:
        # Check if revoked
        if matched_token.get("revoked"):
            return None

        # Check expiration
        if matched_token.get("expires_at"):
            expires = datetime.fromisoformat(matched_token["expires_at"])
            if datetime.now(timezone.utc) > expires:
                return None

        # Update last used
        matched_token["last_used"] = datetime.now(timezone.utc).isoformat()
        _save_tokens(tokens)

        return {
            "id": matched_token["id"],
            "name": matched_token["name"],
            "scopes": matched_token["scopes"],
        }

    return None


def has_scope(token_info: dict, required_scope: str) -> bool:
    """
    Check if a token has a required scope, respecting scope hierarchy.

    Hierarchy (higher scopes implicitly grant lower ones):
        * -> control -> write -> read
        * also grants audit, admin, and all other scopes

    Args:
        token_info: Token metadata from validate_token
        required_scope: The scope to check

    Returns:
        True if token has the scope (directly or via hierarchy)
    """
    scopes = token_info.get("scopes", [])

    # Direct match
    if required_scope in scopes:
        return True

    # Check hierarchy: does any held scope implicitly grant the required one?
    for scope in scopes:
        implied = _SCOPE_HIERARCHY.get(scope, set())
        if required_scope in implied:
            return True

    return False


# ---------------------------------------------------------------------------
# OIDC / SSO Support (optional - disabled by default)
# ---------------------------------------------------------------------------


def _get_oidc_config() -> dict:
    """Fetch OIDC discovery document from the issuer.

    Results are not cached here; callers should use _get_jwks() which
    handles caching internally.
    """
    if not OIDC_ISSUER:
        return {}
    url = f"{OIDC_ISSUER.rstrip('/')}/.well-known/openid-configuration"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception:
        return {}


def _get_jwks() -> dict:
    """Fetch and cache JWKS keys from the OIDC provider.

    Keys are cached for 1 hour (controlled by _OIDC_CACHE_TTL).
    """
    global _oidc_jwks_cache
    now = time.time()

    cached = _oidc_jwks_cache.get(OIDC_ISSUER)
    if cached:
        keys, fetched_at = cached
        if now - fetched_at < _OIDC_CACHE_TTL:
            return keys

    config = _get_oidc_config()
    jwks_uri = config.get("jwks_uri")
    if not jwks_uri:
        return {"keys": []}
    try:
        with urllib.request.urlopen(jwks_uri, timeout=10) as resp:
            keys = json.loads(resp.read())
            _oidc_jwks_cache[OIDC_ISSUER] = (keys, now)
            return keys
    except Exception:
        return {"keys": []}


def _base64url_decode(data: str) -> bytes:
    """Decode base64url-encoded data with padding correction."""
    padding = 4 - len(data) % 4
    if padding != 4:
        data += "=" * padding
    return base64.urlsafe_b64decode(data)


# Role precedence (highest privilege first). When a token carries multiple
# recognized role claims, the highest-privilege match wins.
_ROLE_PRECEDENCE = ("admin", "operator", "auditor", "viewer")


def _normalize_claim_values(value) -> set[str]:
    """Normalize an OIDC claim value into a lowercased set of strings.

    Claim values may be a single string, a space-separated string, or a
    list of strings (different providers use different shapes). All are
    flattened into a set of lowercased tokens for matching against ROLES.
    """
    out: set[str] = set()
    if value is None:
        return out
    if isinstance(value, str):
        for part in value.split():
            if part:
                out.add(part.strip().lower())
    elif isinstance(value, (list, tuple, set)):
        for item in value:
            if isinstance(item, str):
                s = item.strip().lower()
                if s:
                    out.add(s)
    return out


def _collect_role_claims(claims: dict) -> set[str]:
    """Collect candidate role/group values from standard OIDC claim shapes.

    Recognized sources (case-insensitive values flattened into one set):
    - A configurable claim named by LOKI_OIDC_ROLES_CLAIM (supports a dotted
      path for nested claims, e.g. "realm_access.roles" for Keycloak).
    - "roles" (generic)
    - "groups" (generic)
    - "realm_access.roles" (Keycloak)
    - "cognito:groups" (AWS Cognito)

    Note: "groups"/"cognito:groups" typically carry arbitrary group names,
    not Loki role names. Only values that exactly match one of the four
    built-in role names (admin/operator/viewer/auditor, case-insensitive)
    grant a role. Everything else is ignored and the default role applies.
    """
    candidates: set[str] = set()

    def _read_dotted(path: str):
        node = claims
        for key in path.split("."):
            if isinstance(node, dict) and key in node:
                node = node[key]
            else:
                return None
        return node

    configured = os.environ.get("LOKI_OIDC_ROLES_CLAIM", "").strip()
    sources = []
    if configured:
        sources.append(configured)
    sources.extend(["roles", "groups", "realm_access.roles", "cognito:groups"])

    for src in sources:
        if "." in src:
            val = _read_dotted(src)
        else:
            val = claims.get(src)
        candidates |= _normalize_claim_values(val)

    return candidates


def _default_oidc_role() -> str:
    """Return the configured default OIDC role, validated against ROLES.

    Defaults to the least-privileged role ("viewer"). If LOKI_OIDC_DEFAULT_ROLE
    is set to an unrecognized value, falls back to "viewer" (never admin).
    """
    configured = os.environ.get("LOKI_OIDC_DEFAULT_ROLE", "").strip().lower()
    if configured in ROLES:
        return configured
    return "viewer"


def _scopes_from_claims(claims: dict) -> tuple[list[str], str]:
    """Map OIDC token claims to Loki scopes via the existing ROLES mapping.

    Returns a tuple of (scopes, role_name). If no recognized role claim is
    present, the safe default role (viewer, or LOKI_OIDC_DEFAULT_ROLE) is
    applied. This function NEVER returns ["*"]/admin by default: full access
    is granted only when an explicit admin role claim is present.
    """
    candidate_values = _collect_role_claims(claims)

    matched_role = None
    for role in _ROLE_PRECEDENCE:
        if role in candidate_values:
            matched_role = role
            break

    if matched_role is None:
        matched_role = _default_oidc_role()

    return resolve_scopes(matched_role), matched_role


def validate_oidc_token(token_str: str) -> Optional[dict]:
    """Validate an OIDC JWT token.

    Returns decoded user info dict if valid, None if invalid.

    This is a claims-based validation that checks:
    - Token structure (3 base64url-encoded parts)
    - Signature part is not empty (basic sanity check)
    - Issuer matches OIDC_ISSUER
    - Audience matches OIDC_AUDIENCE or OIDC_CLIENT_ID
    - Token is not expired

    On success, role/group claims are mapped to Loki roles (admin/operator/
    viewer/auditor) via _scopes_from_claims. When no recognized role claim is
    present, the least-privileged default role (viewer, configurable via
    LOKI_OIDC_DEFAULT_ROLE) is applied. OIDC users are never granted ["*"]
    unless an explicit admin role claim is present.

    SECURITY CRITICAL: Without PyJWT, JWT signatures are NOT cryptographically
    verified. An attacker can forge tokens with arbitrary claims. For any
    production deployment, you MUST install PyJWT + cryptography so that
    this function verifies the RS256/RS384/RS512 signature against the
    provider's JWKS endpoint. Without signature verification, OIDC
    authentication provides ZERO security.

    For production: pip install PyJWT cryptography
    """
    if not OIDC_ENABLED:
        return None

    import logging as _logging
    import sys
    _auth_logger = _logging.getLogger("loki.auth")

    # -- Attempt PyJWT-based cryptographic verification first --
    # This is the ONLY secure path. Without this, tokens are NOT verified.
    try:
        import jwt as _pyjwt
        from jwt import PyJWKClient

        jwks_config = _get_oidc_config()
        jwks_uri = jwks_config.get("jwks_uri")
        if not jwks_uri:
            _auth_logger.error("OIDC discovery document missing jwks_uri -- cannot verify token")
            return None

        jwks_client = PyJWKClient(jwks_uri)
        signing_key = jwks_client.get_signing_key_from_jwt(token_str)

        expected_aud = OIDC_AUDIENCE or OIDC_CLIENT_ID
        decoded = _pyjwt.decode(
            token_str,
            signing_key.key,
            algorithms=["RS256", "RS384", "RS512"],
            audience=expected_aud,
            issuer=OIDC_ISSUER,
        )

        scopes, role = _scopes_from_claims(decoded)
        return {
            "id": decoded.get("sub", ""),
            "name": decoded.get("name", decoded.get("email", decoded.get("sub", ""))),
            "email": decoded.get("email", ""),
            "scopes": scopes,  # mapped from OIDC role/group claims
            "role": role,
            "auth_method": "oidc",
            "issuer": decoded.get("iss"),
        }
    except ImportError:
        # PyJWT not installed -- only allow claims-only path if explicitly opted in
        if not OIDC_SKIP_SIGNATURE_VERIFY:
            _auth_logger.error(
                "OIDC token rejected: PyJWT not installed and "
                "LOKI_OIDC_SKIP_SIGNATURE_VERIFY is not set. "
                "Install PyJWT: pip install PyJWT cryptography"
            )
            return None
        _auth_logger.warning(
            "PyJWT not installed -- using claims-only validation "
            "(LOKI_OIDC_SKIP_SIGNATURE_VERIFY=true). This is INSECURE."
        )
    except Exception as exc:
        _auth_logger.error("PyJWT signature verification failed: %s", exc)
        return None

    # -- Fallback: claims-only validation (INSECURE without PyJWT) --

    try:
        parts = token_str.split(".")
        if len(parts) != 3:
            return None

        # Basic sanity check: signature part must not be empty
        header_b64, payload_b64, signature_b64 = parts
        if not signature_b64 or len(signature_b64) < 10:
            _auth_logger.error(
                "OIDC token rejected: signature part is missing or too short"
            )
            return None

        # CRITICAL: Check if signature verification is explicitly skipped
        if not OIDC_SKIP_SIGNATURE_VERIFY:
            _auth_logger.critical(
                "OIDC token received but signature verification is NOT implemented. "
                "Set LOKI_OIDC_SKIP_SIGNATURE_VERIFY=true to explicitly allow "
                "unverified tokens (INSECURE - local testing only), or install "
                "PyJWT + cryptography for production signature verification. "
                "Rejecting token for security."
            )
            return None

        # Decode payload (claims)
        claims = json.loads(_base64url_decode(payload_b64))

        # Validate issuer
        if claims.get("iss") != OIDC_ISSUER:
            return None

        # Validate audience
        aud = claims.get("aud")
        expected_aud = OIDC_AUDIENCE or OIDC_CLIENT_ID
        if isinstance(aud, list):
            if expected_aud not in aud:
                return None
        elif aud != expected_aud:
            return None

        # Validate expiration
        exp = claims.get("exp")
        if exp and datetime.now(timezone.utc).timestamp() > exp:
            return None

        # Return user info from claims
        scopes, role = _scopes_from_claims(claims)
        return {
            "id": claims.get("sub", ""),
            "name": claims.get("name", claims.get("email", claims.get("sub", ""))),
            "email": claims.get("email", ""),
            "scopes": scopes,  # mapped from OIDC role/group claims
            "role": role,
            "auth_method": "oidc",
            "issuer": claims.get("iss"),
        }
    except Exception:
        return None


# FastAPI dependency for optional auth
async def get_current_token(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Security(security),
) -> Optional[dict]:
    """
    FastAPI dependency for optional token authentication.

    Supports two auth methods (tried in order):
    1. OIDC/SSO (when LOKI_OIDC_ISSUER + LOKI_OIDC_CLIENT_ID are set)
    2. Token auth (when LOKI_ENTERPRISE_AUTH=true)

    When neither is enabled:
        - Returns None (allows anonymous access)
    """
    if not ENTERPRISE_AUTH_ENABLED and not OIDC_ENABLED:
        # No auth configured - allow anonymous
        return None

    if not credentials:
        raise HTTPException(
            status_code=401,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token_str = credentials.credentials

    # Try OIDC first (JWTs are typically longer and don't start with loki_)
    if OIDC_ENABLED and not token_str.startswith("loki_"):
        oidc_result = validate_oidc_token(token_str)
        if oidc_result:
            return oidc_result

    # Fall back to token auth
    if ENTERPRISE_AUTH_ENABLED:
        token_info = validate_token(token_str)
        if token_info:
            return token_info

    raise HTTPException(
        status_code=401,
        detail="Invalid, expired, or revoked token",
        headers={"WWW-Authenticate": "Bearer"},
    )


def require_scope(scope: str):
    """
    Factory for scope-checking dependency.

    Usage:
        @app.get("/admin", dependencies=[Depends(require_scope("admin"))])
    """
    async def check_scope(token_info: Optional[dict] = Security(get_current_token)):
        if not ENTERPRISE_AUTH_ENABLED and not OIDC_ENABLED:
            return True  # Auth disabled - allow access with explicit truthy value

        if not token_info:
            raise HTTPException(status_code=401, detail="Authentication required")

        if not has_scope(token_info, scope):
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions. Required scope: {scope}"
            )

    return check_scope


def is_enterprise_mode() -> bool:
    """Check if enterprise mode is enabled (token auth or OIDC)."""
    return ENTERPRISE_AUTH_ENABLED


def is_oidc_mode() -> bool:
    """Check if OIDC/SSO authentication is enabled."""
    return OIDC_ENABLED
