"""Forge auth service.

Exposes:
    sign_token(claims, ttl_seconds, kid?) -> jwt_str
    verify_token(jwt_str) -> claims dict (raises on fail)
    add_provider(name, config) -> dict
    remove_provider(name) -> bool
    list_providers() -> List[dict]
    create_user(email, password=None, oauth_subject=None) -> dict
    list_users(filter=None) -> List[dict]
    revoke_session(user_id) -> int

Storage layout under <forge_dir>/auth/:
    keys/jwt.json              - active signing key + previous keys (rotation)
    providers/<name>.json      - per-provider config (NEVER secrets in clear)
    users.sqlite               - shared SQLite with sessions table

Sessions live in users.sqlite; user records in the forge primary db
(`forge_db`). Auth provisions the user table via the migration engine the
first time it is enabled so the agent does not have to.
"""

from __future__ import annotations

from .providers import (  # noqa: F401
    add_provider,
    list_providers,
    remove_provider,
    SUPPORTED_PROVIDERS,
)
from .sessions import (  # noqa: F401
    create_user,
    list_users,
    revoke_session,
    sign_token,
    verify_token,
    ensure_auth_schema,
)
